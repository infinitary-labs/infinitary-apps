import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker extends EventTarget {
  static all: FakeWorker[] = [];
  sent: Array<{ id: number; type: string }> = [];
  postMessage = vi.fn((message: { id: number; type: string }) => this.sent.push(message));
  terminate = vi.fn();
  constructor() {
    super();
    FakeWorker.all.push(this);
  }
  reply(index: number, data: Record<string, unknown> = { type: "ready" }) {
    const message = this.sent[index];
    this.dispatchEvent(new MessageEvent("message", { data: { id: message?.id, ...data } }));
  }
}

function stubVoiceApi(where: Promise<{ where: "helper" | "window" }>) {
  const voice = {
    recognizer: vi.fn(() => where),
    warmUp: vi.fn(async () => ({ ok: true as const })),
    transcribe: vi.fn(async (_audio: Float32Array) => ({ text: "from the helper" })),
  };
  vi.stubGlobal("window", { infinitary: { voice } });
  return voice;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("where a recording is transcribed", () => {
  it("hands every recording to the voice helper and starts no worker in the window", async () => {
    const voice = stubVoiceApi(Promise.resolve({ where: "helper" }));
    const { warmUpWhisper, transcribeAudio } = await import("./whisperClient");
    await warmUpWhisper();
    const audio = new Float32Array([0.1, 0.2]);
    await expect(transcribeAudio(audio)).resolves.toBe("from the helper");
    expect(voice.warmUp).toHaveBeenCalledOnce();
    expect(voice.transcribe).toHaveBeenCalledWith(audio);
    expect(voice.recognizer).toHaveBeenCalledOnce();
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("keeps the recognizer in a window worker where the helper cannot run, moving PCM without a copy", async () => {
    const voice = stubVoiceApi(Promise.resolve({ where: "window" }));
    const { warmUpWhisper, transcribeAudio } = await import("./whisperClient");
    const init = warmUpWhisper();
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    const [worker] = FakeWorker.all;
    if (!worker) throw new Error("No worker was started.");
    worker.reply(0);
    await init;
    const audio = new Float32Array([0.1, 0.2]);
    const result = transcribeAudio(audio);
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "transcribe", audio }),
        [audio.buffer],
      ),
    );
    worker.reply(1, { type: "result", text: "from the window" });
    await expect(result).resolves.toBe("from the window");
    vi.advanceTimersByTime(180_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(voice.transcribe).not.toHaveBeenCalled();
  });

  it("falls back to the window when the question cannot be answered", async () => {
    stubVoiceApi(Promise.reject(new Error("no answer")));
    const { recognizerPlace } = await import("./whisperClient");
    await expect(recognizerPlace()).resolves.toBe("window");
  });
});

describe("voice support", () => {
  function stubCapture(requestAdapter: () => Promise<unknown>) {
    class AudioContextStub {}
    Object.defineProperty(AudioContextStub.prototype, "audioWorklet", { value: {} });
    vi.stubGlobal("AudioContext", AudioContextStub);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => undefined },
      gpu: { requestAdapter: vi.fn(requestAdapter) },
    });
    return (navigator as unknown as { gpu: { requestAdapter: ReturnType<typeof vi.fn> } }).gpu;
  }

  it("asks the window for no WebGPU adapter when the voice helper runs the model", async () => {
    const gpu = stubCapture(async () => null);
    const { detectVoiceSupport } = await import("./voiceInput");
    await expect(detectVoiceSupport("helper")).resolves.toBe(true);
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
  });

  it("hides voice when the window's own recognizer has no WebGPU adapter", async () => {
    stubCapture(async () => null);
    const { detectVoiceSupport } = await import("./voiceInput");
    await expect(detectVoiceSupport("window")).resolves.toBe(false);
  });
});
