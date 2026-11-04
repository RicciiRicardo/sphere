import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { isMock } from "./providers.js";

// Ricardo's migroupco.com mailbox is on his web host's own mail server, so
// Sphere talks to it directly: IMAP to read and to save drafts, SMTP to send.
// Credentials live only in Render's environment.
const env = (k: string) => process.env[k]?.trim() ?? "";

export function mailConfigured() {
  return isMock() || Boolean(env("MAIL_IMAP_HOST") && env("MAIL_USER") && env("MAIL_PASSWORD"));
}

export function mailAccount() {
  return isMock() ? "ricardo@example.com (mock)" : env("MAIL_USER");
}

export interface InboxMessage {
  uid: number;
  messageId: string;
  from: string;
  fromAddress: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
  // Set on search results, which can come from any folder.
  folder?: string;
}

// Headers plus a text snippet for each uid, oldest first. Only the first
// 32 KB of each message: enough for a snippet, without the attachments.
async function fetchMessages(client: ImapFlow, uids: number[], snippet: number, folder?: string): Promise<InboxMessage[]> {
  const out: InboxMessage[] = [];
  if (!uids.length) return out;
  for await (const msg of client.fetch(uids, { uid: true, flags: true, envelope: true, source: { maxLength: 32_768 } }, { uid: true })) {
    const parsed = msg.source ? await simpleParser(msg.source).catch(() => undefined) : undefined;
    const fromObj = msg.envelope?.from?.[0];
    const text = (parsed?.text ?? "").replace(/\s+/g, " ").trim();
    out.push({
      uid: msg.uid,
      messageId: msg.envelope?.messageId ?? "",
      from: fromObj?.name || fromObj?.address || "unknown",
      fromAddress: fromObj?.address ?? "",
      subject: msg.envelope?.subject ?? "(no subject)",
      date: new Date(msg.envelope?.date ?? Date.now()).toISOString(),
      unread: !msg.flags?.has("\\Seen"),
      snippet: text.slice(0, snippet),
      folder,
    });
  }
  return out;
}

function imap() {
  return new ImapFlow({
    host: env("MAIL_IMAP_HOST"),
    port: Number(env("MAIL_IMAP_PORT") || 993),
    secure: (env("MAIL_IMAP_PORT") || "993") === "993",
    auth: { user: env("MAIL_USER"), pass: env("MAIL_PASSWORD") },
    logger: false,
  });
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = imap();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

let inboxCache: { at: number; items: InboxMessage[] } | undefined;

// The most recent messages from the last few days, newest first. Cached for
// two minutes so one turn's several seats don't each open a mail connection.
// Ricardo gets 15+ emails a day, so 15 only ever covered today; 40 with
// shorter snippets reaches back about three days for a similar prompt size.
export async function recentInbox(limit = 40, days = 3): Promise<InboxMessage[]> {
  if (isMock()) return MOCK_INBOX;
  if (!mailConfigured()) return [];
  if (inboxCache && Date.now() - inboxCache.at < 120_000) return inboxCache.items;
  const items = await withImap(async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - days * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      const pick = uids.slice(-limit);
      if (!pick.length) return [];
      return (await fetchMessages(client, pick, 200)).reverse();
    } finally {
      lock.release();
    }
  });
  inboxCache = { at: Date.now(), items };
  return items;
}

// Searches the mailbox for messages whose sender or subject contains any of
// the terms, in every folder but Drafts and Trash (spam included, since a
// missed email often sits there). The full text is searched too, but only in
// the inbox and spam: web-host mail servers have no search index, so a text
// search reads every message and is far too slow across all folders.
// Newest first, with longer snippets than the inbox view. Stops after about
// 50 seconds and returns what it found so far; the full-text pass covers
// the last 45 days.
export async function searchMailbox(terms: string[], days = 180, limit = 25): Promise<InboxMessage[]> {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 6);
  if (!clean.length) return [];
  if (isMock()) {
    const hit = (m: InboxMessage) => clean.some((t) => `${m.from} ${m.fromAddress} ${m.subject} ${m.snippet}`.toLowerCase().includes(t.toLowerCase()));
    return MOCK_INBOX.filter(hit).map((m) => ({ ...m, folder: "INBOX" }));
  }
  if (!mailConfigured()) return [];
  const deadline = Date.now() + 50_000;
  const found = new Map<string, InboxMessage>();
  const since = new Date(Date.now() - days * 86_400_000);
  // The slow full-text pass only reaches back 45 days.
  const textSince = new Date(Date.now() - Math.min(days, 45) * 86_400_000);
  const anyOf = (fields: ("subject" | "from" | "text")[]) => ({
    since: fields.includes("text") ? textSince : since,
    or: clean.flatMap((t) => fields.map((f) => ({ [f]: t }))),
  });
  const search = withImap(async (client) => {
    const folders = (await client.list()).filter(
      (f) =>
        f.specialUse !== "\\Drafts" &&
        f.specialUse !== "\\Trash" &&
        !f.flags.has("\\Noselect") &&
        !/^(inbox[./])?(drafts|trash|deleted)/i.test(f.path),
    );
    const isFullText = (f: (typeof folders)[number]) => f.path === "INBOX" || f.specialUse === "\\Junk" || /spam|junk/i.test(f.path);
    // INBOX first, then spam, then the rest.
    folders.sort((x, y) => Number(y.path === "INBOX") - Number(x.path === "INBOX") || Number(isFullText(y)) - Number(isFullText(x)));
    for (const f of folders.slice(0, 30)) {
      if (Date.now() > deadline) break;
      const lock = await client.getMailboxLock(f.path).catch(() => undefined);
      if (!lock) continue;
      try {
        const uids = new Set((await client.search(anyOf(["subject", "from"]), { uid: true })) || []);
        if (isFullText(f) && Date.now() < deadline) {
          for (const u of (await client.search(anyOf(["text"]), { uid: true })) || []) uids.add(u);
        }
        const pick = [...uids].sort((x, y) => x - y).slice(-limit);
        for (const m of await fetchMessages(client, pick, 600, f.path)) found.set(`${f.path}:${m.uid}`, m);
      } catch (err) {
        console.error(`mail search in ${f.path} failed`, err);
      } finally {
        lock.release();
      }
    }
  });
  // One IMAP command can't be interrupted, so don't let a slow server hold
  // the turn: after 75 seconds, answer with whatever was found.
  let failure: unknown;
  await Promise.race([search.catch((err) => (failure = err)), new Promise((r) => setTimeout(r, 75_000))]);
  if (failure && !found.size) throw failure;
  return [...found.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

export function formatInbox(items: InboxMessage[], tz: string): string {
  if (!items.length) return "(No messages in the last few days.)";
  return items
    .map((m) => {
      const when = new Date(m.date).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
      return `- ${m.unread ? "[unread] " : ""}${m.folder && m.folder !== "INBOX" ? `[in ${m.folder}] ` : ""}${when}, from ${m.from} <${m.fromAddress}>, subject "${m.subject}" [message-id ${m.messageId}]: ${m.snippet}`;
    })
    .join("\n");
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}

async function compose(email: OutgoingEmail): Promise<Buffer> {
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await builder.sendMail(messageOptions(email));
  return info.message as Buffer;
}

function messageOptions(email: OutgoingEmail) {
  return {
    from: env("MAIL_FROM") || env("MAIL_USER"),
    to: email.to,
    subject: email.subject,
    text: email.body,
    ...(email.inReplyTo ? { inReplyTo: email.inReplyTo, references: email.inReplyTo } : {}),
  };
}

async function folderFor(client: ImapFlow, use: "\\Drafts" | "\\Sent", fallback: RegExp): Promise<string | undefined> {
  const folders = await client.list();
  return (folders.find((f) => f.specialUse === use) ?? folders.find((f) => fallback.test(f.path)))?.path;
}

// Saves the email into the mailbox's Drafts folder, so it appears in
// Ricardo's own mail app ready to review and send.
export async function saveDraft(email: OutgoingEmail): Promise<string> {
  if (isMock()) return "Drafts";
  const raw = await compose(email);
  return withImap(async (client) => {
    const path = await folderFor(client, "\\Drafts", /drafts/i);
    if (!path) throw new Error("Couldn't find a Drafts folder in the mailbox.");
    await client.append(path, raw, ["\\Draft", "\\Seen"]);
    return path;
  });
}

// Sends the email over SMTP, then files a copy in Sent (most web-host mail
// servers don't do that on their own).
export async function sendEmail(email: OutgoingEmail): Promise<void> {
  if (isMock()) return;
  const port = Number(env("MAIL_SMTP_PORT") || 465);
  const transport = nodemailer.createTransport({
    host: env("MAIL_SMTP_HOST") || env("MAIL_IMAP_HOST"),
    port,
    secure: port === 465,
    auth: { user: env("MAIL_USER"), pass: env("MAIL_PASSWORD") },
  });
  await transport.sendMail(messageOptions(email));
  const raw = await compose(email);
  await withImap(async (client) => {
    const path = await folderFor(client, "\\Sent", /^(inbox[./])?sent/i);
    if (path) await client.append(path, raw, ["\\Seen"]);
  }).catch((err) => console.error("sent, but couldn't file a copy in Sent", err));
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const MOCK_INBOX: InboxMessage[] = [
  {
    uid: 3,
    messageId: "<mock-3@example.com>",
    from: "Vanessa Brown",
    fromAddress: "vanessa@example.com",
    subject: "King Tamer shipment to Kingston",
    date: hoursAgo(3),
    unread: true,
    snippet: "Hi Ricardo, the distributor in Kingston wants pricing for 200 units by Friday. Can you send the landed cost?",
  },
  {
    uid: 2,
    messageId: "<mock-2@example.com>",
    from: "Cerebral Valley",
    fromAddress: "events@example.com",
    subject: "Your hackathon application",
    date: hoursAgo(20),
    unread: true,
    snippet: "Thanks for applying to the Meta Global AI Developer Hackathon. Selections go out by October 26.",
  },
  {
    uid: 1,
    messageId: "<mock-1@example.com>",
    from: "Aubyn",
    fromAddress: "aubyn@example.com",
    subject: "Friday call",
    date: hoursAgo(30),
    unread: false,
    snippet: "Confirming 10am Friday. Please send the updated deck beforehand.",
  },
];
