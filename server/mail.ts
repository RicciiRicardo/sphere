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
export async function recentInbox(limit = 15, days = 3): Promise<InboxMessage[]> {
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
      const out: InboxMessage[] = [];
      // Only the first 32 KB of each message: enough for headers and a snippet,
      // without pulling down attachments.
      for await (const msg of client.fetch(pick, { uid: true, flags: true, envelope: true, source: { maxLength: 32_768 } }, { uid: true })) {
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
          snippet: text.slice(0, 300),
        });
      }
      return out.reverse();
    } finally {
      lock.release();
    }
  });
  inboxCache = { at: Date.now(), items };
  return items;
}

export function formatInbox(items: InboxMessage[], tz: string): string {
  if (!items.length) return "(No messages in the last few days.)";
  return items
    .map((m) => {
      const when = new Date(m.date).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
      return `- ${m.unread ? "[unread] " : ""}${when}, from ${m.from} <${m.fromAddress}>, subject "${m.subject}" [message-id ${m.messageId}]: ${m.snippet}`;
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
