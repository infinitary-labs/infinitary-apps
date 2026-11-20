import { RecognizerClient, type RecognizerPlace } from "@shared/voiceRecognizer";

/**
 * Where this window's recordings are transcribed (docs/architecture.md
 * section 8, "Where speech runs"). Where this computer's speech library can
 * use its graphics card the voice helper, a process of its own, holds the
 * model, and the window only hands it each recording; where it cannot, a Web
 * Worker in the window does; with no graphics card, nothing does. Asked once
 * per window.
 */
let place: Promise<RecognizerPlace> | null = null;

export function recognizerPlace(): Promise<RecognizerPlace> {
  place ??= window.infinitary.voice.recognizer().then(
    ({ where }) => where,
    () => "window" as const,
  );
  return place;
}

/** The in-window recognizer: a Web Worker started on first use and released after three idle minutes. */
const inWindow = new RecognizerClient((events) => {
  const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => events.message(event.data));
  worker.addEventListener("error", (event) => {
    events.failed(new Error(event.message || "The voice helper stopped working."));
  });
  return {
    // The prepared clip moves into the worker without a copy.
    post: (request) =>
      worker.postMessage(request, request.type === "transcribe" ? [request.audio.buffer] : []),
    stop: () => worker.terminate(),
  };
});

/** Loads the model and primes WebGPU once per recognizer. Safe to call repeatedly. */
export async function warmUpWhisper(): Promise<void> {
  if ((await recognizerPlace()) === "helper") {
    await window.infinitary.voice.warmUp();
    return;
  }
  await inWindow.warmUp();
}

/** Transcribes 16kHz mono PCM to text. */
export async function transcribeAudio(audio: Float32Array): Promise<string> {
  if ((await recognizerPlace()) === "helper") {
    return (await window.infinitary.voice.transcribe(audio)).text;
  }
  return inWindow.transcribe(audio);
}
