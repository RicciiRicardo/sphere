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
  current = queue.shift()!;
  notify();
  const gen = generation;
  const parts = chunks(speakable(current.text));
  const voice = voiceFor(current.seatId);
  const done = () => {
    if (gen !== generation) return;
    current = null;
    playNext();
  };
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
  queue.push({ text, seatId });
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
  current = null;
  speechSynthesis.cancel();
  playNext();
}

export function stopSpeaking() {
  if (!canSpeak()) return;
  generation++;
  queue.length = 0;
  current = null;
  speechSynthesis.cancel();
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
