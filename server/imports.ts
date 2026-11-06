import { z } from "zod";
import { db } from "./db.js";
import { engineJSON } from "./engine.js";
import { addMemory, listMemory, MEMORY_KINDS } from "./context.js";
import { isMock } from "./providers.js";

// Chat history brought in from Ricardo's other AI accounts (ChatGPT, Claude,
// Gemini), from the export files those services let him download. The app
// reads the file on his device and sends only the conversations' text; here
// the engine reads them a batch at a time, in the background, and adds what
// matters to the team memory. A conversation's text is deleted once it's
// been read, and a conversation already brought in is skipped next time, so
// a newer export only adds the new ones.

export const IMPORT_SOURCES = ["chatgpt", "claude", "gemini"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
const SOURCE_NAMES: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

export interface ImportedChat {
  id: string;
  title: string;
  started?: string;
  text: string;
}

export interface ImportStatus {
  id: number;
  source: ImportSource;
  filename: string;
  status: "uploading" | "working" | "done";
  created_at: string;
  chats: number;
  read: number;
  failed: number;
  added_team: number;
  added_private: number;
}

// The most of one conversation that's kept. Long ones keep their start and
// end, where what was asked and what was decided usually are.
const MAX_CHAT = 12_000;
// How much conversation text goes to the engine in one call.
const MAX_BATCH = 24_000;

function trimChat(text: string) {
  if (text.length <= MAX_CHAT) return text;
  return `${text.slice(0, 8_000)}\n\n[…]\n\n${text.slice(-4_000)}`;
}

export async function startImport(source: ImportSource, filename: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>("INSERT INTO imports (source, filename) VALUES ($1, $2) RETURNING id", [
    source,
    filename.slice(0, 200),
  ]);
  return rows[0].id;
}

// Adds conversations to an import. Ones brought in before (by any import)
// are skipped. Returns how many were new.
export async function addChats(importId: number, source: ImportSource, chats: ImportedChat[]): Promise<number> {
  let added = 0;
  for (const chat of chats) {
    const text = String(chat.text ?? "").trim();
    if (!text || !chat.id) continue;
    const started = chat.started && !Number.isNaN(Date.parse(chat.started)) ? new Date(chat.started).toISOString() : null;
    const { rows } = await db.query(
      `INSERT INTO imported_chats (import_id, source, ext_id, title, started_at, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (source, ext_id) DO NOTHING RETURNING id`,
      [importId, source, String(chat.id).slice(0, 200), String(chat.title || "Untitled").slice(0, 200), started, trimChat(text)],
    );
    added += rows.length;
  }
  return added;
}

export async function finishImport(importId: number) {
  await db.query("UPDATE imports SET status = 'working', updated_at = NOW() WHERE id = $1 AND status = 'uploading'", [importId]);
  void processImports();
}

export async function listImports(): Promise<ImportStatus[]> {
  const { rows } = await db.query<ImportStatus>(
    `SELECT i.id, i.source, i.filename, i.status, i.created_at, i.added_team, i.added_private,
       COUNT(c.id)::int AS chats,
       COUNT(c.id) FILTER (WHERE c.status = 'done')::int AS read,
       COUNT(c.id) FILTER (WHERE c.status = 'failed')::int AS failed
     FROM imports i LEFT JOIN imported_chats c ON c.import_id = i.id
     GROUP BY i.id ORDER BY i.id DESC LIMIT 10`,
  );
  return rows;
}

const Found = z.object({
  items: z.array(
    z.object({
      chat: z.number(),
      kind: z.enum(MEMORY_KINDS),
      content: z.string(),
      audience: z.enum(["team", "private"]),
    }),
  ),
});

// Who sees what. The memory is shared so every seat works from the same
// picture, so the default is the whole team; only the sensitive specifics
// are locked to the seats allowed to read email, and some things are never
// kept at all.
const INSTRUCTIONS = `You maintain the shared memory for Ricardo Berris's AI team (his companies: Go Global, MI Group, Purpusly, Berris Group, Maggie Pam). Below are conversations Ricardo had with other AI assistants, brought in from his accounts so the team knows what he's been working on.

From them, extract only durable facts worth remembering: people and organizations (who they are, how they relate to Ricardo and his companies), his ventures, projects, goals and plans, commitments (who promised what, by when), decisions Ricardo made, and Ricardo's preferences (how he likes to work, write and decide).
- Only what Ricardo said or clearly acted on counts. What the AI assistant suggested, researched or wrote is not a fact about Ricardo, his decision or his preference unless he confirmed it.
- These conversations may be old. When a fact is tied to a time (a plan, a deadline, a status), say when, e.g. "As of March 2025, ...". Skip things that were clearly one-off.
- Skip coding help, homework-style questions, general knowledge, small talk, and anything already in the known memory.
- Write each item as one self-contained sentence that makes sense on its own. Most conversations yield nothing; return an empty list when nothing qualifies.
- "chat" is the number of the conversation the item came from.

AUDIENCE: who on the team may see each item. The team can only help with what it knows, so share by default.
- "team" (every seat): who people and organizations are and how they connect to Ricardo; his companies, projects, products, goals, strategies and plans; how he likes to work; business decisions and commitments.
- "private" (only the two seats allowed to read his email): exact money figures and terms (prices, valuations, revenue, salaries, investment amounts, ownership), investor and fundraising specifics, contract negotiations, personnel or interpersonal matters about named people, his family and personal life, and anything he called confidential.
- When a fact has a sensitive detail, split it into two items: the general fact for "team", the specifics as "private". For example, team: "Go Global is raising a SAFE round from angel investors." private: "Go Global's SAFE round terms: ..."
- Never record at all: personal financial, banking, loan, credit or card details, account numbers, passwords or keys, government ID numbers, medical or health details, or legal-case details.`;

function chatHeader(n: number, c: { source: ImportSource; title: string; started_at: string | null }) {
  const when = c.started_at ? new Date(c.started_at).toISOString().slice(0, 10) : "date unknown";
  return `=== CHAT ${n}: "${c.title}" (${SOURCE_NAMES[c.source]}, ${when}) ===`;
}

interface PendingChat {
  id: number;
  import_id: number;
  source: ImportSource;
  title: string;
  started_at: string | null;
  body: string;
  attempts: number;
}

let running = false;

// Works through every conversation still waiting, a batch at a time. Runs
// after an upload and on startup, so a restart part-way picks up where it left off.
export async function processImports() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const { rows } = await db.query<PendingChat>(
        `SELECT c.id, c.import_id, c.source, c.title, c.started_at, c.body, c.attempts
         FROM imported_chats c JOIN imports i ON i.id = c.import_id
         WHERE c.status = 'pending' AND i.status = 'working'
         ORDER BY c.import_id, c.started_at NULLS LAST, c.id LIMIT 40`,
      );
      if (!rows.length) break;
      const batch: PendingChat[] = [];
      let size = 0;
      for (const c of rows) {
        if (batch.length && size + c.body.length > MAX_BATCH) break;
        batch.push(c);
        size += c.body.length;
      }
      await readBatch(batch);
    }
    await db.query(
      `UPDATE imports SET status = 'done', updated_at = NOW() WHERE status = 'working'
       AND NOT EXISTS (SELECT 1 FROM imported_chats c WHERE c.import_id = imports.id AND c.status = 'pending')`,
    );
  } catch (err) {
    console.error("chat import failed", err);
  } finally {
    running = false;
  }
}

async function readBatch(batch: PendingChat[]) {
  const existing = await listMemory();
  const known = existing
    .slice(0, 120)
    .map((m) => `- (${m.kind}) ${m.content}`)
    .join("\n");
  const chats = batch.map((c, i) => `${chatHeader(i + 1, c)}\n${c.body}`).join("\n\n");
  const result = isMock()
    ? { data: mockFound(batch) }
    : await engineJSON(Found, INSTRUCTIONS, `KNOWN MEMORY\n${known || "(none)"}\n\nCONVERSATIONS\n${chats}`, 4000);
  if (!result) {
    // The engine couldn't be reached or answered badly: try again later, at most three times.
    await db.query(
      `UPDATE imported_chats SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END,
         body = CASE WHEN attempts + 1 >= 3 THEN NULL ELSE body END
       WHERE id = ANY($1)`,
      [batch.map((c) => c.id)],
    );
    await new Promise((r) => setTimeout(r, 30_000));
    return;
  }
  const seen = new Set(existing.map((m) => m.content.toLowerCase()));
  const counts = new Map<number, number>();
  const perImport = new Map<number, { team: number; private: number }>();
  for (const item of result.data.items) {
    const chat = batch[Math.round(item.chat) - 1];
    const content = item.content.trim();
    if (!chat || !content || seen.has(content.toLowerCase())) continue;
    seen.add(content.toLowerCase());
    const isPrivate = item.audience === "private";
    const when = chat.started_at ? `, ${new Date(chat.started_at).toISOString().slice(0, 10)}` : "";
    await addMemory(item.kind, content, `${SOURCE_NAMES[chat.source]} chat "${chat.title.slice(0, 60)}"${when}`, isPrivate);
    counts.set(chat.id, (counts.get(chat.id) ?? 0) + 1);
    const tally = perImport.get(chat.import_id) ?? { team: 0, private: 0 };
    tally[isPrivate ? "private" : "team"]++;
    perImport.set(chat.import_id, tally);
  }
  for (const c of batch) {
    await db.query("UPDATE imported_chats SET status = 'done', body = NULL, items = $2 WHERE id = $1", [c.id, counts.get(c.id) ?? 0]);
  }
  for (const [id, t] of perImport) {
    await db.query(
      "UPDATE imports SET added_team = added_team + $2, added_private = added_private + $3, updated_at = NOW() WHERE id = $1",
      [id, t.team, t.private],
    );
  }
}

// Mock mode: one item per conversation, alternating who sees it.
function mockFound(batch: PendingChat[]): z.infer<typeof Found> {
  return {
    items: batch.map((c, i) => ({
      chat: i + 1,
      kind: "note" as const,
      content: `(Mock) Ricardo talked with ${SOURCE_NAMES[c.source]} about "${c.title}".`,
      audience: i % 3 === 2 ? ("private" as const) : ("team" as const),
    })),
  };
}
