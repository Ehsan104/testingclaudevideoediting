// Web Worker: runs Whisper (transformers.js) off the main thread.
// First use downloads the model from the Hugging Face CDN and caches it in
// the browser, so later sessions transcribe offline.
import { pipeline } from "@huggingface/transformers";

let asr: any = null;

// Word-level timestamps require a model exported with cross-attention
// outputs (the "_timestamped" exports). Keep the plain export as a backup —
// with it we fall back to segment timestamps below.
const MODEL_CANDIDATES = [
  "onnx-community/whisper-tiny.en_timestamped",
  "onnx-community/whisper-tiny.en",
];

// Some quantized variants fail to create an ONNX session depending on the
// onnxruntime-web build (e.g. q8 → missing DequantizeLinear scales). Try the
// smallest first and fall back to full precision, which always loads.
const DTYPE_CANDIDATES = ["q4", "fp32"] as const;

async function loadModel(id: string): Promise<any> {
  let lastErr: unknown = null;
  for (const model of MODEL_CANDIDATES) {
    for (const dtype of DTYPE_CANDIDATES) {
      try {
        return await pipeline("automatic-speech-recognition", model, {
          dtype,
          progress_callback: (p: any) => {
            if (p.status === "progress" && p.file?.endsWith(".onnx")) {
              self.postMessage({ type: "progress", id, progress: Math.round(p.progress ?? 0) });
            }
          },
        });
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

// Normalize segment-level chunks ("so the first thing", [3.2, 5.1]) into
// per-word chunks by distributing the segment span across its words.
function toWordChunks(chunks: any[]): any[] {
  const words: any[] = [];
  for (const c of chunks) {
    const parts = String(c.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1) {
      words.push(c);
      continue;
    }
    const s = Number(c.timestamp?.[0] ?? 0);
    const eRaw = Number(c.timestamp?.[1]);
    const e = Number.isFinite(eRaw) ? eRaw : s + parts.length * 0.35;
    const per = (e - s) / parts.length;
    parts.forEach((w, i) =>
      words.push({ text: w, timestamp: [s + i * per, s + (i + 1) * per] })
    );
  }
  return words;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, audio } = e.data as { id: string; audio: Float32Array };
  try {
    if (!asr) {
      self.postMessage({ type: "status", id, status: "loading-model" });
      asr = await loadModel(id);
    }
    self.postMessage({ type: "status", id, status: "transcribing" });
    const opts = { chunk_length_s: 30, stride_length_s: 5 };
    let chunks: any[];
    try {
      const out = await asr(audio, { ...opts, return_timestamps: "word" });
      chunks = out.chunks ?? [];
    } catch {
      // model without cross-attentions: use segment timestamps instead
      const out = await asr(audio, { ...opts, return_timestamps: true });
      chunks = toWordChunks(out.chunks ?? []);
    }
    self.postMessage({ type: "result", id, chunks });
  } catch (err: any) {
    self.postMessage({ type: "error", id, message: String(err?.message ?? err) });
  }
};
