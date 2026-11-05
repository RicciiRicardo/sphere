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

// Voices both speech models offer, so a seat keeps its voice if the model
// falls back. Seats not listed get one picked from the rest by their id.
const VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const SEAT_VOICES: Record<string, { voice: string; style: string }> = {
  muse: { voice: "coral", style: "Warm, composed and decisive, like a trusted chief of staff giving a briefing." },
  claude: { voice: "sage", style: "Thoughtful and measured, like a strategist thinking out loud." },
  perplexity: { voice: "echo", style: "Clear and precise, like a researcher reporting findings." },
  grok: { voice: "ash", style: "Energetic and quick, like someone sharing breaking news." },
  chatgpt: { voice: "alloy", style: "Friendly and conversational, like a colleague brainstorming." },
  gemini: { voice: "shimmer", style: "Calm and analytical, like an analyst walking through the numbers." },
};

function voiceFor(seatId: string) {
  const known = SEAT_VOICES[seatId];
  if (known) return known;
  const taken = new Set(Object.values(SEAT_VOICES).map((v) => v.voice));
  const free = VOICES.filter((v) => !taken.has(v));
  let hash = 0;
  for (const ch of seatId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { voice: free[hash % free.length], style: "Natural and conversational." };
}

async function synthesize(model: string, text: string, seatId: string): Promise<Buffer> {
  const { voice, style } = voiceFor(seatId);
  const response = await openaiClient("openai").audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
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
