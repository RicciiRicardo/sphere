import { toFile } from "openai";
import { isMock, isProviderReady, openaiClient } from "./providers.js";

// Speech to text for Talk and the live table, with OpenAI's transcription
// models on the existing OpenAI key. Far more accurate than the browser's own
// dictation (Safari's especially) with names and business terms. When it's
// off or fails, the browser's recognition is used. SPHERE_STT=off turns it off.
const MODELS = [process.env.SPHERE_STT_MODEL?.trim() || "gpt-transcribe", "gpt-4o-transcribe", "whisper-1"];
let workingModel: string | undefined;

export function sttAvailable() {
  return !isMock() && process.env.SPHERE_STT?.trim() !== "off" && isProviderReady("openai");
}

// Names the model should expect, so "Mily" doesn't come back as "Millie".
const VOCABULARY =
  "Ricardo Berris. Sphere. Team: Mily, Claude, Perplexity, Grok, ChatGPT, Gemini, Muse. Companies: Go Global, MI Group, Purpusly, Berris Group, Maggie Pam.";

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

async function transcribeWith(model: string, audio: Buffer, contentType: string): Promise<string> {
  const base = contentType.split(";")[0].trim();
  const file = await toFile(audio, `speech.${EXTENSIONS[base] ?? "webm"}`, { type: base });
  const result = await openaiClient("openai").audio.transcriptions.create({ model, file, prompt: VOCABULARY });
  return result.text.trim();
}

export async function transcribe(audio: Buffer, contentType: string): Promise<string> {
  const order = workingModel ? [workingModel] : MODELS;
  let lastError: unknown;
  for (const model of order) {
    try {
      const text = await transcribeWith(model, audio, contentType);
      workingModel = model;
      return text;
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      // Only a missing model is worth trying the next one for.
      if (status !== 400 && status !== 404) throw err;
      console.error(`transcription model ${model} unavailable`, err);
    }
  }
  throw lastError;
}
