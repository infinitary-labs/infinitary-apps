import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createRecognizerHandler,
  type RecognizerRequest,
  type RecognizerResponse,
  type SpeechAbilityRequest,
  type SpeechAbilityResponse,
  speechDevice,
  type Transcriber,
  WHISPER_MODEL_ID,
  WHISPER_PIPELINE_OPTIONS,
} from "@shared/voiceRecognizer";

/**
 * The voice helper's entry (docs/architecture.md section 8): Whisper in a
 * process of its own, an Electron utility process the main process starts
 * on the first recording and ends after three idle minutes
 * (./voiceHelper.ts). ONNX Runtime's native build runs the model here on the
 * graphics provider it lists (`speechDevice`), so its graphics work and
 * memory stay out of the window and out of the process that draws it. Asked
 * what that library can do (`SpeechAbilityRequest`), it answers the
 * providers it lists without opening a graphics device.
 *
 * The models directory arrives as the one argument; the weights are read
 * from disk there and nowhere else. Audio arrives in messages and leaves as
 * words; nothing here writes a file or opens a connection (D-13).
 * Entry-point only - it runs on load, so nothing imports it.
 */

const modelsDir = process.argv.length > 2 ? (process.argv.at(-1) ?? "") : "";

// This process never needs the network: refuse it before the model library
// loads, so nothing it does can reach out.
globalThis.fetch = () => Promise.reject(new Error("The voice helper has no network."));

type ParentPort = {
  postMessage: (message: RecognizerResponse | SpeechAbilityResponse) => void;
  on: (
    event: "message",
    listener: (event: { data: RecognizerRequest | SpeechAbilityRequest }) => void,
  ) => void;
};

/** The providers this computer's speech library lists, or null where it has no build or fails to load. */
async function libraryProviders(): Promise<string[] | null> {
  try {
    const { listSupportedBackends } = await import("onnxruntime-node");
    return listSupportedBackends().map((backend) => backend.name);
  } catch {
    return null;
  }
}

const handle = createRecognizerHandler(async () => {
  // Without weights there is nothing to load (development and the
  // end-to-end suite can show the voice controls without them), and the
  // GPU device is never opened.
  if (!existsSync(join(modelsDir, WHISPER_MODEL_ID, "config.json"))) return null;
  const device = speechDevice((await libraryProviders()) ?? []);
  if (!device) throw new Error("This computer's speech library cannot use its graphics card.");
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsDir;
  env.useFSCache = false;
  const asr = await pipeline("automatic-speech-recognition", WHISPER_MODEL_ID, {
    ...WHISPER_PIPELINE_OPTIONS,
    device,
  });
  return asr as unknown as Transcriber;
});

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
parentPort?.on("message", ({ data }) => {
  if (data.type === "ability") {
    void libraryProviders().then((providers) =>
      parentPort.postMessage({ id: data.id, type: "ability", providers }),
    );
    return;
  }
  void handle(data).then((response) => parentPort.postMessage(response));
});
