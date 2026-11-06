import { Unzip, UnzipInflate } from "fflate";

// Reads the export file Ricardo downloads from ChatGPT, Claude or Gemini, on
// his own device, and turns it into plain conversations. Only the
// conversations' text is sent on; images and attachments in the file stay
// on the device.

export type ImportSource = "chatgpt" | "claude" | "gemini";

export interface ImportedChat {
  id: string;
  title: string;
  started?: string;
  text: string;
}

const NAMES: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

// An assistant's long answer matters less than what Ricardo said, so it's cut short.
const MAX_ANSWER = 1_500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function chatText(source: ImportSource, turns: { user: boolean; text: string }[]) {
  const said = turns.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
  if (!said.some((t) => t.user)) return "";
  const text = said.map((t) => (t.user ? `Ricardo: ${t.text}` : `${NAMES[source]}: ${clip(t.text, MAX_ANSWER)}`)).join("\n\n");
  // Very long conversations keep their start and end (the server keeps the same).
  return text.length > 12_000 ? `${text.slice(0, 8_000)}\n\n[…]\n\n${text.slice(-4_000)}` : text;
}

const isoFromSeconds = (s: unknown) => (typeof s === "number" ? new Date(s * 1000).toISOString() : undefined);

// ChatGPT's conversations.json: each conversation is a tree of messages
// (edits branch it); the branch that was kept runs from current_node back to the start.
interface GptNode {
  parent?: string | null;
  message?: { author?: { role?: string }; content?: { parts?: unknown[]; text?: string } } | null;
}
function parseChatGpt(data: unknown[]): ImportedChat[] {
  return data.flatMap((raw) => {
    const c = raw as { id?: string; conversation_id?: string; title?: string; create_time?: number; mapping?: Record<string, GptNode>; current_node?: string };
    const mapping = c.mapping ?? {};
    const turns: { user: boolean; text: string }[] = [];
    let node = c.current_node;
    const seen = new Set<string>();
    while (node && mapping[node] && !seen.has(node)) {
      seen.add(node);
      const m = mapping[node].message;
      const role = m?.author?.role;
      if (m && (role === "user" || role === "assistant")) {
        const parts = m.content?.parts ?? (m.content?.text ? [m.content.text] : []);
        const text = parts.filter((p): p is string => typeof p === "string").join("\n");
        turns.unshift({ user: role === "user", text });
      }
      node = mapping[node].parent ?? undefined;
    }
    const text = chatText("chatgpt", turns);
    const id = c.conversation_id ?? c.id;
    return text && id ? [{ id, title: c.title || "Untitled", started: isoFromSeconds(c.create_time), text }] : [];
  });
}

// Claude's conversations.json: each conversation lists its messages in order.
function parseClaude(data: unknown[]): ImportedChat[] {
  return data.flatMap((raw) => {
    const c = raw as {
      uuid?: string;
      name?: string;
      created_at?: string;
      chat_messages?: { sender?: string; text?: string; content?: { type?: string; text?: string }[] }[];
    };
    const turns = (c.chat_messages ?? []).map((m) => ({
      user: m.sender === "human",
      text: m.text || (m.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n"),
    }));
    const text = chatText("claude", turns);
    return text && c.uuid ? [{ id: c.uuid, title: c.name || "Untitled", started: c.created_at, text }] : [];
  });
}

const htmlText = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

// Gemini, from Google Takeout ("My Activity", Gemini Apps): one entry per
// prompt, not grouped into conversations. JSON when chosen in Takeout, HTML otherwise.
function parseGeminiJson(data: unknown[]): ImportedChat[] {
  return data.flatMap((raw) => {
    const e = raw as { title?: string; time?: string; safeHtmlItem?: { html?: string }[] };
    // Other activity ("Used an Assistant feature", visits) isn't a conversation.
    if (!/^Prompted\s/i.test(e.title ?? "") || !e.time) return [];
    const prompt = (e.title ?? "").replace(/^Prompted\s+/i, "").trim();
    const answer = (e.safeHtmlItem ?? []).map((h) => htmlText(h.html ?? "")).join("\n");
    const text = chatText("gemini", [
      { user: true, text: prompt },
      { user: false, text: answer },
    ]);
    return text ? [{ id: e.time, title: clip(prompt, 80), started: e.time, text }] : [];
  });
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseGeminiHtml(html: string): ImportedChat[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll(".outer-cell")].flatMap((cell) => {
    // Line breaks in Takeout's HTML are <br> tags, which plain text loses.
    const html = (cell.querySelector(".content-cell")?.innerHTML ?? "").replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n$&");
    const lines = htmlText(html).split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const first = lines[0] ?? "";
    if (!/^Prompted\s/i.test(first)) return [];
    const prompt = first.replace(/^Prompted\s+/i, "");
    const dateLine = lines.find((l) => !Number.isNaN(Date.parse(l.replace(/\s+[A-Z]{2,5}$/, ""))));
    const started = dateLine ? new Date(Date.parse(dateLine.replace(/\s+[A-Z]{2,5}$/, ""))).toISOString() : undefined;
    const answer = lines.slice(1).filter((l) => l !== dateLine).join("\n");
    const text = chatText("gemini", [
      { user: true, text: prompt },
      { user: false, text: answer },
    ]);
    return text ? [{ id: `${started ?? ""}-${hash(prompt)}`, title: clip(prompt, 80), started, text }] : [];
  });
}

function parseJson(text: string): { source: ImportSource; chats: ImportedChat[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a chat export Sphere can read.");
  }
  if (!Array.isArray(data) || !data.length) throw new Error("That file has no conversations in it.");
  const first = data[0] as Record<string, unknown>;
  if ("mapping" in first) return { source: "chatgpt", chats: parseChatGpt(data) };
  if ("chat_messages" in first) return { source: "claude", chats: parseClaude(data) };
  if ("header" in first || "safeHtmlItem" in first) return { source: "gemini", chats: parseGeminiJson(data) };
  throw new Error("That file isn't a ChatGPT, Claude or Gemini export.");
}

// The files inside an export that hold the conversations.
const WANTED = (name: string) =>
  /(^|\/)conversations\.json$/i.test(name) || (/gemini/i.test(name) && /(^|\/)MyActivity\.(json|html)$/i.test(name));

// Pulls just the wanted files out of a zip, reading it in pieces so a large
// export (Takeout can be gigabytes) never has to fit in memory at once.
async function unzipWanted(file: File): Promise<{ name: string; text: string }[]> {
  const found: Promise<{ name: string; text: string }>[] = [];
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (f) => {
    if (!WANTED(f.name)) return;
    found.push(
      new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        f.ondata = (err, data, final) => {
          if (err) return reject(err);
          chunks.push(data);
          if (final) resolve({ name: f.name, text: new TextDecoder().decode(concat(chunks)) });
        };
        f.start();
      }),
    );
  };
  const reader = file.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    unzip.push(value);
  }
  return Promise.all(found);
}

function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function readExport(file: File): Promise<{ source: ImportSource; chats: ImportedChat[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return parseJson(await file.text());
  if (name.endsWith(".html")) return { source: "gemini", chats: parseGeminiHtml(await file.text()) };
  if (!name.endsWith(".zip")) throw new Error("Pick the .zip file the service sent you (or the conversations.json inside it).");
  const files = await unzipWanted(file);
  if (!files.length) {
    throw new Error("Couldn't find conversations in that zip. For Gemini, export only My Activity → Gemini Apps from Google Takeout.");
  }
  const results = files.map((f) => (f.name.toLowerCase().endsWith(".html") ? { source: "gemini" as const, chats: parseGeminiHtml(f.text) } : parseJson(f.text)));
  return { source: results[0].source, chats: results.flatMap((r) => r.chats) };
}

// Sends the conversations in batches small enough for one request each.
export function batches(chats: ImportedChat[], maxChars = 2_000_000): ImportedChat[][] {
  const out: ImportedChat[][] = [];
  let cur: ImportedChat[] = [];
  let size = 0;
  for (const c of chats) {
    const n = c.text.length + c.title.length + 100;
    if (cur.length && size + n > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
