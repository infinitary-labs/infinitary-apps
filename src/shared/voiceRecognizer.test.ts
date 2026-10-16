import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRecognizerHandler,
  RECOGNIZER_IDLE_MS,
  RecognizerClient,
  type RecognizerRequest,
  type RecognizerResponse,
  type StartRecognizer,
  type Transcriber,
  WHISPER_SAMPLE_RATE,
} from "./voiceRecognizer";

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
    const handle = createRecognizerHandler(async () => asr as Transcriber);
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
      .mockResolvedValue((async () => ({ text: "again" })) as Transcriber);
    const handle = createRecognizerHandler(load);
    await expect(handle(transcribe(1))).resolves.toEqual({
      id: 1,
      type: "error",
      message: "no adapter",
    });
    await expect(handle(transcribe(2))).resolves.toEqual({ id: 2, type: "result", text: "again" });
  });
});
