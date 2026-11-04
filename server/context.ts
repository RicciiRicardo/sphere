import { z } from "zod";
import { db } from "./db.js";
import { engineJSON } from "./engine.js";

// The context engine: one shared store every seat reads from, filled from
// conversations (automatically) and from the memory panel (by hand).
export const MEMORY_KINDS = ["person", "project", "commitment", "decision", "preference", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  content: string;
  source: string;
  private: boolean;
  created_at: string;
  updated_at: string;
}

export interface TranscriptLine {
  speaker: string;
  kind: string;
  content: string;
  private: boolean;
}


export async function listMemory(): Promise<MemoryItem[]> {
  const { rows } = await db.query<MemoryItem>("SELECT * FROM memory ORDER BY updated_at DESC");
  return rows;
}

export async function addMemory(kind: MemoryKind, content: string, source: string, isPrivate = false) {
  const { rows } = await db.query<MemoryItem>(
    "INSERT INTO memory (kind, content, source, private) VALUES ($1, $2, $3, $4) RETURNING *",
    [kind, content.trim(), source, isPrivate],
  );
  return rows[0];
}

export async function updateMemory(id: number, kind: MemoryKind, content: string) {
  await db.query("UPDATE memory SET kind = $2, content = $3, updated_at = NOW() WHERE id = $1", [
    id,
    kind,
    content.trim(),
  ]);
}

export async function deleteMemory(id: number) {
  await db.query("DELETE FROM memory WHERE id = $1", [id]);
}

const STOPWORDS = new Set(
  "the a an and or but to of in on for with at by from is are was were be it this that we i you my our me us team can could should would will what how why when who".split(
    " ",
  ),
);

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9$%]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

// Each seat gets a slice of memory rather than the whole store: everything
// while the store is small, then the items that best match the request plus
// the most recently updated ones.
// includePrivate: only for seats allowed to read Ricardo's email, since
// private memory was made from it.
export async function memorySlice(request: string, includePrivate: boolean, limit = 40): Promise<MemoryItem[]> {
  const all = (await listMemory()).filter((m) => includePrivate || !m.private);
  if (all.length <= limit) return all;
  const ask = words(request);
  const scored = all.map((m, recency) => {
    let overlap = 0;
    for (const w of words(m.content)) if (ask.has(w)) overlap++;
    return { m, score: overlap * 10 - recency * 0.1 + (m.kind === "commitment" || m.kind === "decision" ? 1 : 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m);
}

export function formatMemory(items: MemoryItem[]): string {
  if (!items.length) return "(The team memory is empty so far.)";
  return MEMORY_KINDS.map((kind) => {
    const group = items.filter((m) => m.kind === kind);
    if (!group.length) return "";
    return `${kind.toUpperCase()}S\n` + group.map((m) => `- ${m.content} [source: ${m.source}]`).join("\n");
  })
    .filter(Boolean)
    .join("\n\n");
}

// One-time: conversations about email from before the email rules existed
// (Nov 4, 2026), and memory made during them, become private like new ones.
export async function backfillPrivate() {
  const done = await db.query("SELECT 1 FROM applied_seeds WHERE key = 'private-backfill:v1'");
  if (done.rows.length) return;
  const { rows } = await db.query<{ turn_id: string; first: string; last: string }>(
    `SELECT m.turn_id, MIN(m.created_at) AS first, MAX(m.created_at) AS last
     FROM messages m
     WHERE m.turn_id IN (
       SELECT turn_id FROM messages
       WHERE kind = 'user' AND content ~* '(inbox|e-?mails?|repl(y|ies)|draft)'
     )
     GROUP BY m.turn_id`,
  );
  for (const r of rows) {
    await db.query("UPDATE messages SET private = TRUE WHERE turn_id = $1", [r.turn_id]);
    // Memory is extracted right after a turn ends.
    await db.query(
      "UPDATE memory SET private = TRUE WHERE created_at BETWEEN $1 AND ($2::timestamptz + INTERVAL '3 minutes')",
      [r.first, r.last],
    );
  }
  await db.query("INSERT INTO applied_seeds (key) VALUES ('private-backfill:v1') ON CONFLICT DO NOTHING");
  if (rows.length) console.log(`marked ${rows.length} earlier email conversations private`);
}

export async function recentTranscript(limit = 24): Promise<TranscriptLine[]> {
  const { rows } = await db.query<TranscriptLine>(
    `SELECT speaker, kind, content, private FROM (
       SELECT speaker, kind, content, private, id FROM messages
       WHERE kind IN ('user', 'seat', 'rebuttal', 'briefing') ORDER BY id DESC LIMIT $1
     ) t ORDER BY id`,
    [limit],
  );
  return rows;
}

// includePrivate: false replaces turns that used Ricardo's email with a
// placeholder, so seats without email access never see what came from it.
export function formatTranscript(lines: TranscriptLine[], names: Record<string, string>, includePrivate = true): string {
  if (!lines.length) return "(No earlier conversation.)";
  return lines
    .map((l, i) => {
      if (l.private && !includePrivate) {
        return i > 0 && lines[i - 1].private ? "" : "(Here Ricardo discussed his email privately with the seats that may read it. You don't have access.)";
      }
      const who = l.speaker === "you" ? "Ricardo" : (names[l.speaker] ?? l.speaker);
      const label = l.kind === "briefing" ? `${who} (to Ricardo)` : l.kind === "rebuttal" ? `${who} (responding)` : who;
      return `${label}: ${l.content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

const Extracted = z.object({
  items: z.array(
    z.object({
      kind: z.enum(MEMORY_KINDS),
      content: z.string(),
    }),
  ),
});

// After each turn, a small model pulls out anything worth remembering. New
// items only: exact duplicates of what's stored are skipped.
export async function extractMemory(userText: string, teamReply: string, source: string, isPrivate = false) {
  const existing = await listMemory();
  const known = existing.slice(0, 80).map((m) => `- (${m.kind}) ${m.content}`).join("\n");
  const result = await engineJSON(
    Extracted,
    "You maintain the shared memory for Ricardo's AI team. From the exchange below, extract only durable facts worth remembering across days: people and organizations (who they are, relationships), projects in flight, commitments (who promised what, by when), decisions Ricardo made, and Ricardo's preferences. A preference or decision counts only if Ricardo stated it himself in what he said; the team's suggestions and recommendations are not his preferences or decisions, so never record them as such. Never record personal financial, banking, loan, credit card, medical, legal-case or password details, even when they appear in his email. Skip small talk, one-off questions, and anything already in the known list. Write each item as one self-contained sentence. Return an empty list when nothing qualifies.",
    `KNOWN MEMORY\n${known || "(none)"}\n\nRICARDO SAID\n${userText}\n\nTEAM REPLIED\n${teamReply}`,
    4000,
  );
  const items = result?.data.items ?? [];
  const seen = new Set(existing.map((m) => m.content.toLowerCase()));
  const added: MemoryItem[] = [];
  for (const item of items) {
    const content = item.content.trim();
    if (!content || seen.has(content.toLowerCase())) continue;
    seen.add(content.toLowerCase());
    added.push(await addMemory(item.kind, content, source, isPrivate));
  }
  return added;
}
