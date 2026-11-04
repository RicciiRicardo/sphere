import { db } from "./db.js";

export async function getSetting(key: string): Promise<string | undefined> {
  const { rows } = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string) {
  await db.query(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value],
  );
}

// The email kill switch. On by default once the mailbox is configured; when
// off, no seat reads the inbox and no draft can be saved or sent.
export async function emailEnabled(): Promise<boolean> {
  return (await getSetting("email_enabled")) !== "false";
}

export interface EmailAccessEntry {
  id: number;
  turn_id: string;
  seat_id: string;
  provider: string;
  model: string;
  items: number;
  created_at: string;
}

export async function logEmailAccess(turnId: string, seatId: string, provider: string, model: string, items: number) {
  await db.query(
    "INSERT INTO email_access_log (turn_id, seat_id, provider, model, items) VALUES ($1, $2, $3, $4, $5)",
    [turnId, seatId, provider, model, items],
  );
}

export async function recentEmailAccess(limit = 25): Promise<EmailAccessEntry[]> {
  const { rows } = await db.query<EmailAccessEntry>(
    "SELECT * FROM email_access_log ORDER BY id DESC LIMIT $1",
    [limit],
  );
  return rows;
}
