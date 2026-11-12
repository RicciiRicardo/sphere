import express, { type NextFunction, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { db, migrate } from "./db.js";
import { isMock, isProviderReady, listModels, PROVIDERS, type Provider } from "./providers.js";
import { addSeat, listFeedback, listSeats, loadModelSwaps, rateAnswer, removeSeat, seedSeats, setChair, updateSeat } from "./seats.js";
import { disconnectAllApps, disconnectApp, listConnectedApps, mountConnector } from "./connector.js";
import { addChats, finishImport, IMPORT_SOURCES, listImports, processImports, startImport, type ImportSource } from "./imports.js";
import { addMemory, backfillPrivate, deleteMemory, setMemoryPrivate, listMemory, MEMORY_KINDS, updateMemory, type MemoryKind } from "./context.js";
import { runTurn, type Interruption, type TeamEvent, type TurnMode } from "./team.js";
import { editDraft, getDraft, listDrafts, setDraftStatus } from "./drafts.js";
import { mailAccount, mailConfigured, recentInbox, saveDraft, sendEmail } from "./mail.js";
import { cleanUpSender } from "./review.js";
import { calendarConfigured, upcomingEvents } from "./calendar.js";
import { engineInfo } from "./engine.js";
import { speech, ttsAvailable, ttsInfo } from "./tts.js";
import { sttAvailable, transcribe } from "./stt.js";
import { emailEnabled, getSetting, recentEmailAccess, setSetting } from "./settings.js";

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT ?? 5180);
const PASSWORD = process.env.SPHERE_PASSWORD ?? "";
const SECRET = process.env.SESSION_SECRET ?? "sphere-local-dev-secret";

if (PROD && (!PASSWORD || !process.env.SESSION_SECRET)) {
  console.error("SPHERE_PASSWORD and SESSION_SECRET must be set in production.");
  process.exit(1);
}

const app = express();
// Chat-history uploads come in larger batches and have their own limit.
const smallJson = express.json({ limit: "1mb" });
app.use((req, res, next) => (/^\/api\/imports\/\d+\/chats$/.test(req.path) ? next() : smallJson(req, res, next)));

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

// Sessions end after a stretch without activity, and in any case some hours
// after login, so Sphere asks for the password again. The cookie carries when
// the session started and when it was last used, signed together.
const IDLE_MS = Math.max(5, Number(process.env.SPHERE_IDLE_MINUTES) || 30) * 60_000;
const MAX_MS = Math.max(1, Number(process.env.SPHERE_SESSION_HOURS) || 12) * 3_600_000;
// "Sign out everywhere" ends every session that started before this moment.
let sessionEpoch = 0;

type Session = { ok: true; issued: number; last: number } | { ok: false; reason: "none" | "idle" | "expired" };

function readSession(req: Request): Session {
  const token = readCookie(req, COOKIE);
  if (!token) return { ok: false, reason: "none" };
  const [issued, last, mac] = token.split(".");
  if (!issued || !last || !mac) return { ok: false, reason: "none" };
  const expected = sign(`${issued}.${last}`);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return { ok: false, reason: "none" };
  const now = Date.now();
  if (Number(issued) <= sessionEpoch) return { ok: false, reason: "none" };
  if (now - Number(issued) > MAX_MS) return { ok: false, reason: "expired" };
  if (now - Number(last) > IDLE_MS) return { ok: false, reason: "idle" };
  return { ok: true, issued: Number(issued), last: Number(last) };
}

function setSession(res: Response, issued: number) {
  const last = Date.now();
  const maxAge = Math.max(0, Math.floor((issued + MAX_MS - last) / 1000));
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${issued}.${last}.${sign(`${issued}.${last}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PROD ? "; Secure" : ""}`,
  );
}

function clearSession(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? "; Secure" : ""}`);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const checkPassword = (given: string) =>
  PASSWORD.length > 0 && given.length === PASSWORD.length && timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));

// Sphere as a connector inside ChatGPT and Claude, with its own sign-in.
mountConnector(app, {
  signedIn: (req) => !PASSWORD || readSession(req).ok,
  checkPassword: (given) => !PASSWORD || checkPassword(given),
});

app.post("/api/login", (req, res) => {
  if (!checkPassword(String(req.body?.password ?? ""))) {
    res.status(401).json({ error: "Wrong password." });
    return;
  }
  setSession(res, Date.now());
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// Every request is activity: it keeps the session alive, refreshing the
// cookie at most once a minute.
app.use("/api", (req, res, next) => {
  if (!PASSWORD) return next();
  const session = readSession(req);
  if (!session.ok) {
    if (session.reason !== "none") clearSession(res);
    res.status(401).json({ error: "login required", reason: session.reason });
    return;
  }
  if (Date.now() - session.last > 60_000) setSession(res, session.issued);
  next();
});

// The app calls this while Ricardo is active without otherwise talking to the server.
app.get("/api/session", (_req, res) => {
  res.json({ ok: true, idleMinutes: IDLE_MS / 60_000 });
});

app.post("/api/logout-all", async (_req, res) => {
  sessionEpoch = Date.now();
  await setSetting("session_epoch", String(sessionEpoch));
  await disconnectAllApps();
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/state", async (_req, res) => {
  const [seats, memory, messages, feedback, drafts, emailOn, emailLog] = await Promise.all([
    listSeats(),
    listMemory(),
    db.query(
      `SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 300) t ORDER BY id`,
    ),
    listFeedback(),
    listDrafts(),
    emailEnabled(),
    recentEmailAccess(),
  ]);
  const connections = {
    mail: { configured: mailConfigured(), account: mailConfigured() ? mailAccount() : "", enabled: emailOn },
    calendar: { configured: calendarConfigured() },
    engine: engineInfo(),
    voice: { ...ttsInfo(), transcribe: sttAvailable() },
  };
  res.json({
    seats,
    memory,
    messages: messages.rows,
    feedback,
    drafts,
    connections,
    emailLog,
    mock: isMock(),
    memoryKinds: MEMORY_KINDS,
    providers: PROVIDERS,
    session: { idleMinutes: PASSWORD ? IDLE_MS / 60_000 : 0 },
  });
});

// One reply read aloud in its seat's voice. The browser falls back to its own
// speech when this isn't available or fails.
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const seatId = String(req.body?.seatId ?? "");
  if (!ttsAvailable()) {
    res.status(503).json({ error: "Natural voices aren't set up." });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Nothing to say." });
    return;
  }
  try {
    const audio = await speech(text, seatId);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (err) {
    console.error("speech failed", err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// What Ricardo said, as text. The browser records with echo cancellation and
// sends the audio as is (webm from Chrome, mp4 from Safari).
app.post("/api/transcribe", express.raw({ type: "audio/*", limit: "25mb" }), async (req, res) => {
  if (!sttAvailable()) {
    res.status(503).json({ error: "Transcription isn't set up." });
    return;
  }
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length < 1000) {
    res.json({ text: "" });
    return;
  }
  try {
    res.json({ text: await transcribe(audio, String(req.headers["content-type"] ?? "audio/webm")) });
  } catch (err) {
    console.error("transcription failed", err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  // Live table: closing the request (Ricardo cut in) stops the rest of the turn.
  const stop = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) stop.abort();
  });
  const open = () => !res.writableEnded && !res.destroyed;
  const emit = (event: TeamEvent) => {
    if (open()) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const keepAlive = setInterval(() => open() && res.write(": ping\n\n"), 15_000);
  const cut = req.body?.interrupted;
  const interrupted: Interruption | undefined =
    cut && typeof cut.seatId === "string"
      ? { seatId: cut.seatId.slice(0, 40), heard: String(cut.heard ?? "").slice(0, 600) }
      : undefined;
  try {
    await runTurn(text, emit, mode, { signal: stop.signal, interrupted });
  } catch (err) {
    console.error("turn failed", err);
    emit({ type: "notice", text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` });
    emit({ type: "done" });
  } finally {
    clearInterval(keepAlive);
    if (open()) res.end();
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

// The email kill switch: off means no seat reads the inbox and no draft can
// be saved or sent, until it's turned back on.
app.post("/api/email/enabled", async (req, res) => {
  const enabled = req.body?.enabled === true;
  await setSetting("email_enabled", enabled ? "true" : "false");
  res.json({ enabled });
});

// Inbox review cleanup: unsubscribe from a bulk sender, or move its mail
// from the inbox to Archive. Only on Ricardo's tap and confirm in the app.
app.post("/api/mail/cleanup", async (req, res) => {
  const { address, action } = req.body ?? {};
  if (typeof address !== "string" || !/@/.test(address) || (action !== "unsubscribe" && action !== "archive")) {
    res.status(400).json({ error: "Give a sender address and unsubscribe or archive." });
    return;
  }
  if (!mailConfigured() || !(await emailEnabled())) {
    res.status(400).json({ error: "Email access is off or not set up." });
    return;
  }
  try {
    res.json({ message: await cleanUpSender(address, action) });
  } catch (err) {
    console.error("mail cleanup failed", err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  if (!(await emailEnabled())) {
    res.status(400).json({ error: "Email access is switched off. Turn it back on in Connections first." });
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
  const { name, title, model, role_card, enabled, email_access } = req.body ?? {};
  await updateSeat(req.params.id, {
    name,
    title,
    model,
    role_card,
    enabled,
    email_access: typeof email_access === "boolean" ? email_access : undefined,
  });
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

app.post("/api/memory/:id/private", async (req, res) => {
  if (typeof req.body?.private !== "boolean") {
    res.status(400).json({ error: "private must be true or false." });
    return;
  }
  await setMemoryPrivate(Number(req.params.id), req.body.private);
  res.json({ memory: await listMemory() });
});

app.delete("/api/memory/:id", async (req, res) => {
  await deleteMemory(Number(req.params.id));
  res.json({ memory: await listMemory() });
});

app.get("/api/memory", async (_req, res) => {
  res.json({ memory: await listMemory() });
});

// Chat history from Ricardo's other AI accounts: the app reads the export
// file on his device and sends the conversations in batches.
app.get("/api/imports", async (_req, res) => {
  res.json({ imports: await listImports() });
});

app.post("/api/imports", async (req, res) => {
  const source = req.body?.source as ImportSource;
  if (!IMPORT_SOURCES.includes(source)) {
    res.status(400).json({ error: "Unknown source." });
    return;
  }
  res.json({ id: await startImport(source, String(req.body?.filename ?? "export")) });
});

app.post("/api/imports/:id/chats", express.json({ limit: "8mb" }), async (req, res) => {
  const source = req.body?.source as ImportSource;
  const chats = req.body?.chats;
  if (!IMPORT_SOURCES.includes(source) || !Array.isArray(chats)) {
    res.status(400).json({ error: "Send the source and a list of chats." });
    return;
  }
  res.json({ added: await addChats(Number(req.params.id), source, chats) });
});

app.post("/api/imports/:id/finish", async (req, res) => {
  await finishImport(Number(req.params.id));
  res.json({ imports: await listImports() });
});

// The apps connected to Sphere as a connector (ChatGPT, Claude).
app.get("/api/connector", async (req, res) => {
  const url = `${(process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/$/, "")}/mcp`;
  res.json({ url, apps: await listConnectedApps() });
});

app.delete("/api/connector/apps/:id", async (req, res) => {
  await disconnectApp(req.params.id);
  res.json({ apps: await listConnectedApps() });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
});

async function main() {
  await migrate();
  sessionEpoch = Number(await getSetting("session_epoch")) || 0;
  await seedSeats();
  await loadModelSwaps();
  await backfillPrivate();
  // Picks up a chat import that a restart interrupted.
  void processImports();

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
