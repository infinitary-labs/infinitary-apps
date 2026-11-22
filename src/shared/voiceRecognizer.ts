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

/**
 * A transcription's options: the settings above, and the prompt that names
 * the language the recording is decoded in (`languagePrompt`).
 */
export type WhisperTranscribeOptions = typeof WHISPER_TRANSCRIBE_OPTIONS & {
  decoder_input_ids?: number[];
};

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

export type RecognizerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "transcribe"; audio: Float32Array };

/** Messages a recognizer sends back, keyed to the matching request. */
export type RecognizerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; text: string }
  | { id: number; type: "error"; message: string };

/** Whisper's special tokens, from the model's `generation_config.json`. */
export type WhisperTokens = {
  /** <|startoftranscript|>. */
  decoder_start_token_id: number;
  /** One token per language Whisper knows, such as `<|zh|>`; none on an English-only model. */
  lang_to_id?: Record<string, number>;
  task_to_id?: Record<string, number>;
};

/** One row of next-token scores per sequence, as a logits processor sees them. */
export type NextTokenScores = { [row: number]: { data: Float32Array } | undefined };

/**
 * A loaded transformers.js speech pipeline, as far as the recognizer uses
 * it: audio in, its output out, and the processor and model beneath it.
 */
export type Transcriber = {
  (audio: Float32Array, options: WhisperTranscribeOptions): Promise<unknown>;
  /** Log-mel features of up to one 30 s window, as the model reads them. */
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: {
    generation_config: WhisperTokens | null;
    generate: (request: {
      inputs: unknown;
      decoder_input_ids: number[];
      max_new_tokens: number;
      logits_processor: Array<(inputIds: unknown[], scores: NextTokenScores) => NextTokenScores>;
    }) => Promise<{ tolist: () => Array<Array<bigint | number>> }>;
  };
};

function outputText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  const text = (first as { text?: unknown } | undefined)?.text ?? "";
  return String(text).trim();
}

/**
 * The prompt a recording is decoded with: <|startoftranscript|>, the
 * language Whisper hears in its first 30 s, and <|transcribe|>.
 * transformers.js leaves Whisper's language detection unimplemented and
 * decodes in English when it is named no language, which turned Mandarin
 * dictation into an English translation (INF-608). This is the detection
 * Whisper's own transcription runs: one decoder step after
 * <|startoftranscript|>, its choice limited to the language tokens. The
 * prompt carries the token itself, so a language the library has no name
 * for, such as Cantonese (<|yue|>), decodes too. Null for a model with no
 * language tokens, which decodes as it always has.
 */
async function languagePrompt(asr: Transcriber, audio: Float32Array): Promise<number[] | null> {
  const tokens = asr.model.generation_config;
  const transcribe = tokens?.task_to_id?.transcribe;
  const languages = new Set(Object.values(tokens?.lang_to_id ?? {}));
  if (!tokens || transcribe === undefined || languages.size === 0) return null;
  const window = audio.subarray(0, WHISPER_SAMPLE_RATE * WHISPER_TRANSCRIBE_OPTIONS.chunk_length_s);
  const { input_features } = await asr.processor(window);
  const onlyLanguages = (inputIds: unknown[], scores: NextTokenScores) => {
    for (let row = 0; row < inputIds.length; row++) {
      const data = scores[row]?.data;
      if (!data) continue;
      for (let token = 0; token < data.length; token++) {
        if (!languages.has(token)) data[token] = Number.NEGATIVE_INFINITY;
      }
    }
    return scores;
  };
  const sequences = await asr.model.generate({
    inputs: input_features,
    decoder_input_ids: [tokens.decoder_start_token_id],
    max_new_tokens: 1,
    logits_processor: [onlyLanguages],
  });
  const heard = Number(sequences.tolist()[0]?.at(-1));
  return languages.has(heard) ? [tokens.decoder_start_token_id, heard, transcribe] : null;
}

/** Words from `audio`, decoded in the language Whisper hears in it. */
async function recognize(asr: Transcriber, audio: Float32Array): Promise<unknown> {
  const prompt = await languagePrompt(asr, audio);
  return asr(
    audio,
    prompt
      ? { ...WHISPER_TRANSCRIBE_OPTIONS, decoder_input_ids: prompt }
      : WHISPER_TRANSCRIBE_OPTIONS,
  );
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
        // One pass on 0.5 s of silence, language detection included,
        // compiles the shaders now, so the first real transcription is not
        // several times slower.
        if (asr && !warmedUp) {
          try {
            await recognize(asr, new Float32Array(WHISPER_SAMPLE_RATE / 2));
          } catch {
            // Priming failed; the real call will surface any genuine problem.
          }
          warmedUp = true;
        }
        return { id: request.id, type: "ready" };
      }
      if (!asr) return { id: request.id, type: "result", text: "" };
      const output = await recognize(asr, request.audio);
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

export type RecognizerConnection = {
  /** Sends a request; a transcription's audio may be moved rather than copied. */
  post: (request: RecognizerRequest) => void;
  /** Ends the recognizer and frees everything it holds. */
  stop: () => void;
};

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
