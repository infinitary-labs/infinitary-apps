/**
 * The voice recognizer (docs/architecture.md section 8): whisper-large-v3-turbo
 * through transformers.js on the graphics card. Where ONNX Runtime's native
 * build lists a graphics provider it runs in the voice helper, a process of
 * its own, so its graphics work and memory stay out of the window and the
 * process that draws it; where the library ships no build (an Intel Mac) it
 * runs in a Web Worker in the window (`recognizerPlaceFor`).
 * Both run the settings and the handler below, so wherever the model runs
 * it runs the same files the same way, and both are held by a
 * `RecognizerClient`.
 */

import type { RecognizerPlace } from "./voice";

/** The model's id, and its folder under the models directory. */
export const WHISPER_MODEL_ID = "whisper-large-v3-turbo";

/** The sample rate Whisper expects: 16kHz mono. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** The pipeline: WebGPU, fp16 encoder and q4 merged decoder (the files the host downloads). */
export const WHISPER_PIPELINE_OPTIONS = {
  device: "webgpu",
  dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
} as const;

/**
 * Whisper's native window is 30 s; sliding 30 s windows with a 5 s stride
 * let longer clips transcribe (timestamps are required for the stitch).
 */
export const WHISPER_TRANSCRIBE_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: true,
} as const;

export type { RecognizerPlace };

/**
 * The graphics providers the voice helper runs Whisper on, in order of
 * preference. ONNX Runtime's native build lists the ones it carries
 * (`listSupportedBackends`), so where speech runs follows what the library
 * can do on this computer, never which system it is (docs/architecture.md
 * section 8, "Where speech runs"). WebGPU covers Apple silicon (Metal),
 * Linux x64 (Vulkan) and Windows; Windows' build also carries DirectML
 * (`dml`), which its own plan may add here.
 */
export const SPEECH_GPU_PROVIDERS = ["webgpu"] as const;
export type SpeechDevice = (typeof SPEECH_GPU_PROVIDERS)[number];

/** The provider the helper runs Whisper on, from those its library lists; null for none. */
export function speechDevice(providers: readonly string[]): SpeechDevice | null {
  return SPEECH_GPU_PROVIDERS.find((provider) => providers.includes(provider)) ?? null;
}

/**
 * Where this computer transcribes: nowhere without a graphics card, so
 * dictation hides rather than falling back to the processor (the captain's
 * answer for a computer with no suitable card); in the voice helper when its
 * speech library lists a graphics provider; otherwise in the window, whose
 * own graphics adapter then decides (`detectVoiceSupport`).
 */
export function recognizerPlaceFor(ability: {
  /** The providers the library lists here, or null where it has no build or could not say. */
  providers: readonly string[] | null;
  /** Whether this computer has a graphics card the library can run on. */
  graphicsCard: boolean;
}): RecognizerPlace {
  if (!ability.graphicsCard) return "none";
  return speechDevice(ability.providers ?? []) === null ? "window" : "helper";
}

/**
 * The voice helper's own question, apart from the recognizer's: what its
 * speech library can do on this computer, answered with the providers it
 * lists, or null where it has no build or failed to load.
 */
export type SpeechAbilityRequest = { id: number; type: "ability" };
export type SpeechAbilityResponse = { id: number; type: "ability"; providers: string[] | null };

/** Messages into a recognizer, keyed for replies. */
export type RecognizerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "transcribe"; audio: Float32Array };

/** Messages a recognizer sends back, keyed to the matching request. */
export type RecognizerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; text: string }
  | { id: number; type: "error"; message: string };

/** A loaded transformers.js speech pipeline: audio in, its output out. */
export type Transcriber = (
  audio: Float32Array,
  options: typeof WHISPER_TRANSCRIBE_OPTIONS,
) => Promise<unknown>;

function outputText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  const text = (first as { text?: unknown } | undefined)?.text ?? "";
  return String(text).trim();
}

/**
 * A recognizer's request handler. `load` builds the pipeline, or resolves
 * null when no weights are on disk: the voice controls can be ready without
 * them in development and in the end-to-end suite, and then `init` answers
 * ready and `transcribe` answers nothing, without opening a GPU device.
 * A miss is not kept, so weights downloaded later load on the next request.
 * Requests run one at a time, so a transcription waits for the warm-up pass
 * instead of sharing the device with it.
 */
export function createRecognizerHandler(
  load: () => Promise<Transcriber | null>,
): (request: RecognizerRequest) => Promise<RecognizerResponse> {
  let loading: Promise<Transcriber | null> | null = null;
  // The shader-compiling warm-up pass runs once per recognizer; init is
  // sent on every key press.
  let warmedUp = false;
  let queue: Promise<unknown> = Promise.resolve();

  const transcriber = () => {
    loading ??= load().then(
      (loaded) => {
        if (!loaded) loading = null;
        return loaded;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };

  const handle = async (request: RecognizerRequest): Promise<RecognizerResponse> => {
    try {
      const asr = await transcriber();
      if (request.type === "init") {
        // One pass on 0.5 s of silence compiles the shaders now, so the
        // first real transcription is not several times slower.
        if (asr && !warmedUp) {
          try {
            await asr(new Float32Array(WHISPER_SAMPLE_RATE / 2), WHISPER_TRANSCRIBE_OPTIONS);
          } catch {
            // Priming failed; the real call will surface any genuine problem.
          }
          warmedUp = true;
        }
        return { id: request.id, type: "ready" };
      }
      if (!asr) return { id: request.id, type: "result", text: "" };
      const output = await asr(request.audio, WHISPER_TRANSCRIBE_OPTIONS);
      return { id: request.id, type: "result", text: outputText(output) };
    } catch (error) {
      return {
        id: request.id,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return (request) => {
    const next = queue.then(() => handle(request));
    queue = next;
    return next;
  };
}

/** One running recognizer, as its client sees it. */
export type RecognizerConnection = {
  /** Sends a request; a transcription's audio may be moved rather than copied. */
  post: (request: RecognizerRequest) => void;
  /** Ends the recognizer and frees everything it holds. */
  stop: () => void;
};

/** Starts a recognizer whose replies and failure reach `events`. */
export type StartRecognizer = (events: {
  message: (response: RecognizerResponse) => void;
  failed: (error: Error) => void;
}) => RecognizerConnection;

/** How long a recognizer with nothing to do keeps its model loaded. */
export const RECOGNIZER_IDLE_MS = 3 * 60_000;

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void };

/**
 * Holds one recognizer: started on the first request, released after
 * `idleMs` with nothing pending so voice does not keep its model loaded
 * until quit, and started again on the next request. A failed recognizer
 * fails what it had pending and is replaced on the next request.
 */
export class RecognizerClient {
  private connection: RecognizerConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly start: StartRecognizer,
    private readonly idleMs = RECOGNIZER_IDLE_MS,
  ) {}

  /** Loads the model and primes WebGPU once per recognizer. Safe to call repeatedly. */
  warmUp(): Promise<void> {
    return this.send({ type: "init" }).then(() => undefined);
  }

  /** Transcribes 16 kHz mono PCM to text. */
  transcribe(audio: Float32Array): Promise<string> {
    return this.send({ type: "transcribe", audio });
  }

  /** Ends the recognizer now; anything pending fails with `error`. */
  release(error = new Error("Voice was turned off.")): void {
    this.cancelIdle();
    const connection = this.connection;
    this.connection = null;
    connection?.stop();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private releaseWhenIdle(): void {
    this.cancelIdle();
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const connection = this.connection;
      this.connection = null;
      connection?.stop();
    }, this.idleMs);
  }

  private ensure(): RecognizerConnection {
    if (this.connection) return this.connection;
    const holder: { connection: RecognizerConnection | null } = { connection: null };
    holder.connection = this.start({
      message: (response) => {
        if (this.connection !== holder.connection) return;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.type === "error") pending.reject(new Error(response.message));
        else if (response.type === "result") pending.resolve(response.text);
        else pending.resolve("");
        this.releaseWhenIdle();
      },
      failed: (error) => {
        if (this.connection !== holder.connection) return;
        this.release(error);
      },
    });
    this.connection = holder.connection;
    return holder.connection;
  }

  private send(
    request: { type: "init" } | { type: "transcribe"; audio: Float32Array },
  ): Promise<string> {
    this.cancelIdle();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ensure().post({ ...request, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        this.releaseWhenIdle();
      }
    });
  }
}
