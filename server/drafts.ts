import { db } from "./db.js";

// The team proposes emails; nothing leaves until Ricardo taps Save or Send.
export type DraftStatus = "proposed" | "saved" | "sent" | "discarded";

export interface EmailDraft {
  id: number;
  turn_id: string;
  seat_id: string;
  to_addr: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  status: DraftStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedDraft {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}

// The instructions every final speaker gets when the mailbox is connected.
export const DRAFT_FORMAT = `EMAIL DRAFTS
When Ricardo asks you to write, answer or follow up on an email, or asks for outreach, write each email in its own block in exactly this format, after your reply:
[[DRAFT]]
To: Name <address>
Subject: the subject
In-Reply-To: <the message-id, only when replying to a message listed in his inbox>
---
the email body, signed as Ricardo
[[/DRAFT]]
Sphere shows each block to Ricardo as an email he can edit; nothing is sent until he taps Send. Don't paste the email into your reply as well; just say briefly what you drafted. Only include a block when an email is actually wanted, and never invent an address: if you don't know it, leave To: blank.`;

const BLOCK = /\[\[DRAFT\]\]([\s\S]*?)\[\[\/DRAFT\]\]/g;

// Pulls draft blocks out of a reply. Returns the reply with each block
// replaced by a short pointer, and the drafts themselves.
export function extractDrafts(text: string): { clean: string; drafts: ParsedDraft[] } {
  const drafts: ParsedDraft[] = [];
  const clean = text
    .replace(BLOCK, (_, inner: string) => {
      const [head, ...rest] = inner.split(/^\s*---\s*$/m);
      const field = (name: string) => head.match(new RegExp(`^\\s*${name}\\s*:(.*)$`, "im"))?.[1]?.trim() ?? "";
      const draft: ParsedDraft = {
        to: field("To"),
        subject: field("Subject"),
        body: rest.join("---").trim(),
        inReplyTo: field("In-Reply-To") || undefined,
      };
      if (draft.inReplyTo && !/^<.+>$/.test(draft.inReplyTo)) draft.inReplyTo = undefined;
      if (draft.body || draft.subject) drafts.push(draft);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, drafts };
}

export async function storeDrafts(turnId: string, seatId: string, drafts: ParsedDraft[]): Promise<EmailDraft[]> {
  const rows: EmailDraft[] = [];
  for (const d of drafts) {
    const { rows: inserted } = await db.query<EmailDraft>(
      `INSERT INTO email_drafts (turn_id, seat_id, to_addr, subject, body, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [turnId, seatId, d.to, d.subject, d.body, d.inReplyTo ?? null],
    );
    rows.push(inserted[0]);
  }
  return rows;
}

export async function listDrafts(): Promise<EmailDraft[]> {
  const { rows } = await db.query<EmailDraft>(
    "SELECT * FROM (SELECT * FROM email_drafts ORDER BY id DESC LIMIT 100) t ORDER BY id",
  );
  return rows;
}

export async function getDraft(id: number): Promise<EmailDraft | undefined> {
  const { rows } = await db.query<EmailDraft>("SELECT * FROM email_drafts WHERE id = $1", [id]);
  return rows[0];
}

export async function editDraft(id: number, to: string, subject: string, body: string) {
  await db.query(
    "UPDATE email_drafts SET to_addr = $2, subject = $3, body = $4, updated_at = NOW() WHERE id = $1 AND status IN ('proposed', 'saved')",
    [id, to, subject, body],
  );
}

export async function setDraftStatus(id: number, status: DraftStatus, error: string | null = null) {
  await db.query("UPDATE email_drafts SET status = $2, error = $3, updated_at = NOW() WHERE id = $1", [id, status, error]);
}
