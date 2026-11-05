import type { ImapFlow } from "imapflow";
import { db } from "./db.js";
import { fetchMessages, folderFor, mailAccount, mailConfigured, sendEmail, withImap } from "./mail.js";
import { isMock } from "./providers.js";

// The inbox review: who wrote to Ricardo and never got an answer, and which
// bulk senders fill his inbox. Only headers are read for the scan (the mail
// server has no search index, but headers come back quickly), then a preview
// of each unanswered message. Nothing in the mailbox changes unless he taps
// Unsubscribe or Archive on a sender and confirms.

export interface ReviewItem {
  from: string;
  fromAddress: string;
  // The address it was sent to, which hints at the company it's for.
  to: string;
  subject: string;
  date: string;
  messageId: string;
  snippet: string;
  folder: string;
  unread: boolean;
  // Other unanswered messages from the same sender in the period.
  more: number;
}

export interface NoisySender {
  name: string;
  address: string;
  count: number;
  unread: number;
  // How unsubscribing works for this sender, from its List-Unsubscribe header.
  unsubscribe: "one-click" | "email" | "link" | "none";
  link?: string;
  done?: "unsubscribed" | "archived";
}

export interface MailReview {
  days: number;
  scanned: number;
  unanswered: ReviewItem[];
  noisy: NoisySender[];
  // True when the scan stopped early and the lists may be incomplete.
  partial: boolean;
  at: string;
}

interface Unsubscribe {
  https?: string;
  mailto?: string;
  oneClick: boolean;
}

interface Scanned {
  uid: number;
  folder: string;
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: Date;
  messageId: string;
  unread: boolean;
  answered: boolean;
  bulk: boolean;
  unsubscribe: Unsubscribe;
}

const AUTOMATED_SENDER =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|newsletters?|news|marketing|updates?|digest|billing|receipts?|invoices?|orders?|support|team|hello|accounts?)([+._-].*)?@/i;

function headerMap(raw?: Buffer) {
  const map = new Map<string, string>();
  if (!raw) return map;
  // Unfold continuation lines, then split "Name: value".
  for (const line of raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return map;
}

function parseUnsubscribe(h: Map<string, string>): Unsubscribe {
  const value = h.get("list-unsubscribe") ?? "";
  const links = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return {
    https: links.find((l) => /^https:\/\//i.test(l)),
    mailto: links.find((l) => /^mailto:/i.test(l)),
    oneClick: /one-click/i.test(h.get("list-unsubscribe-post") ?? ""),
  };
}

const WANTED_HEADERS = ["list-unsubscribe", "list-unsubscribe-post", "list-id", "precedence", "auto-submitted", "x-campaign-id", "x-mailgun-tag"];

async function scanFolder(client: ImapFlow, path: string, since: Date, deadline: number, me: string): Promise<Scanned[]> {
  const out: Scanned[] = [];
  const lock = await client.getMailboxLock(path).catch(() => undefined);
  if (!lock) return out;
  try {
    const uids = (await client.search({ since }, { uid: true })) || [];
    if (!uids.length) return out;
    for await (const msg of client.fetch(uids, { uid: true, flags: true, envelope: true, headers: WANTED_HEADERS }, { uid: true })) {
      if (Date.now() > deadline) break;
      const from = msg.envelope?.from?.[0];
      const address = (from?.address ?? "").toLowerCase();
      if (!address || address === me) continue;
      const h = headerMap(msg.headers);
      const unsubscribe = parseUnsubscribe(h);
      const bulk =
        Boolean(h.get("list-unsubscribe") || h.get("list-id") || h.get("x-campaign-id") || h.get("x-mailgun-tag")) ||
        /^(bulk|list|junk)$/i.test(h.get("precedence") ?? "") ||
        /^auto-/i.test(h.get("auto-submitted") ?? "") ||
        AUTOMATED_SENDER.test(address);
      out.push({
        uid: msg.uid,
        folder: path,
        fromName: from?.name || address,
        fromAddress: address,
        to: [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])].map((a) => a.address?.toLowerCase() ?? "").filter(Boolean).join(", "),
        subject: msg.envelope?.subject ?? "(no subject)",
        date: new Date(msg.envelope?.date ?? Date.now()),
        messageId: msg.envelope?.messageId ?? "",
        unread: !msg.flags?.has("\\Seen"),
        answered: Boolean(msg.flags?.has("\\Answered")),
        bulk,
        unsubscribe,
      });
    }
  } finally {
    lock.release();
  }
  return out;
}

// What Ricardo sent: the messages he replied to, and when he last wrote to each address.
async function scanSent(client: ImapFlow, path: string, since: Date, deadline: number) {
  const repliedTo = new Set<string>();
  const lastWrote = new Map<string, number>();
  const lock = await client.getMailboxLock(path).catch(() => undefined);
  if (!lock) return { repliedTo, lastWrote };
  try {
    const uids = (await client.search({ since }, { uid: true })) || [];
    if (!uids.length) return { repliedTo, lastWrote };
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, headers: ["references"] }, { uid: true })) {
      if (Date.now() > deadline) break;
      const env = msg.envelope;
      if (env?.inReplyTo) repliedTo.add(env.inReplyTo.trim());
      for (const ref of (headerMap(msg.headers).get("references") ?? "").match(/<[^>]+>/g) ?? []) repliedTo.add(ref);
      const when = new Date(env?.date ?? 0).getTime();
      for (const a of [...(env?.to ?? []), ...(env?.cc ?? [])]) {
        const addr = a.address?.toLowerCase();
        if (addr && when > (lastWrote.get(addr) ?? 0)) lastWrote.set(addr, when);
      }
    }
  } finally {
    lock.release();
  }
  return { repliedTo, lastWrote };
}

async function unsubscribedAlready(): Promise<Map<string, "unsubscribed" | "archived">> {
  const { rows } = await db.query<{ address: string; action: string }>(
    "SELECT address, action FROM mail_cleanup WHERE created_at > NOW() - INTERVAL '120 days'",
  );
  return new Map(rows.map((r) => [r.address, r.action === "archived" ? "archived" : "unsubscribed"]));
}

let cache: { at: number; review: MailReview; unsubscribe: Map<string, Unsubscribe> } | undefined;

export async function reviewMailbox(days = 45): Promise<MailReview> {
  if (isMock()) return mockReview(days);
  if (!mailConfigured()) throw new Error("Email isn't connected yet.");
  if (cache && Date.now() - cache.at < 10 * 60_000 && cache.review.days === days) {
    return { ...cache.review, noisy: await markDone(cache.review.noisy) };
  }
  const me = mailAccount().toLowerCase();
  const since = new Date(Date.now() - days * 86_400_000);
  const deadline = Date.now() + 70_000;
  const { review, unsubscribe } = await withImap(async (client) => {
    const folders = await client.list();
    const spam = folders.find((f) => f.specialUse === "\\Junk" || /^(inbox[./])?(spam|junk)/i.test(f.path))?.path;
    const sentPath = await folderFor(client, "\\Sent", /^(inbox[./])?sent/i);

    const sent = sentPath ? await scanSent(client, sentPath, since, deadline) : { repliedTo: new Set<string>(), lastWrote: new Map<string, number>() };
    const inbound = [
      ...(await scanFolder(client, "INBOX", since, deadline, me)),
      ...(spam ? await scanFolder(client, spam, since, deadline, me) : []),
    ];
    const partial = Date.now() > deadline;

    const handled = (m: Scanned) =>
      m.answered || (m.messageId && sent.repliedTo.has(m.messageId)) || (sent.lastWrote.get(m.fromAddress) ?? 0) > m.date.getTime();

    // People: the latest message from each sender he hasn't answered.
    const bySender = new Map<string, Scanned[]>();
    for (const m of inbound.filter((m) => !m.bulk && !handled(m))) {
      bySender.set(m.fromAddress, [...(bySender.get(m.fromAddress) ?? []), m]);
    }
    const latest = [...bySender.values()]
      .map((list) => ({ m: list.sort((a, b) => b.date.getTime() - a.date.getTime())[0], more: list.length - 1 }))
      .sort((a, b) => b.m.date.getTime() - a.m.date.getTime())
      .slice(0, 60);

    // Previews, folder by folder.
    const previews = new Map<string, string>();
    for (const folder of new Set(latest.map((l) => l.m.folder))) {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = latest.filter((l) => l.m.folder === folder).map((l) => l.m.uid);
        for (const msg of await fetchMessages(client, uids, 300, folder)) previews.set(`${folder}:${msg.uid}`, msg.snippet);
      } finally {
        lock.release();
      }
    }
    const unanswered: ReviewItem[] = latest.map(({ m, more }) => ({
      from: m.fromName,
      fromAddress: m.fromAddress,
      to: m.to,
      subject: m.subject,
      date: m.date.toISOString(),
      messageId: m.messageId,
      snippet: previews.get(`${m.folder}:${m.uid}`) ?? "",
      folder: m.folder,
      unread: m.unread,
      more,
    }));

    // Bulk senders with three or more messages in the period, busiest first.
    const bulk = new Map<string, Scanned[]>();
    for (const m of inbound.filter((m) => m.bulk && m.folder === "INBOX")) bulk.set(m.fromAddress, [...(bulk.get(m.fromAddress) ?? []), m]);
    const unsubscribe = new Map<string, Unsubscribe>();
    const noisy: NoisySender[] = [...bulk.entries()]
      .filter(([, list]) => list.length >= 3)
      .map(([address, list]) => {
        const withLink = list.find((m) => m.unsubscribe.https || m.unsubscribe.mailto)?.unsubscribe ?? { oneClick: false };
        unsubscribe.set(address, withLink);
        return {
          name: list[0].fromName,
          address,
          count: list.length,
          unread: list.filter((m) => m.unread).length,
          unsubscribe: withLink.https && withLink.oneClick ? "one-click" : withLink.mailto ? "email" : withLink.https ? "link" : "none",
          link: withLink.https && !withLink.oneClick && !withLink.mailto ? withLink.https : undefined,
        } satisfies NoisySender;
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    return {
      review: { days, scanned: inbound.length, unanswered, noisy, partial, at: new Date().toISOString() },
      unsubscribe,
    };
  });
  cache = { at: Date.now(), review, unsubscribe };
  return { ...review, noisy: await markDone(review.noisy) };
}

async function markDone(noisy: NoisySender[]): Promise<NoisySender[]> {
  const done = await unsubscribedAlready().catch(() => new Map<string, "unsubscribed" | "archived">());
  return noisy.map((n) => (done.has(n.address) ? { ...n, done: done.get(n.address) } : n));
}

export function formatReview(r: MailReview, tz: string): string {
  const when = (d: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  const waiting = (d: string) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86_400_000));
  const people = r.unanswered.length
    ? r.unanswered
        .map(
          (m) =>
            `- ${when(m.date)} (${waiting(m.date)} days waiting)${m.folder !== "INBOX" ? ` [in ${m.folder}: check it's not spam]` : ""}${m.unread ? " [never opened]" : ""} from ${m.from} <${m.fromAddress}> to ${m.to || "?"}, subject "${m.subject}"${m.more ? ` (+${m.more} more unanswered from them)` : ""} [message-id ${m.messageId}]: ${m.snippet}`,
        )
        .join("\n")
    : "(None: every message from a person in this period got a reply.)";
  const noise = r.noisy.length
    ? r.noisy.map((n) => `- ${n.name} <${n.address}>: ${n.count} emails, ${n.unread} never opened`).join("\n")
    : "(No bulk sender sent three or more.)";
  return `INBOX REVIEW, last ${r.days} days: ${r.scanned} messages scanned${r.partial ? " (the scan ran out of time, so this is partial)" : ""}.

FROM PEOPLE, NOT ANSWERED (newest first; Sphere found no reply from Ricardo in Sent and no later email from him to them):
${people}

BULK SENDERS FILLING THE INBOX (Ricardo can unsubscribe or archive each from the review card under your reply):
${noise}

HOW TO ANSWER: Ricardo wants to see where he's missing out on business and revenue across his companies (Go Global, MI Group, Purpusly, Berris Group, Maggie Pam). Use the address each email was sent to and what it's about to place it under a company, or "Personal/other". Lead with the ones that could bring revenue, a deal, a partner or a deadline, oldest-waiting first within each, and say in a phrase why each matters. Treat cold sales pitches, vendors selling to him, and automated mail that slipped through as low priority: count them in one line rather than listing them. Some of these may have been answered by phone or from another account; say so as a caveat once, not per item. Then offer to draft replies, and draft the top three now as DRAFT blocks. Finish with one line on the bulk senders and point him to the card to clean them up.`;
}

// Unsubscribe from a bulk sender, or move its mail out of the inbox, after
// Ricardo confirms. The link comes from the scan, never from the browser.
export async function cleanUpSender(address: string, action: "unsubscribe" | "archive"): Promise<string> {
  const addr = address.trim().toLowerCase();
  if (isMock()) {
    await recordCleanup(addr, action === "archive" ? "archived" : "unsubscribed");
    return action === "archive" ? `Moved mail from ${addr} to Archive (mock).` : `Unsubscribed from ${addr} (mock).`;
  }
  if (action === "archive") {
    const moved = await withImap(async (client) => {
      const folders = await client.list();
      let archive = folders.find((f) => f.specialUse === "\\Archive" || /^(inbox[./])?archive$/i.test(f.path))?.path;
      if (!archive) archive = (await client.mailboxCreate("Archive")).path;
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ from: addr }, { uid: true })) || [];
        if (uids.length) await client.messageMove(uids, archive, { uid: true });
        return { count: uids.length, archive };
      } finally {
        lock.release();
      }
    });
    await recordCleanup(addr, "archived");
    if (cache) cache.at = 0;
    return `Moved ${moved.count} emails from ${addr} to ${moved.archive}. Nothing was deleted.`;
  }
  const how = cache?.unsubscribe.get(addr);
  if (!how) throw new Error("Run the inbox review again first; this sender isn't in the latest one.");
  if (how.https && how.oneClick) {
    const r = await fetch(how.https, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`The sender's unsubscribe page answered ${r.status}. Try again later or use the link in one of their emails.`);
  } else if (how.mailto) {
    const url = new URL(how.mailto);
    await sendEmail({
      to: decodeURIComponent(url.pathname),
      subject: url.searchParams.get("subject") || "unsubscribe",
      body: url.searchParams.get("body") || "Please unsubscribe me from this list.",
    });
  } else {
    throw new Error("This sender doesn't offer automatic unsubscribe. Archive their mail, or open one of their emails and use its link.");
  }
  await recordCleanup(addr, "unsubscribed");
  return `Unsubscribed from ${addr}. Some senders take a few days to stop.`;
}

async function recordCleanup(address: string, action: "unsubscribed" | "archived") {
  await db.query("INSERT INTO mail_cleanup (address, action) VALUES ($1, $2)", [address, action]);
}

function mockReview(days: number): Promise<MailReview> {
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  return markDone([
    { name: "Daily Deals", address: "deals@example.com", count: 22, unread: 21, unsubscribe: "one-click" },
    { name: "Trade Weekly", address: "news@example.org", count: 9, unread: 7, unsubscribe: "email" },
    { name: "Webinar Hub", address: "events@example.net", count: 5, unread: 5, unsubscribe: "link", link: "https://example.net/unsubscribe" },
  ]).then((noisy) => ({
    days,
    scanned: 412,
    partial: false,
    at: new Date().toISOString(),
    noisy,
    unanswered: [
      {
        from: "Vanessa Brown",
        fromAddress: "vanessa@example.com",
        to: "ricardo@example.com",
        subject: "King Tamer shipment to Kingston",
        date: ago(6),
        messageId: "<mock-3@example.com>",
        snippet: "Hi Ricardo, the distributor in Kingston wants pricing for 200 units by Friday. Can you send the landed cost?",
        folder: "INBOX",
        unread: false,
        more: 1,
      },
      {
        from: "Dana Reyes",
        fromAddress: "dana@example.org",
        to: "ricardo@example.com",
        subject: "Sponsoring the 2027 conference",
        date: ago(12),
        messageId: "<mock-4@example.org>",
        snippet: "We'd like to discuss a gold sponsorship for next year. Who should we talk to about packages?",
        folder: "INBOX",
        unread: true,
        more: 0,
      },
      {
        from: "Morgan Lee",
        fromAddress: "morgan@example.net",
        to: "ricardo@example.com",
        subject: "Partnership intro",
        date: ago(20),
        messageId: "<mock-5@example.net>",
        snippet: "A mutual contact suggested we connect about distribution in West Africa.",
        folder: "Spam",
        unread: true,
        more: 0,
      },
    ],
  }));
}
