import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "./db.js";
import { anthropicClient, complete, isMock, isProviderReady } from "./providers.js";
import { listSeats, setChair, type SeatView } from "./seats.js";
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
  | { type: "routing"; seats: string[]; reason: string; direct: boolean }
  | { type: "thinking"; seatId: string }
  | { type: "seat"; seatId: string; text: string }
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

function teamSystem(seat: SeatView, seats: SeatView[], memory: string, direct: boolean) {
  const chair = seats.find((s) => s.is_chair);
  const roster = seats
    .filter((s) => s.enabled)
    .map((s) => `- ${s.name}: ${s.title}${s.is_chair ? " (chairs the team)" : ""}`)
    .join("\n");
  const duty = seat.is_chair
    ? "You chair the team: you give Ricardo the team's single reply."
    : direct
      ? "Ricardo addressed you directly, so answer him yourself, in full."
      : `${chair?.name ?? "The chair"} will merge everyone's answers, so contribute your part rather than a full report.`;
  return `You are ${seat.name}, the ${seat.title} on Ricardo Berris's AI team inside Sphere, an app where several AI models from different companies work as one team from one shared context. Ricardo runs Go Global and MI Group; the team's purpose is to help him grow his businesses, and it works proactively: propose, draft and plan, and Ricardo approves before anything goes out.

YOUR ROLE
${seat.role_card}

THE TEAM
${roster}

${duty} Write plain prose that reads well aloud: no tables, no headings, short paragraphs. Keep it under about 200 words unless the task needs more. If you disagree with a teammate, say so plainly.

SHARED TEAM MEMORY
${memory}`;
}

export async function runTurn(text: string, emit: Emit, mode: "auto" | "briefing" = "auto") {
  const turnId = randomUUID();
  emit({ type: "turn", turnId });
  await record(turnId, "you", "user", text);

  let seats = await listSeats();

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
  const chair = seats.find((s) => s.is_chair);

  const briefing = mode === "briefing" || isBriefingRequest(text);
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
  emit({ type: "routing", seats: routed, reason, direct });
  await record(turnId, "coordinator", "routing", JSON.stringify({ seats: routed, reason, direct }));

  const prompt = `CONVERSATION SO FAR\n${transcript}\n\nRICARDO NOW SAYS\n${text}`;

  // Seats other than the chair answer first, in parallel.
  const workers = routed.map((id) => seats.find((s) => s.id === id)!).filter((s) => s && !s.is_chair);
  const answers: { seat: SeatView; text: string }[] = [];
  await Promise.all(
    workers.map(async (seat) => {
      if (!seat.ready) {
        emit({ type: "seat_error", seatId: seat.id, error: `${seat.name} isn't connected yet (no API key).` });
        return;
      }
      emit({ type: "thinking", seatId: seat.id });
      try {
        const reply = await complete({
          provider: seat.provider,
          model: seat.model,
          system: teamSystem(seat, seats, memory, direct && workers.length === 1),
          prompt,
          speaker: seat.name,
        });
        answers.push({ seat, text: reply });
        await record(turnId, seat.id, "seat", reply);
        emit({ type: "seat", seatId: seat.id, text: reply });
      } catch (err) {
        let error = err instanceof Error ? err.message : String(err);
        if ((err as { status?: number }).status === 404) error += " Pick a model from the list in this seat's settings.";
        console.error(`${seat.name} failed`, err);
        await record(turnId, seat.id, "error", error);
        emit({ type: "seat_error", seatId: seat.id, error: `${seat.name} couldn't answer: ${error}` });
      }
    }),
  );

  let finalText = "";
  const chairAddressed = addressed.some((s) => s.is_chair);
  if (direct && !chairAddressed && workers.length === 1) {
    // One seat was spoken to by name: its own answer is the reply.
    finalText = answers[0]?.text ?? "";
    if (answers[0]) emit({ type: "final", seatId: answers[0].seat.id, text: finalText });
  } else if (!chair || !chair.ready) {
    emit({
      type: "notice",
      text: chair
        ? `${chair.name} chairs the team but isn't connected yet, so there's no merged reply.`
        : "No seat is set as chair, so there's no merged reply.",
    });
    finalText = answers.map((a) => `${a.seat.name}: ${a.text}`).join("\n\n");
  } else {
    emit({ type: "thinking", seatId: chair.id });
    let chairPrompt = prompt;
    if (briefing) {
      chairPrompt += `\n\nRicardo is starting his day. Give his morning briefing from the shared team memory: his top three priorities, open commitments with their dates, one risk to watch, and what you suggest he does first. If the memory is too thin for a real briefing, say so and ask what's on his plate today.`;
    } else if (answers.length) {
      chairPrompt +=
        "\n\nYOUR TEAMMATES ANSWERED\n" +
        answers.map((a) => `${a.seat.name} (${a.seat.title}):\n${a.text}`).join("\n\n") +
        "\n\nGive Ricardo the team's one reply. Lead with the answer or recommendation. Credit a teammate by name when you use their point, keep any sources they cited, say where the team disagrees, and end with next steps when there are any.";
    }
    try {
      finalText = await complete({
        provider: chair.provider,
        model: chair.model,
        system: teamSystem(chair, seats, memory, false),
        prompt: chairPrompt,
        speaker: chair.name,
      });
      await record(turnId, chair.id, "briefing", finalText);
      emit({ type: "final", seatId: chair.id, text: finalText });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`${chair.name} (chair) failed`, err);
      await record(turnId, chair.id, "error", error);
      emit({ type: "seat_error", seatId: chair.id, error: `${chair.name} couldn't merge the answers: ${error}` });
    }
  }

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
