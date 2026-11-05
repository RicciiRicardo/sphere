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
  // queued so it's ready by its turn. Undefined means use the browser's voice.
  audio?: Promise<string | undefined>;
  abort?: AbortController;
}

// Natural voices come from the server when it has them set up; otherwise,
// and whenever a request fails, the browser's own speech is used.
let naturalVoices = false;
export function setNaturalVoices(on: boolean) {
  naturalVoices = on;
}

let player: HTMLAudioElement | null = null;

function fetchAudio(line: Line): Promise<string | undefined> {
  line.abort = new AbortController();
  return fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: speakable(line.text), seatId: line.seatId }),
    signal: line.abort.signal,
  })
    .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : undefined))
    .catch(() => undefined);
}

function discard(line: Line | null) {
  if (!line) return;
  line.abort?.abort();
  line.audio?.then((url) => url && URL.revokeObjectURL(url));
}

function silence() {
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
  const state = { seatId: current?.seatId ?? null, queued: queue.length };
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
  if (!line.audio) return browserSpeak(line, done);
  line.audio.then((url) => {
    if (gen !== generation) return;
    if (!url) return browserSpeak(line, done);
    // Each line ends exactly once: by finishing, or by falling back to the
    // browser's voice if the audio can't play (a late error must not replay it).
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    const fallBack = () => {
      if (settled || gen !== generation) return;
      settled = true;
      if (player === audio) player = null;
      audio.pause();
      browserSpeak(line, done);
    };
    const audio = (player = new Audio(url));
    audio.onended = finish;
    audio.onerror = fallBack;
    // Autoplay can be refused (Safari, after a long wait); fall back rather than go silent.
    audio.play().catch(fallBack);
  });
}

function browserSpeak(line: Line, done: () => void) {
  const parts = chunks(speakable(line.text));
  const voice = voiceFor(line.seatId);
  if (!parts.length) return done();
  parts.forEach((part, i) => {
    const utterance = new SpeechSynthesisUtterance(part);
    if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    if (i === parts.length - 1) {
      utterance.onend = done;
      utterance.onerror = done;
    }
    speechSynthesis.speak(utterance);
  });
}

// Adds a line to the end of the queue.
export function enqueueSpeech(text: string, seatId: string) {
  if (!canSpeak() || !text.trim() || held) return;
  const line: Line = { text, seatId };
  if (naturalVoices) line.audio = fetchAudio(line);
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
