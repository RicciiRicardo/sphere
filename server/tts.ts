import { isMock, isProviderReady, openaiClient } from "./providers.js";

// Natural voices for read-aloud, from OpenAI's speech API with the existing
// OpenAI key. The browser's built-in speech stays as the fallback whenever
// this is off or a request fails. SPHERE_TTS=off turns it off.
const PREFERRED_MODEL = process.env.SPHERE_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
const FALLBACK_MODEL = "tts-1";
let workingModel: string | undefined;

export function ttsAvailable() {
  return !isMock() && process.env.SPHERE_TTS?.trim() !== "off" && isProviderReady("openai");
}

export function ttsInfo() {
  return { enabled: ttsAvailable(), model: workingModel ?? PREFERRED_MODEL };
}

// Each seat must be easy to tell apart by ear: three women's and three men's
// voices, alternating around the table, with different pace and manner.
// All are offered by both speech models, so a seat keeps its voice if the
// model falls back. Seats not listed get one of the rest, picked by their id.
const VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const SEAT_VOICES: Record<string, { voice: string; speed: number; style: string }> = {
  muse: {
    voice: "coral",
    speed: 1.0,
    style: "A warm, composed woman's voice, decisive and reassuring, like a trusted chief of staff giving a briefing.",
  },
  claude: {
    voice: "onyx",
    speed: 0.95,
    style: "A deep, measured man's voice, unhurried and thoughtful, like a senior strategist.",
  },
  perplexity: {
    voice: "nova",
    speed: 1.08,
    style: "A bright, crisp woman's voice, precise and matter-of-fact, like a researcher reporting findings.",
  },
  grok: {
    voice: "ash",
    speed: 1.15,
    style: "An energetic, fast-talking man's voice with a bit of edge, like someone sharing breaking news.",
  },
  chatgpt: {
    voice: "fable",
    speed: 1.0,
    style: "A friendly, expressive man's voice with a British accent, playful and conversational.",
  },
  gemini: {
    voice: "sage",
    speed: 0.92,
    style: "A calm, low, even woman's voice, careful and analytical, like an analyst walking through numbers.",
  },
};

function voiceFor(seatId: string) {
  const known = SEAT_VOICES[seatId];
  if (known) return known;
  const taken = new Set(Object.values(SEAT_VOICES).map((v) => v.voice));
  const free = VOICES.filter((v) => !taken.has(v));
  let hash = 0;
  for (const ch of seatId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { voice: free[hash % free.length], speed: 1.0, style: "Natural and conversational." };
}

async function synthesize(model: string, text: string, seatId: string): Promise<Buffer> {
  const { voice, speed, style } = voiceFor(seatId);
  const response = await openaiClient("openai").audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
    speed,
    // Only the newer model takes speaking-style instructions.
    ...(model === FALLBACK_MODEL ? {} : { instructions: style }),
  });
  return Buffer.from(await response.arrayBuffer());
}

// MP3 audio of the text in the seat's voice. Falls back to the older speech
// model once if the preferred one isn't available on this key.
export async function speech(text: string, seatId: string): Promise<Buffer> {
  const input = text.slice(0, 4000);
  if (workingModel) return synthesize(workingModel, input, seatId);
  try {
    const audio = await synthesize(PREFERRED_MODEL, input, seatId);
    workingModel = PREFERRED_MODEL;
    return audio;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 400 && status !== 404) throw err;
    console.error(`speech model ${PREFERRED_MODEL} unavailable, trying ${FALLBACK_MODEL}`, err);
    const audio = await synthesize(FALLBACK_MODEL, input, seatId);
    workingModel = FALLBACK_MODEL;
    return audio;
  }
}
