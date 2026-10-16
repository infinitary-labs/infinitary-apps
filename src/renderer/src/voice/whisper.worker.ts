/// <reference types="vite/client" />
import { env, pipeline } from "@huggingface/transformers";
import {
  createRecognizerHandler,
  type RecognizerRequest,
  type RecognizerResponse,
  type Transcriber,
  WHISPER_MODEL_ID,
  WHISPER_PIPELINE_OPTIONS,
} from "@shared/voiceRecognizer";
// ORT's WebGPU build loads the asyncify wasm; we serve it locally (CSP
// blocks ORT's default CDN). Copied in by scripts/copy-ort-assets.mjs.
import asyncifyMjsUrl from "../generated/ort/ort-wasm-simd-threaded.asyncify.mjs?url";
import asyncifyWasmUrl from "../generated/ort/ort-wasm-simd-threaded.asyncify.wasm?url";

// The recognizer in the window, for a Mac where the voice helper cannot run
// (an Intel Mac: @shared/voiceRecognizer). Load the model only from the main
// process's on-disk copy, served over the app-model:// protocol - never the
// network (network-isolated worker).
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "app-model://model";
env.useBrowserCache = false;
// Skip transformers' wasm pre-fetch+blob caching: ORT points straight at
// the locally-bundled wasm/mjs so no blob: script eval is needed.
env.useWasmCache = false;

const onnxWasm = env.backends.onnx.wasm as {
  numThreads: number;
  proxy: boolean;
  wasmPaths: unknown;
};
// Single-threaded keeps us off SharedArrayBuffer (no cross-origin
// isolation) and avoids blob-URL workers; WebGPU does the heavy lifting.
onnxWasm.numThreads = 1;
onnxWasm.proxy = false;
onnxWasm.wasmPaths = { wasm: asyncifyWasmUrl, mjs: asyncifyMjsUrl };

/**
 * The weights live under `app-model://` only after a real download.
 * `INFINITARY_VOICE_MODEL_READY` makes the UI ready without those files, and
 * `pipeline()` asks for a WebGPU device before it notices they are missing.
 * Under a parallel Electron suite that device request has crashed the
 * renderer (phase1-shell, right-alt release, "Target crashed"). A 404 here
 * means there is nothing to load, so the hold-to-talk UI stays up and no
 * GPU pipeline starts.
 */
async function modelFilesOnDisk(): Promise<boolean> {
  try {
    const response = await fetch(`${env.localModelPath}/${WHISPER_MODEL_ID}/config.json`);
    return response.ok;
  } catch {
    return false;
  }
}

const handle = createRecognizerHandler(async () => {
  if (!(await modelFilesOnDisk())) return null;
  const asr = await pipeline(
    "automatic-speech-recognition",
    WHISPER_MODEL_ID,
    WHISPER_PIPELINE_OPTIONS,
  );
  return asr as unknown as Transcriber;
});

const ctx = self as unknown as {
  postMessage(message: RecognizerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RecognizerRequest>) => void,
  ): void;
};

ctx.addEventListener("message", (event) => {
  void handle(event.data).then((response) => ctx.postMessage(response));
});
