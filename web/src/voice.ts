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

export function speak(text: string, seatId: string) {
  if (!canSpeak()) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable(text));
  const voice = voiceFor(seatId);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (canSpeak()) speechSynthesis.cancel();
}
