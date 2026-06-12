// Web Worker: runs Whisper (transformers.js) off the main thread.
// First use downloads the model from the Hugging Face CDN and caches it in
// the browser, so later sessions transcribe offline.
import { pipeline } from "@huggingface/transformers";

let asr: any = null;

// Some quantized variants fail to load depending on the onnxruntime-web
// build (e.g. q8 → "Missing required scale ... DequantizeLinear"). Try the
// smallest first and fall back to full precision, which always loads.
const DTYPE_CANDIDATES = ["q4", "fp32"] as const;

async function loadModel(id: string): Promise<any> {
  let lastErr: unknown = null;
  for (const dtype of DTYPE_CANDIDATES) {
    try {
      return await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
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
  throw lastErr;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, audio } = e.data as { id: string; audio: Float32Array };
  try {
    if (!asr) {
      self.postMessage({ type: "status", id, status: "loading-model" });
      asr = await loadModel(id);
    }
    self.postMessage({ type: "status", id, status: "transcribing" });
    const out = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: "word",
    });
    self.postMessage({ type: "result", id, chunks: out.chunks ?? [] });
  } catch (err: any) {
    self.postMessage({ type: "error", id, message: String(err?.message ?? err) });
  }
};
