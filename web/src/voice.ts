// Voice in and out using the browser's built-in speech services (Chrome and
// Safari), so phase 1 needs no separate voice provider.

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canListen = () => Boolean(recognitionCtor());
export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

export interface Listener {
  stop(): void;
}

// Listens until stop() is called (the second tap on the mic). onText receives the
// running transcript; onDone receives the final text, which may be empty.
export function listen(onText: (text: string) => void, onDone: (text: string) => void, onError: (msg: string) => void): Listener {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onError("This browser can't listen. Try Chrome or Safari.");
    return { stop() {} };
  }
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  // Keep listening through pauses; Ricardo taps the mic again to send.
  rec.continuous = true;
  let finalText = "";
  let interim = "";
  rec.onresult = (e) => {
    interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") onError(`Microphone error: ${e.error}`);
  };
  // Words still unconfirmed when the mic stops are kept, not dropped.
  rec.onend = () => onDone(`${finalText} ${interim}`.trim());
  rec.start();
  return { stop: () => rec.stop() };
}

// Text that reads badly aloud: source lists, links and markdown symbols.
function speakable(text: string) {
  return text
    .split(/\n\s*Sources?:/i)[0]
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/[*_#`>|]/g, "")
    .trim();
}

// Each seat gets its own consistent voice so you can tell them apart by ear.
function voiceFor(seatId: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith(navigator.language.slice(0, 2)) || v.lang.startsWith("en"));
  if (!voices.length) return undefined;
  let hash = 0;
  for (const ch of seatId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return voices[hash % voices.length];
}

// Replies are spoken one at a time, in order, so a Roundtable sounds like a
// conversation instead of everyone talking at once.
interface Line {
  text: string;
  seatId: string;
  // The seat's natural voice, fetched from the server as soon as the line is
  // queued so it's ready by its turn. The opening sentence is its own piece,
  // so it comes back in about a second and plays while the rest is made.
  // Undefined means use the browser's voice.
  segments?: Segment[];
}

interface Segment {
  text: string;
  url: Promise<string | undefined>;
  abort: AbortController;
}

// Natural voices come from the server when it has them set up; otherwise,
// and whenever a request fails, the browser's own speech is used.
let naturalVoices = false;
export function setNaturalVoices(on: boolean) {
  naturalVoices = on;
}

let player: HTMLAudioElement | null = null;

// Browsers (Safari above all) only let a page play sound it starts on its
// own once the person has clicked or typed on it. So every line plays through
// one shared audio element that the first click or keypress unlocks, and the
// browser's voice gets a silent first utterance at the same moment.
let shared: HTMLAudioElement | null = null;
let unlocked = false;
// Set when sound was blocked or stalled, so the app can say so.
let blocked = false;

function sharedPlayer() {
  if (!shared) shared = new Audio();
  return shared;
}

function silentClip() {
  const n = 800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function unlock() {
  if (unlocked || current) return;
  const el = sharedPlayer();
  el.src = silentClip();
  el.play()
    .then(() => {
      unlocked = true;
      if (blocked) {
        blocked = false;
        notify();
      }
    })
    .catch(() => undefined);
  if (canSpeak()) speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}
// How far the browser's voice has got through the current line, for progress().
let browserParts: string[] = [];
// Which piece of a natural-voice line is playing, for progress().
let segmentIndex = 0;
// Paused while Ricardo might be cutting in, until his words come back.
let paused = false;
let browserIndex = -1;

function fetchSegment(text: string, seatId: string): Segment {
  const abort = new AbortController();
  const url = fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, seatId }),
    signal: abort.signal,
  })
    .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : undefined))
    .catch(() => undefined);
  return { text, url, abort };
}

// The opening sentence or two (at least a few words, at most about 200
// characters), then the rest. Short replies stay in one piece.
function splitOpening(text: string): string[] {
  if (text.length < 250) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  let head = "";
  for (const sentence of sentences) {
    if (head.length >= 40 || head.length + sentence.length > 200) break;
    head += sentence;
  }
  if (!head || head.length >= text.length) return [text];
  return [head.trim(), text.slice(head.length).trim()];
}

function discard(line: Line | null) {
  if (!line) return;
  for (const seg of line.segments ?? []) {
    seg.abort.abort();
    seg.url.then((url) => url && URL.revokeObjectURL(url));
  }
}

function silence() {
  paused = false;
  if (player) {
    player.onended = null;
    player.onerror = null;
    player.pause();
    player = null;
  }
  speechSynthesis.cancel();
}

export interface SpeakingState {
  seatId: string | null;
  queued: number;
  // The browser blocked or stalled the sound; a click usually fixes it.
  blocked: boolean;
}

const queue: Line[] = [];
let current: Line | null = null;
let listeners: ((s: SpeakingState) => void)[] = [];
// Set by the Stop button: the rest of this turn stays quiet until Ricardo
// sends something new or taps Play.
let held = false;
// Bumped by stop and skip, so a line that was cut off doesn't start the next one twice.
let generation = 0;

function notify() {
  const state = { seatId: current?.seatId ?? null, queued: queue.length, blocked };
  for (const l of listeners) l(state);
}

export function onSpeaking(listener: (s: SpeakingState) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

// Chrome stops long utterances after about 15 seconds, so each line is
// spoken in sentence-sized pieces.
function chunks(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > 220 && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function playNext() {
  if (current || !queue.length) {
    notify();
    return;
  }
  const line = (current = queue.shift()!);
  notify();
  const gen = generation;
  const done = () => {
    if (gen !== generation) return;
    discard(line);
    current = null;
    playNext();
  };
  if (!line.segments) return browserSpeak(line, done);
  const segments = line.segments;
  // Each piece ends exactly once: by finishing, or by falling back to the
  // browser's voice for what's left if the audio can't play (a late error
  // must not replay it).
  const playSegment = (i: number) => {
    if (gen !== generation) return;
    if (i >= segments.length) return done();
    segmentIndex = i;
    const rest = () => segments.slice(i).map((seg) => seg.text).join(" ");
    segments[i].url.then((url) => {
      if (gen !== generation) return;
      if (!url) return browserSpeak(line, done, rest());
      let settled = false;
      let watch: ReturnType<typeof setInterval> | undefined;
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearInterval(watch);
        audio.onended = null;
        audio.onerror = null;
        return true;
      };
      const next = () => {
        if (settle()) playSegment(i + 1);
      };
      const fallBack = () => {
        if (gen !== generation || !settle()) return;
        audio.pause();
        if (player === audio) player = null;
        browserSpeak(line, done, rest());
      };
      const audio = (player = sharedPlayer());
      audio.onended = next;
      audio.onerror = fallBack;
      audio.src = url;
      // Autoplay can be refused (Safari, after a long wait); fall back rather than go silent.
      audio.play().catch(() => {
        if (paused) return;
        blocked = true;
        notify();
        fallBack();
      });
      // A play() that succeeds can still sit frozen at the start. If the audio
      // hasn't moved for four seconds, use the browser's voice; if it froze
      // part-way, move on. Nothing stays stuck on "speaking".
      let last = -1;
      let still = 0;
      watch = setInterval(() => {
        if (settled || gen !== generation) return clearInterval(watch);
        if (paused || audio.currentTime > last + 0.05) {
          last = Math.max(last, audio.currentTime);
          still = 0;
          return;
        }
        if (++still < 4) return;
        if (last < 0.3) {
          blocked = true;
          notify();
          fallBack();
        } else next();
      }, 1000);
    });
  };
  playSegment(0);
}

function browserSpeak(line: Line, done: () => void, text = speakable(line.text)) {
  const parts = chunks(text);
  browserParts = parts;
  browserIndex = -1;
  const voice = voiceFor(line.seatId);
  if (!parts.length) return done();
  // If the browser's voice never starts (blocked, or no voices installed),
  // move on after a few seconds; and never wait longer than the line could take.
  const gen = generation;
  let started = false;
  let finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    clearTimeout(noStart);
    clearTimeout(cap);
    done();
  };
  const noStart = setTimeout(() => {
    if (started || gen !== generation) return;
    blocked = true;
    notify();
    speechSynthesis.cancel();
    end();
  }, 4000);
  const words = parts.join(" ").split(/\s+/).length;
  // People speak about 2.5 words a second; allow a little more, then move on.
  const cap = setTimeout(() => gen === generation && end(), (words / 2.2 + 5) * 1000);
  parts.forEach((part, i) => {
    const utterance = new SpeechSynthesisUtterance(part);
    utterance.onstart = () => {
      started = true;
      browserIndex = i;
    };
    if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    if (i === parts.length - 1) {
      utterance.onend = end;
      utterance.onerror = end;
    }
    speechSynthesis.speak(utterance);
  });
}

// Adds a line to the end of the queue.
export function enqueueSpeech(text: string, seatId: string) {
  if (!canSpeak() || !text.trim() || held) return;
  const line: Line = { text, seatId };
  if (naturalVoices) line.segments = splitOpening(speakable(text)).map((t) => fetchSegment(t, seatId));
  queue.push(line);
  playNext();
}

// Drops whatever is playing or queued and says this instead.
export function speak(text: string, seatId: string) {
  stopSpeaking();
  held = false;
  enqueueSpeech(text, seatId);
}

// Cuts off the current speaker and moves on to the next one.
export function skipSpeaker() {
  if (!canSpeak()) return;
  generation++;
  discard(current);
  current = null;
  silence();
  playNext();
}

export function stopSpeaking() {
  if (!canSpeak()) return;
  generation++;
  discard(current);
  queue.splice(0).forEach(discard);
  current = null;
  silence();
  notify();
}

// Stop button: silence now and for the rest of this turn.
export function holdSpeech() {
  stopSpeaking();
  held = true;
}

// A new turn may speak again.
export function releaseSpeech() {
  held = false;
}

export const isSpeaking = () => current !== null;

// Roughly what Ricardo has heard of the line being spoken right now: the last
// stretch of it up to the current playback position.
export function progress(): { seatId: string; heard: string } | undefined {
  if (!current) return undefined;
  const words = speakable(current.text).split(/\s+/).filter(Boolean);
  let fraction = 0.5;
  const segs = current.segments;
  if (player && Number.isFinite(player.duration) && player.duration > 0) {
    const within = player.currentTime / player.duration;
    if (segs && segs.length > 1) {
      const total = segs.reduce((n, seg) => n + seg.text.length, 0);
      const before = segs.slice(0, segmentIndex).reduce((n, seg) => n + seg.text.length, 0);
      fraction = (before + within * (segs[segmentIndex]?.text.length ?? 0)) / total;
    } else fraction = within;
  } else if (browserParts.length) fraction = (browserIndex + 1) / browserParts.length;
  const upTo = Math.max(1, Math.round(words.length * Math.min(1, fraction)));
  return { seatId: current.seatId, heard: words.slice(Math.max(0, upTo - 60), upTo).join(" ") };
}

export interface LiveHandlers {
  // Ricardo started speaking (over the team, or into silence).
  onBargeIn(): void;
  // The running transcript of what he's saying.
  onHeard(text: string): void;
  // He finished a sentence (a pause of about 1.4 seconds).
  onUtterance(text: string): void;
  onError(message: string): void;
}

// Words that cut the team off on their own, before a full sentence.
const CUT_WORDS = /^(stop|wait|hold on|hang on|pause|quiet|enough|okay stop|ok stop)\b/i;

// The live table: the mic stays open, Ricardo can talk over the team to cut
// them off, and each sentence goes to the team when he pauses. The mic also
// hears the speakers, so while a seat is talking, words that mostly match
// what it's saying are ignored as its own echo (headphones avoid this).
export function liveListen(h: LiveHandlers): Listener {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    h.onError("This browser can't listen. Try Chrome or Safari.");
    return { stop() {} };
  }
  let active = true;
  let rec: Recognition | null = null;
  let finalText = "";
  let interim = "";
  let speaking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const isEcho = (said: string) => {
    if (!current) return false;
    const line = speakable(current.text).toLowerCase();
    const words = said.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    if (!words.length) return true;
    return words.filter((w) => line.includes(w)).length / words.length >= 0.7;
  };

  const flush = () => {
    const said = `${finalText} ${interim}`.trim();
    finalText = "";
    interim = "";
    speaking = false;
    if (said) h.onUtterance(said);
  };

  const start = () => {
    const r = (rec = new Ctor());
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += ` ${res[0].transcript}`;
        else interim += res[0].transcript;
      }
      const said = `${finalText} ${interim}`.trim();
      if (!said) return;
      if (!speaking) {
        // While a seat is talking, only a real cut-in counts: a stop word, or
        // two or more words that aren't the seat's own voice coming back.
        if (current && !CUT_WORDS.test(said) && (said.split(/\s+/).length < 2 || isEcho(said))) {
          finalText = "";
          interim = "";
          return;
        }
        speaking = true;
        h.onBargeIn();
      }
      h.onHeard(said);
      clearTimeout(timer);
      timer = setTimeout(flush, 1400);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        active = false;
        h.onError("Sphere isn't allowed to use the microphone. Allow it in the browser's site settings.");
      }
    };
    // Browsers end recognition after a while; keep the table listening.
    r.onend = () => {
      if (active) setTimeout(() => active && start(), 250);
    };
    r.start();
  };
  start();
  return {
    stop() {
      active = false;
      clearTimeout(timer);
      rec?.stop();
    },
  };
}

// Ricardo may be cutting in: hold the speaker where they are until his words
// come back, then either resume (it was noise or the speakers) or stop.
export function pauseSpeech() {
  if (!current || paused) return;
  paused = true;
  player?.pause();
  if (canSpeak()) speechSynthesis.pause();
}

export function resumeSpeech() {
  if (!paused) return;
  paused = false;
  player?.play().catch(() => undefined);
  if (canSpeak()) speechSynthesis.resume();
}

// Whether what the mic picked up is mostly the speaking seat's own words.
export function looksLikeEcho(said: string): boolean {
  if (!current) return false;
  const line = speakable(current.text).toLowerCase();
  const words = said.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (!words.length) return true;
  return words.filter((w) => line.includes(w)).length / words.length >= 0.7;
}
