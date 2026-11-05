import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  AuthError,
  sendTurn,
  type AppState,
  type Bid,
  type Connections,
  type EmailAccessEntry,
  type EmailDraft,
  type MemoryItem,
  type Provider,
  type Seat,
  type StoredMessage,
  type TeamEvent,
  type TurnMode,
} from "./api";
import { canListen, canSpeak, listen, speak, stopSpeaking, type Listener } from "./voice";

interface Turn {
  id: string;
  userText: string;
  routing?: { seats: string[]; reason: string; direct: boolean; mode?: TurnMode };
  replies: { seatId: string; text?: string; error?: string; round?: number }[];
  bids: Bid[];
  winner?: { seatId: string; text: string };
  final?: { seatId: string; text: string };
  notices: string[];
  thinking: string[];
  live: boolean;
  private?: boolean;
}

const SEAT_COLORS: Record<string, string> = {
  claude: "#d97757",
  muse: "#4f7cff",
  perplexity: "#20b8a6",
  grok: "#a0a4ad",
  chatgpt: "#10a37f",
  gemini: "#8e75ff",
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
  google: "Google",
};

function turnsFromMessages(messages: StoredMessage[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const m of messages) {
    let t = turns.get(m.turn_id);
    if (!t) {
      t = { id: m.turn_id, userText: "", replies: [], bids: [], notices: [], thinking: [], live: false };
      turns.set(m.turn_id, t);
    }
    if (m.private) t.private = true;
    if (m.kind === "user") t.userText = m.content;
    else if (m.kind === "routing") {
      try {
        t.routing = JSON.parse(m.content);
      } catch {
        /* ignore malformed rows */
      }
    } else if (m.kind === "seat") t.replies.push({ seatId: m.speaker, text: m.content });
    else if (m.kind === "rebuttal") t.replies.push({ seatId: m.speaker, text: m.content, round: 2 });
    else if (m.kind === "bid" || m.kind === "winner") {
      try {
        const v = JSON.parse(m.content);
        if (m.kind === "bid") t.bids.push(v);
        else t.winner = { seatId: v.seatId, text: v.note };
      } catch {
        /* ignore malformed rows */
      }
    }
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
      return { ...turn, routing: { seats: e.seats, reason: e.reason, direct: e.direct, mode: e.mode } };
    case "bid": {
      const { type: _type, ...bid } = e;
      return { ...turn, thinking: turn.thinking.filter((id) => id !== e.seatId), bids: [...turn.bids, bid] };
    }
    case "winner":
      return { ...turn, winner: { seatId: e.seatId, text: e.text } };
    case "private":
      return { ...turn, private: true };
    case "thinking":
      return { ...turn, thinking: [...turn.thinking, e.seatId] };
    case "seat":
      return {
        ...turn,
        thinking: turn.thinking.filter((id) => id !== e.seatId),
        replies: [...turn.replies, { seatId: e.seatId, text: e.text, round: e.round }],
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
  const [composeMode, setComposeMode] = useState<"auto" | "roundtable" | "pitch">("auto");
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
    async (text: string, mode: TurnMode = "auto") => {
      const clean = text.trim();
      if (!clean || busy) return;
      setDraft("");
      setError("");
      setBusy(true);
      stopSpeaking();
      const placeholderId = `live-${Date.now()}`;
      setTurns((ts) => [
        ...ts,
        { id: placeholderId, userText: clean, replies: [], bids: [], notices: [], thinking: [], live: true },
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
          if (e.type === "draft") {
            setState((s) => (s ? { ...s, drafts: [...s.drafts, e.draft] } : s));
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

  // Thumbs up/down on a seat's answer; tapping the same verdict again clears it.
  const rate = async (turnId: string, seatId: string, verdict: "up" | "down") => {
    if (!state) return;
    const current = state.feedback.find((f) => f.turn_id === turnId && f.seat_id === seatId)?.verdict;
    try {
      const res = await api.feedback(turnId, seatId, current === verdict ? null : verdict);
      setState((s) => (s ? { ...s, seats: res.seats, feedback: res.feedback } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const verdictFor = (turnId: string, seatId: string) =>
    state?.feedback.find((f) => f.turn_id === turnId && f.seat_id === seatId)?.verdict;

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
        if (finalText) {
          send(finalText, composeMode);
          setComposeMode("auto");
        }
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
                <span className="seat-title">
                  {s.title}
                  {s.email_access && <span title="May read your email"> · ✉️</span>}
                </span>
                {s.rated > 0 && (
                  <span className="seat-title">
                    Track record {Math.round(s.record * 100)}% · {s.rated} rated
                  </span>
                )}
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
          Say a name first to talk to one seat ("Grok, what's happening?"). "Team, debate this" starts a Roundtable; "Who wants this?" starts a Pitch. 👍/👎 on answers builds each seat's track record.
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
          <TurnView
            key={t.id}
            turn={t}
            seatById={seatById}
            seats={seats}
            busy={busy}
            verdictFor={verdictFor}
            onRate={rate}
            drafts={state.drafts.filter((d) => d.turn_id === t.id && d.status !== "discarded")}
            mailReady={state.connections.mail.configured}
            onDrafts={(drafts) => setState((s) => (s ? { ...s, drafts } : s))}
            onAssign={(seatId) => send(`${seatById[seatId]?.name ?? seatId}, you take this one. Go ahead with your plan.`)}
          />
        ))}
        <div ref={threadEnd} />
      </main>

      <aside className="memory">
        <ConnectionsBox
          connections={state.connections}
          log={state.emailLog}
          seatName={(id) => seatById[id]?.name ?? id}
          onToggle={(enabled) =>
            setState((s) => (s ? { ...s, connections: { ...s.connections, mail: { ...s.connections.mail, enabled } } } : s))
          }
        />
        <MemoryPanel
          memory={state.memory}
          kinds={state.memoryKinds}
          onChange={(memory) => setState({ ...state, memory })}
        />
      </aside>

      <footer className="composer">
        {error && <p className="error">{error}</p>}
        <div className="modes" role="radiogroup" aria-label="How the team answers">
          {(
            [
              ["auto", "Team", "The coordinator picks who answers; the chair merges"],
              ["roundtable", "Roundtable", "Every seat weighs in, then responds to the others"],
              ["pitch", "Pitch", "Seats bid for the task; the best bid does it"],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={composeMode === value}
              title={title}
              className={`ghost small ${composeMode === value ? "on" : ""}`}
              onClick={() => setComposeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft, composeMode);
            setComposeMode("auto");
          }}
        >
          <textarea
            value={draft}
            placeholder={
              listening
                ? "Listening…"
                : composeMode === "roundtable"
                  ? "What should the team debate?"
                  : composeMode === "pitch"
                    ? "What task should the seats pitch for?"
                    : "Talk to the team…"
            }
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft, composeMode);
                setComposeMode("auto");
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

function TurnView({
  turn,
  seatById,
  seats,
  busy,
  verdictFor,
  onRate,
  onAssign,
  drafts,
  mailReady,
  onDrafts,
}: {
  drafts: EmailDraft[];
  mailReady: boolean;
  onDrafts: (drafts: EmailDraft[]) => void;
  turn: Turn;
  seatById: Record<string, Seat>;
  seats: Seat[];
  busy: boolean;
  verdictFor: (turnId: string, seatId: string) => "up" | "down" | undefined;
  onRate: (turnId: string, seatId: string, verdict: "up" | "down") => void;
  onAssign: (seatId: string) => void;
}) {
  const name = (id: string) => seatById[id]?.name ?? id;
  const color = (id: string) => colorFor(id, Math.max(0, seats.findIndex((s) => s.id === id)));
  const saved = !turn.live && !turn.id.startsWith("live-");
  const rating = (seatId: string) =>
    saved && (
      <span className="rating">
        {(["up", "down"] as const).map((v) => (
          <button
            key={v}
            className={`ghost small ${verdictFor(turn.id, seatId) === v ? "on" : ""}`}
            title={v === "up" ? "Good answer: raises this seat's track record" : "Weak answer: lowers this seat's track record"}
            onClick={() => onRate(turn.id, seatId, v)}
          >
            {v === "up" ? "👍" : "👎"}
          </button>
        ))}
      </span>
    );
  const roundtable = turn.routing?.mode === "roundtable";
  const rounds = roundtable ? [1, 2] : [undefined];
  return (
    <section className="turn">
      <div className="you">{turn.userText}</div>
      {turn.private && (
        <div className="private-chip" title="This used your email. Only seats allowed to read email worked on it, and it stays hidden from the others.">
          🔒 Private: used your email
        </div>
      )}
      {turn.routing && (
        <div className="routing">
          {turn.routing.seats.length ? `${turn.routing.seats.map(name).join(", ")}: ` : ""}
          {turn.routing.reason}
        </div>
      )}
      {rounds.map((round) => {
        const replies = turn.replies.filter((r) => (roundtable ? (r.round ?? 1) === round : true));
        if (!replies.length) return null;
        return (
          <div key={round ?? "all"} className="round">
            {roundtable && <h3 className="round-label">{round === 1 ? "Opening views" : "Responses"}</h3>}
            {replies.map((r, i) => (
              <details
                key={`${r.seatId}-${i}`}
                className={`reply ${r.error ? "failed" : ""}`}
                style={{ borderColor: color(r.seatId) }}
                open={roundtable && !r.error}
              >
                <summary>
                  <span className="dot" style={{ background: color(r.seatId) }} />
                  {name(r.seatId)}
                  <span className="muted">{r.error ? "couldn't answer" : seatById[r.seatId]?.title}</span>
                </summary>
                <div className="body">{r.error ?? r.text}</div>
                {!r.error && r.round !== 2 && rating(r.seatId)}
              </details>
            ))}
          </div>
        );
      })}
      {turn.bids.length > 0 && (
        <div className="round">
          <h3 className="round-label">Bids</h3>
          {[...turn.bids]
            .sort((a, b) => b.score - a.score)
            .map((b) => {
              const won = turn.winner?.seatId === b.seatId;
              return (
                <div key={b.seatId} className={`bid ${won ? "won" : ""}`} style={{ borderColor: color(b.seatId) }}>
                  <div className="final-head">
                    <span className="dot" style={{ background: color(b.seatId) }} />
                    {name(b.seatId)}
                    {won && <span className="badge">Won</span>}
                    <span className="muted bid-score">
                      Confidence {b.confidence} · record {Math.round(b.record * 100)}%
                    </span>
                  </div>
                  <div className="body">{b.plan}</div>
                  {b.why && <div className="muted">{b.why}</div>}
                  {!won && saved && (
                    <button className="ghost small" disabled={busy} onClick={() => onAssign(b.seatId)}>
                      Give it to {name(b.seatId)}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
      {turn.winner && <div className="routing">{turn.winner.text}</div>}
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
          <div className="row">
            <button className="ghost small" onClick={() => speak(turn.final!.text, turn.final!.seatId)}>
              Play
            </button>
            {rating(turn.final.seatId)}
          </div>
        </div>
      )}
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} mailReady={mailReady} onDrafts={onDrafts} />
      ))}
      {turn.notices.map((n, i) => (
        <div key={i} className="notice">
          {n}
        </div>
      ))}
    </section>
  );
}

function ConnectionsBox({
  connections,
  log,
  seatName,
  onToggle,
}: {
  connections: Connections;
  log: EmailAccessEntry[];
  seatName: (id: string) => string;
  onToggle: (enabled: boolean) => void;
}) {
  const [result, setResult] = useState<{ mail: string; calendar: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const toggle = async () => {
    const next = !connections.mail.enabled;
    if (!next && !confirm("Switch off email access? No seat will read your inbox, and drafts can't be saved or sent, until you switch it back on.")) return;
    setSwitching(true);
    try {
      onToggle((await api.setEmailEnabled(next)).enabled);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div className="connections">
      <h2>Connections</h2>
      <p className="conn-line" title="Routes messages, judges Pitch bids and keeps the team memory">
        <span className="dot ok" />
        Engine: {connections.engine.label}
      </p>
      <p className="conn-line">
        <span className={`dot ${connections.mail.configured && connections.mail.enabled ? "ok" : "off"}`} />
        Email: {connections.mail.configured ? connections.mail.account : "not set up"}
        {connections.mail.configured && !connections.mail.enabled && <strong> (switched off)</strong>}
      </p>
      {connections.mail.configured && (
        <div className="row">
          <button className={`small ${connections.mail.enabled ? "danger-solid" : ""}`} disabled={switching} onClick={toggle}>
            {connections.mail.enabled ? "Switch email off" : "Switch email on"}
          </button>
          <button className="ghost small" onClick={() => setShowLog(!showLog)}>
            {showLog ? "Hide access log" : `Access log (${log.length})`}
          </button>
        </div>
      )}
      {showLog && (
        <ul className="access-log">
          {log.length === 0 && <li className="muted">No seat has read your email yet.</li>}
          {log.map((e) => (
            <li key={e.id}>
              {seatName(e.seat_id)} <span className="muted">({e.model})</span> read {e.items} items ·{" "}
              <span className="muted">{new Date(e.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="conn-line">
        <span className={`dot ${connections.calendar.configured ? "ok" : "off"}`} />
        Calendar: {connections.calendar.configured ? "iCloud" : "not set up"}
      </p>
      {(connections.mail.configured || connections.calendar.configured) && (
        <button
          className="ghost small"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            try {
              setResult(await api.testConnections());
            } catch (e) {
              setResult({ mail: e instanceof Error ? e.message : String(e), calendar: "" });
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Testing…" : "Test connections"}
        </button>
      )}
      {result && (
        <p className="muted">
          {result.mail}
          {result.calendar && (
            <>
              <br />
              {result.calendar}
            </>
          )}
        </p>
      )}
    </div>
  );
}

const DRAFT_STATUS: Record<EmailDraft["status"], string> = {
  proposed: "Draft for your review",
  saved: "Saved to your Drafts folder",
  sent: "Sent",
  discarded: "Discarded",
};

function DraftCard({ draft, mailReady, onDrafts }: { draft: EmailDraft; mailReady: boolean; onDrafts: (d: EmailDraft[]) => void }) {
  const [to, setTo] = useState(draft.to_addr);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(draft.error ?? "");
  const locked = draft.status === "sent" || draft.status === "discarded";
  const changed = to !== draft.to_addr || subject !== draft.subject || body !== draft.body;

  const act = async (action: "save" | "send" | "discard") => {
    if (action === "send" && !confirm(`Send this email to ${to}?`)) return;
    setBusy(true);
    setNote("");
    try {
      if (changed && action !== "discard") await api.editDraft(draft.id, to, subject, body);
      const res = await api.draftAction(draft.id, action);
      onDrafts(res.drafts);
      if (res.message) setNote(res.message);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`draft ${draft.status}`}>
      <div className="final-head">
        <span>✉️ Email</span>
        <span className="muted">{DRAFT_STATUS[draft.status]}</span>
      </div>
      <label>
        To
        <input value={to} disabled={locked} placeholder="name@company.com" onChange={(e) => setTo(e.target.value)} />
      </label>
      <label>
        Subject
        <input value={subject} disabled={locked} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <textarea rows={Math.min(14, body.split("\n").length + 2)} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
      {!locked && (
        <div className="row">
          {mailReady ? (
            <>
              <button className="small" disabled={busy || !/@/.test(to)} onClick={() => act("send")}>
                Send
              </button>
              {draft.status === "proposed" && (
                <button className="ghost small" disabled={busy} onClick={() => act("save")}>
                  Save to Drafts
                </button>
              )}
            </>
          ) : (
            <span className="muted">Connect your email to send or save this.</span>
          )}
          <button className="ghost small" disabled={busy} onClick={() => act("discard")}>
            Discard
          </button>
          <button className="ghost small" onClick={() => navigator.clipboard?.writeText(`To: ${to}\nSubject: ${subject}\n\n${body}`)}>
            Copy
          </button>
        </div>
      )}
      {note && <p className={note.startsWith("Couldn't") ? "error" : "muted"}>{note}</p>}
    </div>
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
        <textarea rows={2} value={text} placeholder="e.g. Investor call with Morgan on Friday" onChange={(e) => setText(e.target.value)} />
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
                  <p>
                    {m.private && <span title="From your email: only seats allowed to read email see this">🔒 </span>}
                    {m.content}
                  </p>
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
                    <button
                      className="ghost small"
                      title={
                        m.private
                          ? "Let every seat see this, not just the ones allowed to read your email"
                          : "Only seats allowed to read your email will see this"
                      }
                      onClick={async () => {
                        if (m.private && !confirm("Unlock this? Every seat on the team (including Grok, ChatGPT, Gemini and Perplexity) will be able to see it.")) return;
                        onChange((await api.setMemoryPrivate(m.id, !m.private)).memory);
                      }}
                    >
                      {m.private ? "Unlock" : "Lock"}
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
    email_access: seat?.email_access ?? false,
  });
  const [err, setErr] = useState("");
  const [models, setModels] = useState<{ list: string[]; note: string }>({ list: [], note: "" });
  useEffect(() => {
    let live = true;
    setModels({ list: [], note: "Loading available models…" });
    api
      .models(form.provider)
      .then((r) => {
        if (!live) return;
        const note = r.error
          ? `Couldn't list models: ${r.error}`
          : r.models.length
            ? `${r.models.length} models available on this key. Start typing to see them.`
            : "";
        setModels({ list: r.models, note });
      })
      .catch(() => live && setModels({ list: [], note: "" }));
    return () => {
      live = false;
    };
  }, [form.provider]);
  const modelMissing = models.list.length > 0 && form.model && !models.list.includes(form.model);
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
          <input list="model-options" value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. claude-opus-5-5" />
          <datalist id="model-options">
            {models.list.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelMissing && <span className="error">This key doesn't list "{form.model}". Pick one from the list.</span>}
          {models.note && <span className="muted">{models.note}</span>}
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
        {seat && (
          <label className="check">
            <input type="checkbox" checked={form.email_access} onChange={(e) => set("email_access", e.target.checked)} />
            May read your email (and private conversations and memory that came from it)
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
