export type Provider = "anthropic" | "openai" | "xai" | "meta" | "perplexity" | "google";

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
  ready: boolean;
  record: number;
  rated: number;
  email_access?: boolean;
}

export type TurnMode = "auto" | "briefing" | "roundtable" | "pitch";

export interface Bid {
  seatId: string;
  plan: string;
  why: string;
  confidence: number;
  record: number;
  rated: number;
  score: number;
}

export interface EmailDraft {
  id: number;
  turn_id: string;
  seat_id: string;
  to_addr: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  status: "proposed" | "saved" | "sent" | "discarded";
  error: string | null;
}

export interface Connections {
  mail: { configured: boolean; account: string; enabled: boolean };
  calendar: { configured: boolean };
  engine: { provider: string; model: string; label: string };
  voice: { enabled: boolean; model: string };
}

export interface Feedback {
  turn_id: string;
  seat_id: string;
  verdict: "up" | "down";
}

export interface MemoryItem {
  id: number;
  kind: string;
  content: string;
  source: string;
  private?: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: number;
  turn_id: string;
  speaker: string;
  kind: string;
  content: string;
  private?: boolean;
  created_at: string;
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

export interface AppState {
  seats: Seat[];
  memory: MemoryItem[];
  messages: StoredMessage[];
  feedback: Feedback[];
  drafts: EmailDraft[];
  connections: Connections;
  emailLog: EmailAccessEntry[];
  mock: boolean;
  memoryKinds: string[];
  providers: Provider[];
}

export type TeamEvent =
  | { type: "turn"; turnId: string }
  | { type: "routing"; seats: string[]; reason: string; direct: boolean; mode?: TurnMode }
  | { type: "round"; round: number; label: string }
  | ({ type: "bid" } & Bid)
  | { type: "winner"; seatId: string; text: string }
  | { type: "thinking"; seatId: string }
  | { type: "seat"; seatId: string; text: string; round?: number }
  | { type: "seat_error"; seatId: string; error: string }
  | { type: "final"; seatId: string; text: string }
  | { type: "notice"; text: string }
  | { type: "memory"; added: MemoryItem[] }
  | { type: "draft"; draft: EmailDraft }
  | { type: "private"; seats: string[] }
  | { type: "done" };

export class AuthError extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401 && url !== "/api/login") throw new AuthError("login required");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  state: () => call<AppState>("/api/state"),
  login: (password: string) => call<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  updateSeat: (id: string, patch: Partial<Seat>) =>
    call<{ seats: Seat[] }>(`/api/seats/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  setChair: (id: string) => call<{ seats: Seat[] }>(`/api/seats/${id}/chair`, { method: "POST" }),
  addSeat: (seat: Pick<Seat, "name" | "title" | "provider" | "model" | "role_card">) =>
    call<{ seats: Seat[] }>("/api/seats", { method: "POST", body: JSON.stringify(seat) }),
  models: (provider: Provider) => call<{ models: string[]; error?: string }>(`/api/models/${provider}`),
  feedback: (turnId: string, seatId: string, verdict: "up" | "down" | null) =>
    call<{ seats: Seat[]; feedback: Feedback[] }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ turnId, seatId, verdict }),
    }),
  setEmailEnabled: (enabled: boolean) =>
    call<{ enabled: boolean }>("/api/email/enabled", { method: "POST", body: JSON.stringify({ enabled }) }),
  testConnections: () => call<{ mail: string; calendar: string }>("/api/connections/test"),
  editDraft: (id: number, to: string, subject: string, body: string) =>
    call<{ drafts: EmailDraft[] }>(`/api/drafts/${id}`, { method: "PUT", body: JSON.stringify({ to, subject, body }) }),
  draftAction: (id: number, action: "save" | "send" | "discard") =>
    call<{ drafts: EmailDraft[]; message?: string }>(`/api/drafts/${id}/${action}`, { method: "POST" }),
  removeSeat: (id: string) => call<{ seats: Seat[] }>(`/api/seats/${id}`, { method: "DELETE" }),
  addMemory: (kind: string, content: string) =>
    call<{ memory: MemoryItem[] }>("/api/memory", { method: "POST", body: JSON.stringify({ kind, content }) }),
  updateMemory: (id: number, kind: string, content: string) =>
    call<{ memory: MemoryItem[] }>(`/api/memory/${id}`, { method: "PUT", body: JSON.stringify({ kind, content }) }),
  setMemoryPrivate: (id: number, isPrivate: boolean) =>
    call<{ memory: MemoryItem[] }>(`/api/memory/${id}/private`, { method: "POST", body: JSON.stringify({ private: isPrivate }) }),
  deleteMemory: (id: number) => call<{ memory: MemoryItem[] }>(`/api/memory/${id}`, { method: "DELETE" }),
};

// Live table: Ricardo cut in while this seat was speaking, having heard about this much.
export interface Interruption {
  seatId: string;
  heard: string;
}

// Sends one message to the team and calls onEvent for each streamed event.
// Aborting the signal (Ricardo cutting in) stops the rest of the turn.
export async function sendTurn(
  text: string,
  mode: TurnMode,
  onEvent: (e: TeamEvent) => void,
  opts: { signal?: AbortSignal; interrupted?: Interruption } = {},
) {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode, interrupted: opts.interrupted }),
    signal: opts.signal,
  });
  if (res.status === 401) throw new AuthError("login required");
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as TeamEvent);
      }
    }
  }
}
