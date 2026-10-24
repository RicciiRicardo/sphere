import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "./db.js";
import { anthropicClient, complete, isMock, isProviderReady } from "./providers.js";
import { listSeats, setChair, trackRecords, type SeatView, type TrackRecord } from "./seats.js";
import {
  COORDINATOR_MODEL,
  extractMemory,
  formatMemory,
  formatTranscript,
  memorySlice,
  recentTranscript,
  type MemoryItem,
} from "./context.js";

export type TeamEvent =
  | { type: "turn"; turnId: string }
  | { type: "routing"; seats: string[]; reason: string; direct: boolean; mode?: TurnMode }
  | { type: "round"; round: number; label: string }
  | ({ type: "bid" } & Bid)
  | { type: "winner"; seatId: string; text: string }
  | { type: "thinking"; seatId: string }
  | { type: "seat"; seatId: string; text: string; round?: number }
  | { type: "seat_error"; seatId: string; error: string }
  | { type: "final"; seatId: string; text: string }
  | { type: "notice"; text: string }
  | { type: "memory"; added: MemoryItem[] }
  | { type: "done" };

type Emit = (event: TeamEvent) => void;

async function record(turnId: string, speaker: string, kind: string, content: string) {
  await db.query("INSERT INTO messages (turn_id, speaker, kind, content) VALUES ($1, $2, $3, $4)", [
    turnId,
    speaker,
    kind,
    content,
  ]);
}

const aliases = (s: SeatView) => [s.name, s.title, s.id].map((a) => a.toLowerCase());

// "Muse, take the chair" / "make Muse the chair"
function chairCommand(text: string, seats: SeatView[]): SeatView | undefined {
  const m =
    text.match(/^(?:hey\s+)?([\w .-]+?)[,:]?\s+(?:please\s+)?take the chair/i) ??
    text.match(/\bmake\s+([\w .-]+?)\s+(?:the\s+)?chair\b/i);
  if (!m) return undefined;
  const who = m[1].trim().toLowerCase();
  return seats.find((s) => aliases(s).includes(who));
}

// "ChatGPT, poke holes in that" / "Grok and Perplexity: what's new?"
function directlyAddressed(text: string, seats: SeatView[]): SeatView[] {
  const lead = text.match(/^(?:hey\s+)?([^,:?!.]{1,60})[,:]/i)?.[1]?.toLowerCase();
  if (!lead || /\bteam\b/.test(lead)) return [];
  const names = lead.split(/\s*(?:,|\band\b|&)\s*/).map((n) => n.trim());
  return seats.filter((s) => names.some((n) => aliases(s).includes(n)));
}

const isBriefingRequest = (text: string) => /^(?:good\s+)?morning\b/i.test(text.trim());

const Routing = z.object({
  seats: z.array(z.string()),
  reason: z.string(),
});

// The coordinator picks which seats should work on a message. It never talks
// to Ricardo; the chair always has the last word.
async function route(text: string, seats: SeatView[], transcript: string): Promise<{ seats: string[]; reason: string }> {
  const candidates = seats.filter((s) => !s.is_chair && s.enabled);
  if (!isMock() && isProviderReady("anthropic")) {
    try {
      const roster = candidates.map((s) => `- ${s.id}: ${s.name}, ${s.title}. ${s.role_card}`).join("\n");
      const response = await anthropicClient().messages.parse({
        model: COORDINATOR_MODEL,
        max_tokens: 2000,
        output_config: { format: zodOutputFormat(Routing), effort: "low" },
        system:
          "You route messages on Ricardo's AI team. The chair always answers; you decide which OTHER seats should contribute first. Pick only seats whose role clearly adds something: usually zero to two. Small talk, simple questions and follow-ups the chair can handle need none. Facts, prices, companies or regulations need the researcher. Anything happening right now needs the pulse seat. Requests for ideas, critique or a second opinion need the generalist or the Muse seat. Long documents, reports, spreadsheets or detailed analysis need the analyst. Return seat ids from the roster only, and a reason of at most 15 words.",
        messages: [
          {
            role: "user",
            content: `ROSTER\n${roster}\n\nRECENT CONVERSATION\n${transcript.slice(-4000)}\n\nNEW MESSAGE FROM RICARDO\n${text}`,
          },
        ],
      });
      const out = response.parsed_output;
      if (out) {
        const valid = out.seats.filter((id) => candidates.some((s) => s.id === id));
        return { seats: valid.slice(0, 3), reason: out.reason };
      }
    } catch (err) {
      console.error("coordinator failed, using keyword routing", err);
    }
  }
  return keywordRoute(text, candidates);
}

function keywordRoute(text: string, candidates: SeatView[]) {
  const t = text.toLowerCase();
  const picks: string[] = [];
  const has = (id: string) => candidates.some((s) => s.id === id);
  if (/\b(research|look up|find|price|cost|tariff|duty|regulation|company|companies|market|data|source)/.test(t) && has("perplexity"))
    picks.push("perplexity");
  if (/\b(news|today|right now|trending|people saying|on x|twitter|latest)\b/.test(t) && has("grok")) picks.push("grok");
  if (/\b(idea|ideas|brainstorm|poke holes|critique|second opinion|challenge)\b/.test(t) && has("chatgpt"))
    picks.push("chatgpt");
  if (/\b(plan|priorit|strategy)/.test(t) && has("muse")) picks.push("muse");
  if (/\b(document|report|spreadsheet|contract|analy[sz]|summari[sz]e|numbers)/.test(t) && has("gemini")) picks.push("gemini");
  return { seats: picks.slice(0, 3), reason: picks.length ? "Matched by topic keywords." : "The chair can handle this alone." };
}

function teamSystem(seat: SeatView, seats: SeatView[], memory: string, duty?: string) {
  const chair = seats.find((s) => s.is_chair);
  const roster = seats
    .filter((s) => s.enabled)
    .map((s) => `- ${s.name}: ${s.title}${s.is_chair ? " (chairs the team)" : ""}`)
    .join("\n");
  const job =
    duty ??
    (seat.is_chair
      ? "You chair the team: you give Ricardo the team's single reply."
      : `${chair?.name ?? "The chair"} will merge everyone's answers, so contribute your part rather than a full report.`);
  return `You are ${seat.name}, the ${seat.title} on Ricardo Berris's AI team inside Sphere, an app where several AI models from different companies work as one team from one shared context. Ricardo runs Go Global and MI Group; the team's purpose is to help him grow his businesses, and it works proactively: propose, draft and plan, and Ricardo approves before anything goes out.

YOUR ROLE
${seat.role_card}

THE TEAM
${roster}

${job} Write plain prose that reads well aloud: no tables, no headings, short paragraphs. Keep it under about 200 words unless the task needs more. If you disagree with a teammate, say so plainly.

SHARED TEAM MEMORY
${memory}`;
}

export type TurnMode = "auto" | "briefing" | "roundtable" | "pitch";

const isRoundtableRequest = (text: string) => /\b(debate|roundtable|round table)\b/i.test(text);
const isPitchRequest = (text: string) => /\b(who wants (this|it)|pitch (for|me|it)|bid (on|for))\b/i.test(text);

interface TurnContext {
  turnId: string;
  text: string;
  seats: SeatView[];
  memory: string;
  prompt: string;
  emit: Emit;
}

// One seat answers one prompt. Records and emits the result; returns the text,
// or undefined when the seat isn't connected or the call fails.
async function askSeat(
  ctx: TurnContext,
  seat: SeatView,
  system: string,
  prompt: string,
  kind: "seat" | "rebuttal" | "bid" = "seat",
): Promise<string | undefined> {
  const { turnId, emit } = ctx;
  if (!seat.ready) {
    emit({ type: "seat_error", seatId: seat.id, error: `${seat.name} isn't connected yet (no API key).` });
    return undefined;
  }
  emit({ type: "thinking", seatId: seat.id });
  try {
    const reply = await complete({ provider: seat.provider, model: seat.model, system, prompt, speaker: seat.name });
    if (kind !== "bid") {
      await record(turnId, seat.id, kind, reply);
      emit({ type: "seat", seatId: seat.id, text: reply, round: kind === "rebuttal" ? 2 : undefined });
    }
    return reply;
  } catch (err) {
    let error = err instanceof Error ? err.message : String(err);
    if ((err as { status?: number }).status === 404) error += " Pick a model from the list in this seat's settings.";
    console.error(`${seat.name} failed`, err);
    await record(turnId, seat.id, "error", error);
    emit({ type: "seat_error", seatId: seat.id, error: `${seat.name} couldn't answer: ${error}` });
    return undefined;
  }
}

// The chair has the last word: it merges, summarizes or briefs.
async function chairCloses(ctx: TurnContext, instruction: string): Promise<string> {
  const chair = ctx.seats.find((s) => s.is_chair);
  if (!chair || !chair.ready) {
    ctx.emit({
      type: "notice",
      text: chair
        ? `${chair.name} chairs the team but isn't connected yet, so there's no closing reply.`
        : "No seat is set as chair, so there's no closing reply.",
    });
    return "";
  }
  ctx.emit({ type: "thinking", seatId: chair.id });
  try {
    const text = await complete({
      provider: chair.provider,
      model: chair.model,
      system: teamSystem(chair, ctx.seats, ctx.memory),
      prompt: `${ctx.prompt}\n\n${instruction}`,
      speaker: chair.name,
    });
    await record(ctx.turnId, chair.id, "briefing", text);
    ctx.emit({ type: "final", seatId: chair.id, text });
    return text;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`${chair.name} (chair) failed`, err);
    await record(ctx.turnId, chair.id, "error", error);
    ctx.emit({ type: "seat_error", seatId: chair.id, error: `${chair.name} couldn't close: ${error}` });
    return "";
  }
}

export async function runTurn(text: string, emit: Emit, requested: TurnMode = "auto") {
  const turnId = randomUUID();
  emit({ type: "turn", turnId });
  await record(turnId, "you", "user", text);

  const seats = await listSeats();

  const newChair = chairCommand(text, seats);
  if (newChair) {
    await setChair(newChair.id);
    const msg = `${newChair.name} now chairs the team.`;
    await record(turnId, "system", "notice", msg);
    emit({ type: "notice", text: msg });
    emit({ type: "done" });
    return;
  }

  const names = Object.fromEntries(seats.map((s) => [s.id, s.name]));
  const transcript = formatTranscript((await recentTranscript()).slice(0, -1), names);
  const memory = formatMemory(await memorySlice(text));
  const prompt = `CONVERSATION SO FAR\n${transcript}\n\nRICARDO NOW SAYS\n${text}`;
  const ctx: TurnContext = { turnId, text, seats, memory, prompt, emit };

  const mode: TurnMode =
    requested !== "auto"
      ? requested
      : isBriefingRequest(text)
        ? "briefing"
        : isRoundtableRequest(text)
          ? "roundtable"
          : isPitchRequest(text)
            ? "pitch"
            : "auto";

  let finalText = "";
  if (mode === "roundtable") finalText = await runRoundtable(ctx);
  else if (mode === "pitch") finalText = await runPitch(ctx);
  else finalText = await runRouted(ctx, mode === "briefing", transcript);

  if (finalText) {
    try {
      const added = await extractMemory(text, finalText, `conversation, ${new Date().toISOString().slice(0, 10)}`);
      if (added.length) emit({ type: "memory", added });
    } catch (err) {
      console.error("memory extraction failed", err);
    }
  }
  emit({ type: "done" });
}

async function announce(ctx: TurnContext, routing: { seats: string[]; reason: string; direct: boolean; mode: TurnMode }) {
  ctx.emit({ type: "routing", ...routing });
  await record(ctx.turnId, "coordinator", "routing", JSON.stringify(routing));
}

// Default mode: the coordinator picks seats, they answer, the chair merges.
async function runRouted(ctx: TurnContext, briefing: boolean, transcript: string): Promise<string> {
  const { seats, text } = ctx;
  const addressed = briefing ? [] : directlyAddressed(text, seats);
  const direct = addressed.length > 0;

  let routed: string[];
  let reason: string;
  if (briefing) {
    routed = [];
    reason = "Morning briefing from the chair.";
  } else if (direct) {
    routed = addressed.map((s) => s.id);
    reason = `You addressed ${addressed.map((s) => s.name).join(" and ")} directly.`;
  } else {
    ({ seats: routed, reason } = await route(text, seats, transcript));
  }
  await announce(ctx, { seats: routed, reason, direct, mode: briefing ? "briefing" : "auto" });

  const workers = routed.map((id) => seats.find((s) => s.id === id)!).filter((s) => s && !s.is_chair);
  const soloDirect = direct && workers.length === 1 && !addressed.some((s) => s.is_chair);
  const answers: { seat: SeatView; text: string }[] = [];
  await Promise.all(
    workers.map(async (seat) => {
      const duty = soloDirect ? "Ricardo addressed you directly, so answer him yourself, in full." : undefined;
      const reply = await askSeat(ctx, seat, teamSystem(seat, seats, ctx.memory, duty), ctx.prompt);
      if (reply !== undefined) answers.push({ seat, text: reply });
    }),
  );

  if (soloDirect) {
    // One seat was spoken to by name: its own answer is the reply.
    const a = answers[0];
    if (!a) return "";
    ctx.emit({ type: "final", seatId: a.seat.id, text: a.text });
    return a.text;
  }
  if (briefing) {
    return chairCloses(
      ctx,
      "Ricardo is starting his day. Give his morning briefing from the shared team memory: his top three priorities, open commitments with their dates, one risk to watch, and what you suggest he does first. If the memory is too thin for a real briefing, say so and ask what's on his plate today.",
    );
  }
  if (!answers.length) return chairCloses(ctx, "Answer Ricardo directly.");
  return chairCloses(
    ctx,
    "YOUR TEAMMATES ANSWERED\n" +
      answers.map((a) => `${a.seat.name} (${a.seat.title}):\n${a.text}`).join("\n\n") +
      "\n\nGive Ricardo the team's one reply. Lead with the answer or recommendation. Credit a teammate by name when you use their point, keep any sources they cited, say where the team disagrees, and end with next steps when there are any.",
  );
}

// Roundtable: every seat gives an opening view, then responds to the others;
// the chair closes with where the team agrees, where it splits, and a call.
async function runRoundtable(ctx: TurnContext): Promise<string> {
  const debaters = ctx.seats.filter((s) => s.enabled && s.ready && !s.is_chair);
  await announce(ctx, {
    seats: debaters.map((s) => s.id),
    reason: "Roundtable: every seat weighs in, then responds to the others.",
    direct: false,
    mode: "roundtable",
  });
  if (debaters.length < 2) {
    ctx.emit({ type: "notice", text: "A roundtable needs at least two connected seats besides the chair." });
    return chairCloses(ctx, "Answer Ricardo directly.");
  }

  ctx.emit({ type: "round", round: 1, label: "Opening views" });
  const openings: { seat: SeatView; text: string }[] = [];
  await Promise.all(
    debaters.map(async (seat) => {
      const duty =
        "This is a roundtable debate. Give your opening view on Ricardo's question in at most 120 words: take a clear position from your role's angle. You'll hear the others next.";
      const reply = await askSeat(ctx, seat, teamSystem(seat, ctx.seats, ctx.memory, duty), ctx.prompt);
      if (reply !== undefined) openings.push({ seat, text: reply });
    }),
  );
  if (openings.length < 2) return chairCloses(ctx, "The roundtable fell through; answer Ricardo directly.");

  const table = openings.map((o) => `${o.seat.name} (${o.seat.title}):\n${o.text}`).join("\n\n");
  ctx.emit({ type: "round", round: 2, label: "Responses" });
  const rebuttals: { seat: SeatView; text: string }[] = [];
  await Promise.all(
    openings.map(async ({ seat }) => {
      const duty =
        "This is round two of a roundtable. Respond to your teammates' opening views in at most 100 words. Name who you're answering. Agree where they're right, object where they're wrong and say why, counter with a better option, or build on an idea. Don't repeat your opening.";
      const reply = await askSeat(
        ctx,
        seat,
        teamSystem(seat, ctx.seats, ctx.memory, duty),
        `${ctx.prompt}\n\nOPENING VIEWS\n${table}`,
        "rebuttal",
      );
      if (reply !== undefined) rebuttals.push({ seat, text: reply });
    }),
  );

  return chairCloses(
    ctx,
    `OPENING VIEWS\n${table}\n\nRESPONSES\n` +
      rebuttals.map((r) => `${r.seat.name}:\n${r.text}`).join("\n\n") +
      "\n\nYou moderated this roundtable. Close it for Ricardo: where the team agrees, where it splits and who stands where, then your recommendation and why. Be fair to the side you rule against.",
  );
}

interface Bid {
  seatId: string;
  plan: string;
  why: string;
  confidence: number;
  record: number;
  rated: number;
  score: number;
}

function parseBid(seatId: string, text: string, track: TrackRecord): Bid {
  const grab = (label: string) =>
    text.match(new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:PLAN|WHY ME|CONFIDENCE)\\s*:|$)`, "i"))?.[1]?.trim() ?? "";
  const confidence = Math.max(0, Math.min(100, Number(grab("CONFIDENCE").match(/\d+/)?.[0] ?? 50)));
  const { rate, rated } = track[seatId] ?? { rate: 0.5, rated: 0 };
  // Self-reported confidence counts, but a proven track record counts as much.
  const score = Math.round((confidence / 100) * (0.5 + rate) * 100) / 100;
  return { seatId, plan: grab("PLAN") || text.trim(), why: grab("WHY ME"), confidence, record: rate, rated, score };
}

// Pitch: every seat bids for the task; the best bid, weighed against each
// seat's track record, wins and does the work.
async function runPitch(ctx: TurnContext): Promise<string> {
  const bidders = ctx.seats.filter((s) => s.enabled && s.ready);
  await announce(ctx, {
    seats: bidders.map((s) => s.id),
    reason: "Pitch: every seat bids for the task; the best bid, weighed by track record, wins.",
    direct: false,
    mode: "pitch",
  });
  const track = await trackRecords();
  const bids: Bid[] = [];
  await Promise.all(
    bidders.map(async (seat) => {
      const duty =
        "Ricardo is handing out a task and the seats are pitching for it. Don't do the task yet. Reply in exactly this format:\nPLAN: how you'd do it, in at most 50 words\nWHY ME: why your role and strengths fit, in at most 30 words\nCONFIDENCE: a number from 0 to 100 for how well you'd do it. Be honest: a low number when another seat fits better is the right answer.";
      const reply = await askSeat(ctx, seat, teamSystem(seat, ctx.seats, ctx.memory, duty), ctx.prompt, "bid");
      if (reply === undefined) return;
      const bid = parseBid(seat.id, reply, track);
      bids.push(bid);
      await record(ctx.turnId, seat.id, "bid", JSON.stringify(bid));
      ctx.emit({ type: "bid", ...bid });
    }),
  );
  if (!bids.length) return chairCloses(ctx, "No seat could bid; answer Ricardo directly.");

  const best = [...bids].sort((a, b) => b.score - a.score || b.confidence - a.confidence)[0];
  const winner = ctx.seats.find((s) => s.id === best.seatId)!;
  const note = `${winner.name} wins the work: confidence ${best.confidence}, track record ${Math.round(best.record * 100)}% across ${best.rated} rated answers.`;
  await record(ctx.turnId, "coordinator", "winner", JSON.stringify({ seatId: winner.id, note }));
  ctx.emit({ type: "winner", seatId: winner.id, text: note });

  ctx.emit({ type: "thinking", seatId: winner.id });
  try {
    const text = await complete({
      provider: winner.provider,
      model: winner.model,
      system: teamSystem(
        winner,
        ctx.seats,
        ctx.memory,
        `You won the pitch for this task with this plan: ${best.plan}\nNow do the task for Ricardo, in full.`,
      ),
      prompt: ctx.prompt,
      speaker: winner.name,
    });
    await record(ctx.turnId, winner.id, "briefing", text);
    ctx.emit({ type: "final", seatId: winner.id, text });
    return text;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await record(ctx.turnId, winner.id, "error", error);
    ctx.emit({ type: "seat_error", seatId: winner.id, error: `${winner.name} couldn't do the task: ${error}` });
    return "";
  }
}
