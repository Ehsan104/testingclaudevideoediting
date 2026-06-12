import { TranscriptWord } from "../types";

const FILLERS = new Set(["um", "uh", "uhm", "erm", "hmm", "like", "basically", "actually"]);

export interface TranscribeUpdate {
  status: "decoding" | "loading-model" | "transcribing";
  progress?: number; // model download %, when known
}

const SAMPLE_RATE = 16000;

// Decode any browser-supported media file to 16 kHz mono PCM.
export async function decodeAudio(url: string): Promise<Float32Array> {
  const buf = await (await fetch(url)).arrayBuffer();
  const probeCtx = new AudioContext();
  const decoded = await probeCtx.decodeAudioData(buf);
  probeCtx.close();
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Real silence detection: RMS energy over 50 ms windows.
export function detectSilences(
  audio: Float32Array,
  minDuration = 0.8,
  threshold = 0.012
): { start: number; end: number }[] {
  const win = Math.floor(SAMPLE_RATE * 0.05);
  const out: { start: number; end: number }[] = [];
  let silentFrom: number | null = null;
  for (let i = 0; i < audio.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, audio.length);
    for (let j = i; j < end; j++) sum += audio[j] * audio[j];
    const rms = Math.sqrt(sum / (end - i));
    const t = i / SAMPLE_RATE;
    if (rms < threshold) {
      if (silentFrom === null) silentFrom = t;
    } else if (silentFrom !== null) {
      if (t - silentFrom >= minDuration) out.push({ start: silentFrom, end: t });
      silentFrom = null;
    }
  }
  if (silentFrom !== null && audio.length / SAMPLE_RATE - silentFrom >= minDuration) {
    out.push({ start: silentFrom, end: audio.length / SAMPLE_RATE });
  }
  return out;
}

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./whisperWorker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

let seq = 0;

export function transcribe(
  audio: Float32Array,
  onUpdate: (u: TranscribeUpdate) => void
): Promise<TranscriptWord[]> {
  const id = `job_${++seq}`;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "status") onUpdate({ status: msg.status });
      else if (msg.type === "progress") onUpdate({ status: "loading-model", progress: msg.progress });
      else if (msg.type === "result") {
        w.removeEventListener("message", onMessage);
        const words: TranscriptWord[] = [];
        for (const c of msg.chunks) {
          const text = String(c.text ?? "").trim();
          if (!text) continue;
          const start = Number(c.timestamp?.[0] ?? 0);
          const end = Number(c.timestamp?.[1] ?? start + 0.3);
          const bare = text.toLowerCase().replace(/[^a-z']/g, "");
          words.push({
            start,
            end: Number.isFinite(end) ? end : start + 0.3,
            text,
            isFiller: FILLERS.has(bare),
            speaker: "Speaker 1",
          });
        }
        resolve(words);
      } else if (msg.type === "error") {
        w.removeEventListener("message", onMessage);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener("message", onMessage);
    // copy so the buffer can be transferred without detaching caller state
    const copy = new Float32Array(audio);
    w.postMessage({ id, audio: copy }, [copy.buffer]);
  });
}
