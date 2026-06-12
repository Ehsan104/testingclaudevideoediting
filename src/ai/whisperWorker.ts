// Web Worker: runs Whisper (transformers.js) off the main thread.
// First use downloads the model (~40 MB) from the Hugging Face CDN and
// caches it in the browser, so later sessions transcribe offline.
import { pipeline } from "@huggingface/transformers";

let asr: any = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, audio } = e.data as { id: string; audio: Float32Array };
  try {
    if (!asr) {
      self.postMessage({ type: "status", id, status: "loading-model" });
      asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        dtype: "q8",
        progress_callback: (p: any) => {
          if (p.status === "progress" && p.file?.endsWith(".onnx")) {
            self.postMessage({ type: "progress", id, progress: Math.round(p.progress ?? 0) });
          }
        },
      });
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
