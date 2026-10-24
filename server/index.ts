import express, { type NextFunction, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { db, migrate } from "./db.js";
import { isMock, isProviderReady, listModels, PROVIDERS, type Provider } from "./providers.js";
import { addSeat, listFeedback, listSeats, rateAnswer, removeSeat, seedSeats, setChair, updateSeat } from "./seats.js";
import { addMemory, deleteMemory, listMemory, MEMORY_KINDS, updateMemory, type MemoryKind } from "./context.js";
import { runTurn, type TeamEvent, type TurnMode } from "./team.js";
import { editDraft, getDraft, listDrafts, setDraftStatus } from "./drafts.js";
import { mailAccount, mailConfigured, recentInbox, saveDraft, sendEmail } from "./mail.js";
import { calendarConfigured, upcomingEvents } from "./calendar.js";

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT ?? 5180);
const PASSWORD = process.env.SPHERE_PASSWORD ?? "";
const SECRET = process.env.SESSION_SECRET ?? "sphere-local-dev-secret";

if (PROD && (!PASSWORD || !process.env.SESSION_SECRET)) {
  console.error("SPHERE_PASSWORD and SESSION_SECRET must be set in production.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Single-user login: a signed cookie proves the password was entered.
const COOKIE = "sphere_session";
const sign = (value: string) => createHmac("sha256", SECRET).update(value).digest("hex");

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function isAuthed(req: Request) {
  if (!PASSWORD) return true;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [issued, mac] = token.split(".");
  if (!issued || !mac) return false;
  const expected = sign(issued);
  return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const given = String(req.body?.password ?? "");
  const ok =
    PASSWORD.length > 0 &&
    given.length === PASSWORD.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
  if (!ok) {
    res.status(401).json({ error: "Wrong password." });
    return;
  }
  const issued = Date.now().toString();
  const maxAge = 60 * 60 * 24 * 60; // 60 days
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${issued}.${sign(issued)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "login required" });
});

app.get("/api/state", async (_req, res) => {
  const [seats, memory, messages, feedback, drafts] = await Promise.all([
    listSeats(),
    listMemory(),
    db.query(
      `SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 300) t ORDER BY id`,
    ),
    listFeedback(),
    listDrafts(),
  ]);
  const connections = {
    mail: { configured: mailConfigured(), account: mailConfigured() ? mailAccount() : "" },
    calendar: { configured: calendarConfigured() },
  };
  res.json({ seats, memory, messages: messages.rows, feedback, drafts, connections, mock: isMock(), memoryKinds: MEMORY_KINDS, providers: PROVIDERS });
});

// One turn of conversation, streamed back as server-sent events.
app.post("/api/turn", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const modes: TurnMode[] = ["auto", "briefing", "roundtable", "pitch"];
  const mode: TurnMode = modes.includes(req.body?.mode) ? req.body.mode : "auto";
  if (!text) {
    res.status(400).json({ error: "Say something first." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (event: TeamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  try {
    await runTurn(text, emit, mode);
  } catch (err) {
    console.error("turn failed", err);
    emit({ type: "notice", text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` });
    emit({ type: "done" });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

app.get("/api/models/:provider", async (req, res) => {
  const provider = req.params.provider as Provider;
  if (!PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "Unknown provider." });
    return;
  }
  if (!isProviderReady(provider)) {
    res.json({ models: [], error: "No API key for this provider yet." });
    return;
  }
  try {
    res.json({ models: await listModels(provider) });
  } catch (err) {
    res.json({ models: [], error: err instanceof Error ? err.message : String(err) });
  }
});

// Thumbs up or down on one seat's answer in one turn; null clears it.
app.post("/api/feedback", async (req, res) => {
  const { turnId, seatId, verdict } = req.body ?? {};
  if (!turnId || !seatId || !["up", "down", null].includes(verdict)) {
    res.status(400).json({ error: "turnId, seatId and a verdict of up, down or null are required." });
    return;
  }
  await rateAnswer(String(turnId), String(seatId), verdict);
  res.json({ seats: await listSeats(), feedback: await listFeedback() });
});

// Reads the inbox and calendar once and reports what came back, so a wrong
// server name or password shows up here instead of mid-conversation.
app.get("/api/connections/test", async (_req, res) => {
  const result: Record<string, string> = {};
  if (mailConfigured()) {
    try {
      const inbox = await recentInbox();
      result.mail = `Connected: ${inbox.length} messages in the last 3 days.`;
    } catch (err) {
      result.mail = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else result.mail = "Not set up.";
  if (calendarConfigured()) {
    try {
      const events = await upcomingEvents();
      result.calendar = `Connected: ${events.length} events in the next 7 days.`;
    } catch (err) {
      result.calendar = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else result.calendar = "Not set up.";
  res.json(result);
});

// Email drafts the team proposed. Nothing is sent without Ricardo tapping Send.
app.put("/api/drafts/:id", async (req, res) => {
  const { to, subject, body } = req.body ?? {};
  await editDraft(Number(req.params.id), String(to ?? ""), String(subject ?? ""), String(body ?? ""));
  res.json({ drafts: await listDrafts() });
});

app.post("/api/drafts/:id/:action", async (req, res) => {
  const draft = await getDraft(Number(req.params.id));
  const action = req.params.action;
  if (!draft) {
    res.status(404).json({ error: "No such draft." });
    return;
  }
  if (action === "discard") {
    await setDraftStatus(draft.id, "discarded");
    res.json({ drafts: await listDrafts() });
    return;
  }
  if (action !== "save" && action !== "send") {
    res.status(400).json({ error: "Unknown action." });
    return;
  }
  if (!mailConfigured()) {
    res.status(400).json({ error: "Email isn't connected yet." });
    return;
  }
  if (draft.status === "sent" || draft.status === "discarded") {
    res.status(400).json({ error: `This draft was already ${draft.status}.` });
    return;
  }
  if (action === "send" && !/@/.test(draft.to_addr)) {
    res.status(400).json({ error: "Add a recipient address before sending." });
    return;
  }
  const email = { to: draft.to_addr, subject: draft.subject, body: draft.body, inReplyTo: draft.in_reply_to ?? undefined };
  try {
    if (action === "save") {
      const folder = await saveDraft(email);
      await setDraftStatus(draft.id, "saved");
      res.json({ drafts: await listDrafts(), message: `Saved to ${folder}.` });
    } else {
      await sendEmail(email);
      await setDraftStatus(draft.id, "sent");
      res.json({ drafts: await listDrafts(), message: `Sent to ${draft.to_addr}.` });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setDraftStatus(draft.id, draft.status, error);
    res.status(502).json({ error: `Couldn't ${action === "save" ? "save" : "send"} it: ${error}` });
  }
});

app.put("/api/seats/:id", async (req, res) => {
  const { name, title, model, role_card, enabled } = req.body ?? {};
  await updateSeat(req.params.id, { name, title, model, role_card, enabled });
  res.json({ seats: await listSeats() });
});

app.post("/api/seats/:id/chair", async (req, res) => {
  await setChair(req.params.id);
  res.json({ seats: await listSeats() });
});

app.post("/api/seats", async (req, res) => {
  const { name, title, provider, model, role_card } = req.body ?? {};
  if (!name || !title || !model || !role_card || !PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "Name, title, provider, model and role card are all required." });
    return;
  }
  const id = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const existing = await listSeats();
  if (!id || existing.some((s) => s.id === id)) {
    res.status(400).json({ error: "A seat with that name already exists." });
    return;
  }
  await addSeat({ id, name, title, provider: provider as Provider, model, role_card });
  res.json({ seats: await listSeats() });
});

app.delete("/api/seats/:id", async (req, res) => {
  try {
    await removeSeat(req.params.id);
    res.json({ seats: await listSeats() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const validKind = (k: unknown): k is MemoryKind => MEMORY_KINDS.includes(k as MemoryKind);

app.post("/api/memory", async (req, res) => {
  const { kind, content } = req.body ?? {};
  if (!validKind(kind) || !String(content ?? "").trim()) {
    res.status(400).json({ error: "Pick a kind and write something." });
    return;
  }
  await addMemory(kind, String(content), "added by Ricardo");
  res.json({ memory: await listMemory() });
});

app.put("/api/memory/:id", async (req, res) => {
  const { kind, content } = req.body ?? {};
  if (!validKind(kind) || !String(content ?? "").trim()) {
    res.status(400).json({ error: "Pick a kind and write something." });
    return;
  }
  await updateMemory(Number(req.params.id), kind, String(content));
  res.json({ memory: await listMemory() });
});

app.delete("/api/memory/:id", async (req, res) => {
  await deleteMemory(Number(req.params.id));
  res.json({ memory: await listMemory() });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
});

async function main() {
  await migrate();
  await seedSeats();

  if (PROD) {
    const dir = path.resolve("dist/public");
    app.use(express.static(dir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dir, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  app.listen(PORT, () => {
    console.log(`Sphere running on http://localhost:${PORT}${isMock() ? " (mock replies)" : ""}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
