import { db } from "./db.js";
import { isProviderReady, type Provider } from "./providers.js";

export interface Seat {
  id: string;
  name: string;
  title: string;
  provider: Provider;
  model: string;
  role_card: string;
  enabled: boolean;
  is_chair: boolean;
  sort: number;
  // May this seat see Ricardo's inbox (and anything private that came from it)?
  email_access?: boolean;
}

export interface SeatView extends Seat {
  ready: boolean;
  // Share of rated answers Ricardo liked (smoothed), and how many he rated.
  record: number;
  rated: number;
}

export type TrackRecord = Record<string, { rate: number; rated: number }>;

// Laplace-smoothed approval rate, so a seat with no ratings starts at 50%
// and one lucky thumbs-up doesn't make it 100%.
export async function trackRecords(): Promise<TrackRecord> {
  const { rows } = await db.query<{ seat_id: string; up: number; total: number }>(
    `SELECT seat_id, COUNT(*) FILTER (WHERE verdict = 'up')::int AS up, COUNT(*)::int AS total
     FROM seat_feedback GROUP BY seat_id`,
  );
  return Object.fromEntries(rows.map((r) => [r.seat_id, { rate: (r.up + 1) / (r.total + 2), rated: r.total }]));
}

export async function rateAnswer(turnId: string, seatId: string, verdict: "up" | "down" | null) {
  if (verdict === null) {
    await db.query("DELETE FROM seat_feedback WHERE turn_id = $1 AND seat_id = $2", [turnId, seatId]);
    return;
  }
  await db.query(
    `INSERT INTO seat_feedback (turn_id, seat_id, verdict) VALUES ($1, $2, $3)
     ON CONFLICT (turn_id, seat_id) DO UPDATE SET verdict = EXCLUDED.verdict, created_at = NOW()`,
    [turnId, seatId, verdict],
  );
}

export async function listFeedback(): Promise<{ turn_id: string; seat_id: string; verdict: "up" | "down" }[]> {
  const { rows } = await db.query<{ turn_id: string; seat_id: string; verdict: "up" | "down" }>(
    "SELECT turn_id, seat_id, verdict FROM seat_feedback",
  );
  return rows;
}

// Starting lineup from the Sphere concept doc. Every field is editable in the
// app afterwards; these rows are only inserted when the seats table is empty.
const DEFAULT_SEATS: Seat[] = [
  {
    id: "claude",
    name: "Claude",
    title: "Chief of staff",
    provider: "anthropic",
    model: "claude-opus-5-5",
    role_card:
      "You own strategy, writing and decisions. When you chair the team, you merge your teammates' answers into one clear briefing for Ricardo: what matters, what to do next, and where the team disagrees.",
    enabled: true,
    is_chair: true,
    sort: 0,
  },
  {
    id: "muse",
    name: "Muse",
    title: "Muse seat",
    provider: "meta",
    model: "muse-spark-1.3",
    role_card:
      "Ricardo is training you as a chief of staff. Give a second view on priorities and plans, and say plainly when you see the situation differently from the rest of the team.",
    enabled: true,
    is_chair: false,
    sort: 1,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    title: "Researcher",
    provider: "perplexity",
    model: "fast",
    role_card:
      "You look things up: facts, prices, companies, regulations, market data. Always cite where each fact came from. If you can't verify something, say so.",
    enabled: true,
    is_chair: false,
    sort: 2,
  },
  {
    id: "grok",
    name: "Grok",
    title: "Pulse",
    provider: "xai",
    model: "grok-4.7",
    role_card:
      "You track what is happening right now: live news and the reaction on X. Speak up when something current affects Ricardo's plans.",
    enabled: true,
    is_chair: false,
    sort: 3,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    title: "Generalist",
    provider: "openai",
    model: "gpt-6.1-sol",
    role_card:
      "You brainstorm, give second opinions and handle quick tasks. When asked, challenge another seat's view and poke holes in plans.",
    enabled: true,
    is_chair: false,
    sort: 4,
  },
  {
    id: "gemini",
    name: "Gemini",
    title: "Analyst",
    provider: "google",
    model: "gemini-4-argon",
    role_card:
      "You dig into long material: documents, reports, spreadsheets, contracts and data. Pull out what matters, check the numbers, and flag anything that doesn't add up.",
    enabled: true,
    is_chair: false,
    sort: 5,
  },
];

// Seats added to the lineup after launch. Each is inserted once, so a seat
// Ricardo later removes stays removed.
const LATER_SEATS: Record<string, string> = { "seat:gemini": "gemini" };

// Ricardo's rule (Nov 4, 2026): only Mily (the Muse seat) and Claude may read
// his email. Applied once to existing installs; editable per seat afterwards.
const EMAIL_READERS = ["muse", "claude"];

async function insertSeat(s: Seat) {
  await db.query(
    `INSERT INTO seats (id, name, title, provider, model, role_card, enabled, is_chair, sort, email_access)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [s.id, s.name, s.title, s.provider, s.model, s.role_card, s.enabled, s.is_chair, s.sort, EMAIL_READERS.includes(s.id)],
  );
}

export async function seedSeats() {
  const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM seats");
  const fresh = rows[0].n === 0;
  if (fresh) for (const s of DEFAULT_SEATS) await insertSeat(s);
  for (const [key, id] of Object.entries(LATER_SEATS)) {
    const applied = await db.query("SELECT 1 FROM applied_seeds WHERE key = $1", [key]);
    if (applied.rows.length) continue;
    const seat = DEFAULT_SEATS.find((s) => s.id === id);
    if (seat && !fresh) await insertSeat(seat);
    await db.query("INSERT INTO applied_seeds (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
  }
  const rule = await db.query("SELECT 1 FROM applied_seeds WHERE key = 'email-access:v1'");
  if (!rule.rows.length) {
    await db.query("UPDATE seats SET email_access = (id = ANY($1))", [EMAIL_READERS]);
    await db.query("INSERT INTO applied_seeds (key) VALUES ('email-access:v1') ON CONFLICT DO NOTHING");
  }
}

export async function listSeats(): Promise<SeatView[]> {
  const [{ rows }, track] = await Promise.all([db.query<Seat>("SELECT * FROM seats ORDER BY sort, id"), trackRecords()]);
  return rows.map((s) => ({
    ...s,
    ready: s.enabled && isProviderReady(s.provider),
    record: track[s.id]?.rate ?? 0.5,
    rated: track[s.id]?.rated ?? 0,
  }));
}

export async function setChair(id: string) {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM seats WHERE id = $1", [id]);
  if (!rows.length) throw new Error(`No seat called ${id}`);
  await db.query("UPDATE seats SET is_chair = (id = $1)", [id]);
}

export async function updateSeat(
  id: string,
  patch: Partial<Pick<Seat, "name" | "title" | "model" | "role_card" | "enabled" | "email_access">>,
) {
  const editable = ["name", "title", "model", "role_card", "enabled", "email_access"];
  const fields = Object.entries(patch).filter(([k, v]) => editable.includes(k) && v !== undefined);
  if (!fields.length) return;
  const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE seats SET ${sets} WHERE id = $1`, [id, ...fields.map(([, v]) => v)]);
}

export async function addSeat(seat: Omit<Seat, "is_chair" | "sort" | "enabled">) {
  const { rows } = await db.query<{ n: number }>("SELECT COALESCE(MAX(sort), -1)::int + 1 AS n FROM seats");
  await db.query(
    `INSERT INTO seats (id, name, title, provider, model, role_card, enabled, is_chair, sort)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, FALSE, $7)`,
    [seat.id, seat.name, seat.title, seat.provider, seat.model, seat.role_card, rows[0].n],
  );
}

export async function removeSeat(id: string) {
  const { rows } = await db.query<{ is_chair: boolean }>("SELECT is_chair FROM seats WHERE id = $1", [id]);
  if (rows[0]?.is_chair) throw new Error("Move the chair to another seat before removing this one.");
  await db.query("DELETE FROM seats WHERE id = $1", [id]);
}
