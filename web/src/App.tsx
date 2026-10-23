import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  AuthError,
  sendTurn,
  type AppState,
  type MemoryItem,
  type Provider,
  type Seat,
  type StoredMessage,
  type TeamEvent,
} from "./api";
import { canListen, canSpeak, listen, speak, stopSpeaking, type Listener } from "./voice";

interface Turn {
  id: string;
  userText: string;
  routing?: { seats: string[]; reason: string; direct: boolean };
  replies: { seatId: string; text?: string; error?: string }[];
  final?: { seatId: string; text: string };
  notices: string[];
  thinking: string[];
  live: boolean;
}

const SEAT_COLORS: Record<string, string> = {
  claude: "#d97757",
  muse: "#4f7cff",
  perplexity: "#20b8a6",
  grok: "#a0a4ad",
  chatgpt: "#10a37f",
};
const FALLBACK_COLORS = ["#c678dd", "#e5a03c", "#e06c75", "#56b6c2"];
const colorFor = (id: string, i = 0) => SEAT_COLORS[id] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];

const KIND_LABELS: Record<string, string> = {
  person: "People and organizations",
  project: "Projects",
  commitment: "Commitments",
  decision: "Decisions",
  preference: "Preferences",
  note: "Notes",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  meta: "Meta",
  perplexity: "Perplexity",
};

function turnsFromMessages(messages: StoredMessage[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const m of messages) {
    let t = turns.get(m.turn_id);
    if (!t) {
      t = { id: m.turn_id, userText: "", replies: [], notices: [], thinking: [], live: false };
      turns.set(m.turn_id, t);
    }
    if (m.kind === "user") t.userText = m.content;
    else if (m.kind === "routing") {
      try {
        t.routing = JSON.parse(m.content);
      } catch {
        /* ignore malformed rows */
      }
    } else if (m.kind === "seat") t.replies.push({ seatId: m.speaker, text: m.content });
    else if (m.kind === "error") t.replies.push({ seatId: m.speaker, error: m.content });
    else if (m.kind === "briefing") t.final = { seatId: m.speaker, text: m.content };
    else if (m.kind === "notice") t.notices.push(m.content);
  }
  // A seat spoken to by name answers on its own; its reply is the final one.
  for (const t of turns.values()) {
    if (!t.final && t.routing?.direct && t.replies.length === 1 && t.replies[0].text) {
      t.final = { seatId: t.replies[0].seatId, text: t.replies[0].text };
      t.replies = [];
    }
  }
  return [...turns.values()];
}

function applyEvent(turn: Turn, e: TeamEvent): Turn {
  switch (e.type) {
    case "routing":
      return { ...turn, routing: { seats: e.seats, reason: e.reason, direct: e.direct } };
    case "thinking":
      return { ...turn, thinking: [...turn.thinking, e.seatId] };
    case "seat":
      return {
        ...turn,
        thinking: turn.thinking.filter((id) => id !== e.seatId),
        replies: [...turn.replies, { seatId: e.seatId, text: e.text }],
      };
    case "seat_error":
      return {
        ...turn,
        thinking: turn.thinking.filter((id) => id !== e.seatId),
        replies: [...turn.replies, { seatId: e.seatId, error: e.error }],
      };
    case "final": {
      // A direct answer arrives as both "seat" and "final"; show it once.
      const replies = turn.routing?.direct ? turn.replies.filter((r) => r.seatId !== e.seatId) : turn.replies;
      return { ...turn, replies, thinking: turn.thinking.filter((id) => id !== e.seatId), final: { seatId: e.seatId, text: e.text } };
    }
    case "notice":
      return { ...turn, notices: [...turn.notices, e.text] };
    case "done":
      return { ...turn, live: false, thinking: [] };
    default:
      return turn;
  }
}

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(() => readPref("sphere.voice", true));
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"none" | "team" | "memory">("none");
  const [editing, setEditing] = useState<string | null>(null);
  const listener = useRef<Listener | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setTurns(turnsFromMessages(s.messages));
      setNeedsLogin(false);
    } catch (err) {
      if (err instanceof AuthError) setNeedsLogin(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const firstScroll = useRef(true);
  useEffect(() => {
    if (!turns.length) return;
    threadEnd.current?.scrollIntoView({ behavior: firstScroll.current ? "auto" : "smooth", block: "end" });
    firstScroll.current = false;
  }, [turns]);

  const seats = state?.seats ?? [];
  const seatById = useMemo(() => Object.fromEntries(seats.map((s) => [s.id, s])), [seats]);
  const liveTurn = turns.find((t) => t.live);

  const send = useCallback(
    async (text: string, mode: "auto" | "briefing" = "auto") => {
      const clean = text.trim();
      if (!clean || busy) return;
      setDraft("");
      setError("");
      setBusy(true);
      stopSpeaking();
      const placeholderId = `live-${Date.now()}`;
      setTurns((ts) => [
        ...ts,
        { id: placeholderId, userText: clean, replies: [], notices: [], thinking: [], live: true },
      ]);
      let currentId = placeholderId;
      try {
        await sendTurn(clean, mode, (e) => {
          if (e.type === "turn") {
            const fromId = currentId;
            currentId = e.turnId;
            setTurns((ts) => ts.map((t) => (t.id === fromId ? { ...t, id: e.turnId } : t)));
            return;
          }
          if (e.type === "memory") {
            setState((s) => (s ? { ...s, memory: [...e.added, ...s.memory] } : s));
            return;
          }
          if (e.type === "final" && voiceOn) speak(e.text, e.seatId);
          setTurns((ts) => ts.map((t) => (t.id === currentId ? applyEvent(t, e) : t)));
        });
        // A chair change happens on the server; refresh the roster.
        const fresh = await api.state();
        setState(fresh);
      } catch (err) {
        if (err instanceof AuthError) setNeedsLogin(true);
        else setError(err instanceof Error ? err.message : String(err));
        setTurns((ts) => ts.map((t) => (t.id === currentId ? { ...t, live: false, thinking: [] } : t)));
      } finally {
        setBusy(false);
      }
    },
    [busy, voiceOn],
  );

  const toggleMic = () => {
    if (listening) {
      listener.current?.stop();
      return;
    }
    stopSpeaking();
    setError("");
    setListening(true);
    listener.current = listen(
      (text) => setDraft(text),
      (finalText) => {
        setListening(false);
        listener.current = null;
        if (finalText) send(finalText);
      },
      (msg) => setError(msg),
    );
  };

  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    writePref("sphere.voice", next);
    if (!next) stopSpeaking();
  };

  if (needsLogin) return <Login onDone={load} />;
  if (!state) {
    return <div className="splash">{error ? <p className="error">{error}</p> : <div className="orb pulse" />}</div>;
  }

  const chair = seats.find((s) => s.is_chair);

  return (
    <div className={`app panel-${panel}`}>
      <header className="topbar">
        <div className="brand">
          <div className={`orb ${busy ? "pulse" : ""}`} />
          <span className="wide-only">Sphere</span>
          {state.mock && <span className="badge warn">Mock</span>}
        </div>
        <div className="actions">
          <button className="ghost mobile-only" onClick={() => setPanel(panel === "team" ? "none" : "team")}>
            Team
          </button>
          <button className="ghost mobile-only" onClick={() => setPanel(panel === "memory" ? "none" : "memory")}>
            Memory
          </button>
          {canSpeak() && (
            <button className={`ghost ${voiceOn ? "on" : ""}`} onClick={toggleVoice} title="Speak the team's replies aloud">
              {voiceOn ? "Voice" : "Muted"}
            </button>
          )}
          <button disabled={busy} onClick={() => send("Good morning, team.", "briefing")}>
            <span className="wide-only">Morning briefing</span>
            <span className="mobile-only">Briefing</span>
          </button>
        </div>
      </header>

      <aside className="team">
        <h2>The team</h2>
        {seats.map((s, i) => {
          const thinking = liveTurn?.thinking.includes(s.id);
          const routed = liveTurn?.routing?.seats.includes(s.id) || (liveTurn && s.is_chair);
          return (
            <button key={s.id} className={`seat ${s.enabled ? "" : "off"} ${thinking ? "thinking" : ""}`} onClick={() => setEditing(s.id)}>
              <span className="dot" style={{ background: colorFor(s.id, i) }} />
              <span className="seat-text">
                <span className="seat-name">
                  {s.name}
                  {s.is_chair && <span className="badge">Chair</span>}
                </span>
                <span className="seat-title">{s.title}</span>
                <span className="seat-status">
                  {!s.enabled ? "Benched" : !s.ready ? "Not connected" : thinking ? "Thinking…" : routed ? "On this one" : "Ready"}
                </span>
              </span>
            </button>
          );
        })}
        <button className="ghost add" onClick={() => setEditing("new")}>
          + Add a seat
        </button>
        <p className="hint">
          Say a name first to talk to one seat ("Grok, what's happening?"). Say "Muse, take the chair" to change who chairs.
        </p>
      </aside>

      <main className="thread">
        {turns.length === 0 && (
          <div className="empty">
            <div className="orb big" />
            <h1>Talk to your team</h1>
            <p>
              {chair ? `${chair.name} chairs. ` : ""}Speak or type to the whole team, or start with a name to talk to one seat.
              Tap Morning briefing to start your day.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} seatById={seatById} seats={seats} />
        ))}
        <div ref={threadEnd} />
      </main>

      <aside className="memory">
        <MemoryPanel
          memory={state.memory}
          kinds={state.memoryKinds}
          onChange={(memory) => setState({ ...state, memory })}
        />
      </aside>

      <footer className="composer">
        {error && <p className="error">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <textarea
            value={draft}
            placeholder={listening ? "Listening…" : "Talk to the team…"}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
          />
          {canListen() && (
            <button type="button" className={`mic ${listening ? "live" : ""}`} onClick={toggleMic} disabled={busy} title="Talk">
              {listening ? "Stop" : "Talk"}
            </button>
          )}
          <button type="submit" disabled={busy || !draft.trim()}>
            Send
          </button>
        </form>
      </footer>

      {editing && (
        <SeatEditor
          seat={editing === "new" ? undefined : seatById[editing]}
          providers={state.providers}
          onClose={() => setEditing(null)}
          onSaved={(seats) => {
            setState({ ...state, seats });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TurnView({ turn, seatById, seats }: { turn: Turn; seatById: Record<string, Seat>; seats: Seat[] }) {
  const name = (id: string) => seatById[id]?.name ?? id;
  const color = (id: string) => colorFor(id, Math.max(0, seats.findIndex((s) => s.id === id)));
  return (
    <section className="turn">
      <div className="you">{turn.userText}</div>
      {turn.routing && (
        <div className="routing">
          {turn.routing.seats.length ? `${turn.routing.seats.map(name).join(", ")}: ` : ""}
          {turn.routing.reason}
        </div>
      )}
      {turn.replies.map((r, i) => (
        <details key={`${r.seatId}-${i}`} className={`reply ${r.error ? "failed" : ""}`} style={{ borderColor: color(r.seatId) }}>
          <summary>
            <span className="dot" style={{ background: color(r.seatId) }} />
            {name(r.seatId)}
            <span className="muted">{r.error ? "couldn't answer" : seatById[r.seatId]?.title}</span>
          </summary>
          <div className="body">{r.error ?? r.text}</div>
        </details>
      ))}
      {turn.thinking.map((id) => (
        <div key={id} className="thinking-line">
          <span className="dot pulse" style={{ background: color(id) }} />
          {name(id)} is thinking…
        </div>
      ))}
      {turn.final && (
        <div className="final" style={{ borderColor: color(turn.final.seatId) }}>
          <div className="final-head">
            <span className="dot" style={{ background: color(turn.final.seatId) }} />
            {name(turn.final.seatId)}
            {seatById[turn.final.seatId]?.is_chair && <span className="badge">Chair</span>}
          </div>
          <div className="body">{turn.final.text}</div>
          <button className="ghost small" onClick={() => speak(turn.final!.text, turn.final!.seatId)}>
            Play
          </button>
        </div>
      )}
      {turn.notices.map((n, i) => (
        <div key={i} className="notice">
          {n}
        </div>
      ))}
    </section>
  );
}

function MemoryPanel({ memory, kinds, onChange }: { memory: MemoryItem[]; kinds: string[]; onChange: (m: MemoryItem[]) => void }) {
  const [kind, setKind] = useState("note");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const add = async () => {
    if (!text.trim()) return;
    try {
      const res = await api.addMemory(kind, text);
      onChange(res.memory);
      setText("");
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <h2>Team memory</h2>
      <p className="hint">Every seat works from this. The team adds to it as you talk; you can add or fix anything.</p>
      <div className="memory-add">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k] ?? k}
            </option>
          ))}
        </select>
        <textarea rows={2} value={text} placeholder="e.g. Investor call with Aubyn on Friday" onChange={(e) => setText(e.target.value)} />
        <button onClick={add} disabled={!text.trim()}>
          Add
        </button>
        {err && <p className="error">{err}</p>}
      </div>
      {kinds.map((k) => {
        const items = memory.filter((m) => m.kind === k);
        if (!items.length) return null;
        return (
          <div key={k} className="memory-group">
            <h3>{KIND_LABELS[k] ?? k}</h3>
            {items.map((m) =>
              editId === m.id ? (
                <div key={m.id} className="memory-item editing">
                  <textarea rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} />
                  <div className="row">
                    <button
                      className="small"
                      onClick={async () => {
                        onChange((await api.updateMemory(m.id, m.kind, editText)).memory);
                        setEditId(null);
                      }}
                    >
                      Save
                    </button>
                    <button className="ghost small" onClick={() => setEditId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="memory-item">
                  <p>{m.content}</p>
                  <div className="row">
                    <span className="muted">{m.source}</span>
                    <button
                      className="ghost small"
                      onClick={() => {
                        setEditId(m.id);
                        setEditText(m.content);
                      }}
                    >
                      Edit
                    </button>
                    <button className="ghost small" onClick={async () => onChange((await api.deleteMemory(m.id)).memory)}>
                      Remove
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        );
      })}
      {!memory.length && <p className="muted">Nothing yet. Tell the team what you're working on.</p>}
    </>
  );
}

function SeatEditor({
  seat,
  providers,
  onClose,
  onSaved,
}: {
  seat?: Seat;
  providers: Provider[];
  onClose: () => void;
  onSaved: (seats: Seat[]) => void;
}) {
  const [form, setForm] = useState({
    name: seat?.name ?? "",
    title: seat?.title ?? "",
    provider: seat?.provider ?? providers[0],
    model: seat?.model ?? "",
    role_card: seat?.role_card ?? "",
    enabled: seat?.enabled ?? true,
  });
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const run = async (fn: () => Promise<{ seats: Seat[] }>) => {
    try {
      onSaved((await fn()).seats);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{seat ? `${seat.name}'s seat` : "Add a seat"}</h2>
        {seat && !seat.ready && seat.enabled && (
          <p className="notice">Not connected: add the {PROVIDER_LABELS[seat.provider]} API key on the server to bring this seat online.</p>
        )}
        <label>
          Name
          <input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label>
          Role title
          <input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>
          Provider
          <select value={form.provider} disabled={Boolean(seat)} onChange={(e) => set("provider", e.target.value as Provider)}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model ID
          <input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. claude-opus-5-5" />
        </label>
        <label>
          Role card
          <textarea rows={5} value={form.role_card} onChange={(e) => set("role_card", e.target.value)} />
        </label>
        {seat && (
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            On the team (untick to bench this seat)
          </label>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row end">
          {seat && !seat.is_chair && (
            <button className="ghost" onClick={() => run(() => api.setChair(seat.id))}>
              Make chair
            </button>
          )}
          {seat && !seat.is_chair && (
            <button
              className="ghost danger"
              onClick={() => {
                if (confirm(`Remove ${seat.name} from the team?`)) run(() => api.removeSeat(seat.id));
              }}
            >
              Remove
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={() => run(() => (seat ? api.updateSeat(seat.id, form) : api.addSeat(form)))}>
            {seat ? "Save" : "Add seat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="splash">
      <form
        className="login"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(password);
            onDone();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          }
        }}
      >
        <div className="orb big" />
        <h1>Sphere</h1>
        <input type="password" autoFocus value={password} placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">Enter</button>
        {err && <p className="error">{err}</p>}
      </form>
    </div>
  );
}
