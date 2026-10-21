import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRecognizerHandler,
  type NextTokenScores,
  RECOGNIZER_IDLE_MS,
  RecognizerClient,
  type RecognizerRequest,
  type RecognizerResponse,
  type StartRecognizer,
  type Transcriber,
  WHISPER_SAMPLE_RATE,
  WHISPER_TRANSCRIBE_OPTIONS,
  type WhisperTokens,
  type WhisperTranscribeOptions,
} from "./voiceRecognizer";

/**
 * Whisper's special tokens as the pinned model revision's
 * generation_config.json numbers them (VOICE_MODEL_REVISION in
 * src/main/voice/voiceModelService.ts), its languages cut to those the
 * readings below name.
 */
const PINNED_TOKENS = {
  decoder_start_token_id: 50258,
  lang_to_id: { "<|en|>": 50259, "<|zh|>": 50260, "<|ko|>": 50264, "<|ja|>": 50266 },
  task_to_id: { translate: 50359, transcribe: 50360 },
} satisfies WhisperTokens;

/** The pinned model's vocabulary size (its config.json). */
const PINNED_VOCABULARY = 51_866;

/**
 * The pinned model's four highest next-token scores after
 * <|startoftranscript|>, read on a 19 s Mandarin recording spoken by
 * macOS's Tingting voice (INF-608): every one a language, <|zh|> far ahead.
 */
const MANDARIN_READINGS = { "<|zh|>": 17.64, "<|en|>": 10.89, "<|ja|>": 9.81, "<|ko|>": 8.9 };

/**
 * A Whisper pipeline whose words come from `transcribe` and whose model
 * answers each request greedily from `readings` after the request's own
 * logits processors, as transformers.js's `generate` does. `heard` keeps
 * each request: how much audio it read, its prompt and its length.
 */
function whisperHearing(
  transcribe: (audio: Float32Array, options: WhisperTranscribeOptions) => Promise<unknown>,
  readings: Partial<Record<keyof typeof PINNED_TOKENS.lang_to_id, number>> = MANDARIN_READINGS,
) {
  const heard: Array<{ samples: number; prompt: number[]; steps: number }> = [];
  const asr: Transcriber = Object.assign(transcribe, {
    processor: async (audio: Float32Array) => ({ input_features: audio }),
    model: {
      generation_config: PINNED_TOKENS,
      generate: async (request: Parameters<Transcriber["model"]["generate"]>[0]) => {
        heard.push({
          samples: (request.inputs as Float32Array).length,
          prompt: request.decoder_input_ids,
          steps: request.max_new_tokens,
        });
        const row = new Float32Array(PINNED_VOCABULARY);
        for (const [token, score] of Object.entries(readings)) {
          row[PINNED_TOKENS.lang_to_id[token as keyof typeof readings]] = score;
        }
        let scores: NextTokenScores = [{ data: row }];
        for (const process of request.logits_processor) {
          scores = process([request.decoder_input_ids], scores);
        }
        const chooseFrom = scores[0]?.data ?? row;
        let chosen = 0;
        for (let token = 1; token < chooseFrom.length; token++) {
          if ((chooseFrom[token] ?? 0) > (chooseFrom[chosen] ?? 0)) chosen = token;
        }
        return { tolist: () => [[...request.decoder_input_ids, chosen]] };
      },
    },
  });
  return { asr, heard };
}

/** A recognizer the test answers by hand, one per start. */
class FakeRecognizers {
  started: Array<{
    sent: RecognizerRequest[];
    stopped: boolean;
    reply: (index: number, response?: Partial<RecognizerResponse>) => void;
    fail: (error: Error) => void;
  }> = [];

  start: StartRecognizer = (events) => {
    const sent: RecognizerRequest[] = [];
    const recognizer = {
      sent,
      stopped: false,
      reply: (index: number, response: Partial<RecognizerResponse> = { type: "ready" }) =>
        events.message({ id: sent[index]?.id ?? -1, ...response } as RecognizerResponse),
      fail: (error: Error) => events.failed(error),
    };
    this.started.push(recognizer);
    return {
      post: (request) => sent.push(request),
      stop: () => {
        recognizer.stopped = true;
      },
    };
  };
}

describe("RecognizerClient", () => {
  let recognizers: FakeRecognizers;
  beforeEach(() => {
    vi.useFakeTimers();
    recognizers = new FakeRecognizers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts on first use, keeps the warm recognizer, and releases it after three idle minutes", async () => {
    const client = new RecognizerClient(recognizers.start);
    expect(recognizers.started).toHaveLength(0);
    const first = client.warmUp();
    const recognizer = recognizers.started[0];
    recognizer?.reply(0);
    await first;
    vi.advanceTimersByTime(120_000);
    const second = client.warmUp();
    recognizer?.reply(1);
    await second;
    expect(recognizers.started).toHaveLength(1);
    vi.advanceTimersByTime(RECOGNIZER_IDLE_MS - 1);
    expect(recognizer?.stopped).toBe(false);
    vi.advanceTimersByTime(1);
    expect(recognizer?.stopped).toBe(true);
    const third = client.warmUp();
    expect(recognizers.started).toHaveLength(2);
    recognizers.started[1]?.reply(0);
    await third;
  });

  it("never releases a recognizer with work pending, and answers each request by its id", async () => {
    const client = new RecognizerClient(recognizers.start);
    const audio = new Float32Array([0.1, 0.2]);
    const words = client.transcribe(audio);
    const recognizer = recognizers.started[0];
    expect(recognizer?.sent[0]).toMatchObject({ type: "transcribe", audio });
    vi.advanceTimersByTime(10 * RECOGNIZER_IDLE_MS);
    expect(recognizer?.stopped).toBe(false);
    recognizer?.reply(0, { type: "result", text: "fix the login page" });
    await expect(words).resolves.toBe("fix the login page");
    vi.advanceTimersByTime(RECOGNIZER_IDLE_MS);
    expect(recognizer?.stopped).toBe(true);
  });

  it("fails what a broken recognizer had pending and starts a fresh one next time", async () => {
    const client = new RecognizerClient(recognizers.start);
    const words = client.transcribe(new Float32Array(4));
    recognizers.started[0]?.fail(new Error("The voice helper stopped working."));
    await expect(words).rejects.toThrow("The voice helper stopped working.");
    const again = client.warmUp();
    expect(recognizers.started).toHaveLength(2);
    recognizers.started[1]?.reply(0);
    await again;
  });

  it("passes a recognizer's own error to the request it answers", async () => {
    const client = new RecognizerClient(recognizers.start);
    const words = client.transcribe(new Float32Array(4));
    recognizers.started[0]?.reply(0, { type: "error", message: "no device" });
    await expect(words).rejects.toThrow("no device");
  });

  it("ignores a released recognizer's late replies and failure", async () => {
    const client = new RecognizerClient(recognizers.start);
    const words = client.transcribe(new Float32Array(4));
    const old = recognizers.started[0];
    client.release(new Error("Voice was turned off."));
    await expect(words).rejects.toThrow("Voice was turned off.");
    expect(old?.stopped).toBe(true);
    const next = client.transcribe(new Float32Array(4));
    old?.reply(0, { type: "result", text: "stale" });
    old?.fail(new Error("exited"));
    recognizers.started[1]?.reply(0, { type: "result", text: "fresh" });
    await expect(next).resolves.toBe("fresh");
  });
});

describe("createRecognizerHandler", () => {
  const transcribe = (id: number, audio = new Float32Array(16)): RecognizerRequest => ({
    id,
    type: "transcribe",
    audio,
  });

  it("answers ready and no words without weights, and looks for them again next time", async () => {
    const load = vi.fn(async (): Promise<Transcriber | null> => null);
    const handle = createRecognizerHandler(load);
    await expect(handle({ id: 1, type: "init" })).resolves.toEqual({ id: 1, type: "ready" });
    await expect(handle(transcribe(2))).resolves.toEqual({ id: 2, type: "result", text: "" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("runs a transcription only after the warm-up pass has finished", async () => {
    const order: string[] = [];
    let finishWarmUp!: () => void;
    const asr = vi.fn((audio: Float32Array) => {
      if (audio.length === WHISPER_SAMPLE_RATE / 2) {
        order.push("warm-up started");
        return new Promise<unknown>((resolve) => {
          finishWarmUp = () => {
            order.push("warm-up finished");
            resolve({ text: "" });
          };
        });
      }
      order.push("transcription");
      return Promise.resolve({ text: "words" });
    });
    const handle = createRecognizerHandler(async () => whisperHearing(asr).asr);
    const warm = handle({ id: 1, type: "init" });
    const words = handle(transcribe(2));
    await vi.waitFor(() => expect(order).toEqual(["warm-up started"]));
    finishWarmUp();
    await warm;
    await expect(words).resolves.toMatchObject({ text: "words" });
    expect(order).toEqual(["warm-up started", "warm-up finished", "transcription"]);
  });

  it("answers a failed load as an error and tries again on the next request", async () => {
    const load = vi
      .fn<() => Promise<Transcriber | null>>()
      .mockRejectedValueOnce(new Error("no adapter"))
      .mockResolvedValue(whisperHearing(async () => ({ text: "again" })).asr);
    const handle = createRecognizerHandler(load);
    await expect(handle(transcribe(1))).resolves.toEqual({
      id: 1,
      type: "error",
      message: "no adapter",
    });
    await expect(handle(transcribe(2))).resolves.toEqual({ id: 2, type: "result", text: "again" });
  });

  it("decodes a recording in the language Whisper hears in it, not the library's English (INF-608)", async () => {
    // A 40 s recording: its language comes from its first 30 s window, its words from all of it.
    const recording = new Float32Array(40 * WHISPER_SAMPLE_RATE);
    const words = vi.fn(async () => ({ text: "请帮我检查语音输入的效果。" }));
    const whisper = whisperHearing(words, MANDARIN_READINGS);
    const handle = createRecognizerHandler(async () => whisper.asr);
    await expect(handle(transcribe(1, recording))).resolves.toEqual({
      id: 1,
      type: "result",
      text: "请帮我检查语音输入的效果。",
    });
    expect(whisper.heard).toEqual([
      {
        samples: WHISPER_TRANSCRIBE_OPTIONS.chunk_length_s * WHISPER_SAMPLE_RATE,
        prompt: [PINNED_TOKENS.decoder_start_token_id],
        steps: 1,
      },
    ]);
    expect(words).toHaveBeenCalledWith(recording, {
      ...WHISPER_TRANSCRIBE_OPTIONS,
      decoder_input_ids: [
        PINNED_TOKENS.decoder_start_token_id,
        PINNED_TOKENS.lang_to_id["<|zh|>"],
        PINNED_TOKENS.task_to_id.transcribe,
      ],
    });
  });
});
