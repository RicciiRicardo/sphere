// Ricardo's voice, recorded in the browser and transcribed on the server.
// The mic is opened with echo cancellation, the same processing video calls
// use, so the team's voices coming out of the speakers are filtered out
// before anything is transcribed. Start and end of speech are found from the
// sound level, so this works the same in Safari and Chrome.

export const canRecord = () =>
  typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

let stream: MediaStream | null = null;

async function openStream(): Promise<MediaStream> {
  if (stream?.active) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return stream;
}

function closeStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Chrome records webm; Safari records mp4. The server accepts either.
function recorderType() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

interface Take {
  stop(): Promise<Blob>;
  cancel(): void;
}

function startTake(s: MediaStream): Take {
  const type = recorderType();
  const recorder = new MediaRecorder(s, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" }));
        if (recorder.state !== "inactive") recorder.stop();
        else resolve(new Blob(chunks, { type: recorder.mimeType || type }));
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

// Transcription models sometimes "hear" a stock phrase in near-silence.
const PHANTOM = /^(thanks?( you)?( (so much|for watching))?|you|bye|okay|\.+)[.!]*$/i;

export async function transcribe(blob: Blob): Promise<string> {
  if (blob.size < 1000) return "";
  const r = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" },
    body: blob,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `Transcription failed (${r.status})`);
  }
  const text = String((await r.json()).text ?? "").trim();
  return PHANTOM.test(text) ? "" : text;
}

function micError(err: unknown) {
  const name = (err as { name?: string }).name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Sphere isn't allowed to use the microphone. Allow it in the browser's site settings.";
  return `Couldn't open the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

// The Talk button: record until stop(), then hand back the words.
export async function recordOnce(): Promise<{ stop(): Promise<string>; cancel(): void }> {
  let take: Take;
  try {
    take = startTake(await openStream());
  } catch (err) {
    throw new Error(micError(err));
  }
  return {
    stop: async () => {
      const blob = await take.stop();
      closeStream();
      return transcribe(blob);
    },
    cancel: () => {
      take.cancel();
      closeStream();
    },
  };
}

export interface LiveMicHandlers {
  // He started talking (the app pauses whoever is speaking).
  onSpeechStart(): void;
  // He stopped; his words are being transcribed.
  onSpeechEnd(): void;
  // His words, or "" if it was only noise.
  onText(text: string): void;
  onError(message: string): void;
  // While the team talks, a little of their voice can survive echo
  // cancellation, so it takes a louder, longer sound to count as him.
  teamSpeaking(): boolean;
}

// The live table: the mic stays open. Each stretch of speech, from when the
// sound rises above the room's background to about 1.2 seconds of quiet, is
// one sentence. A recording is always running, so the first syllable isn't
// lost; it restarts after each sentence and every 20 seconds of quiet.
export async function liveMic(h: LiveMicHandlers): Promise<{ stop(): void }> {
  let s: MediaStream;
  try {
    s = await openStream();
  } catch (err) {
    throw new Error(micError(err));
  }
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  await ctx.resume().catch(() => undefined);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(s).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const STEP = 50;
  let floor = 0.01;
  let speaking = false;
  let loudFor = 0;
  let quietFor = 0;
  let idleFor = 0;
  let take = startTake(s);

  const tick = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const level = Math.sqrt(sum / samples.length);
    const team = h.teamSpeaking();
    const threshold = Math.max(0.02, floor * 3) * (team ? 1.8 : 1);
    if (!speaking) {
      if (level > threshold) {
        loudFor += STEP;
        if (loudFor >= (team ? 300 : 150)) {
          speaking = true;
          quietFor = 0;
          h.onSpeechStart();
        }
      } else {
        loudFor = 0;
        // The background level drifts; follow it while it's quiet.
        floor = floor * 0.97 + level * 0.03;
        idleFor += STEP;
        if (idleFor >= 20_000) {
          idleFor = 0;
          take.cancel();
          take = startTake(s);
        }
      }
      return;
    }
    if (level < threshold * 0.7) {
      quietFor += STEP;
      if (quietFor < 1200) return;
      speaking = false;
      loudFor = 0;
      idleFor = 0;
      const finished = take;
      take = startTake(s);
      h.onSpeechEnd();
      finished
        .stop()
        .then(transcribe)
        .then((text) => h.onText(text))
        .catch((err) => {
          h.onText("");
          h.onError(err instanceof Error ? err.message : String(err));
        });
    } else quietFor = 0;
  }, STEP);

  return {
    stop() {
      clearInterval(tick);
      take.cancel();
      ctx.close().catch(() => undefined);
      closeStream();
    },
  };
}
