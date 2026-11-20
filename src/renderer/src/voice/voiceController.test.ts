import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  samples: new Float32Array(1600).fill(0.2), // 0.1 s, below the hold threshold
  transcribe: vi.fn(async () => "hello captain"),
  preparing: null as Promise<{ samples: Float32Array; silent: boolean }> | null,
  stop: vi.fn(),
}));
vi.mock("./micRecorder", () => ({
  MicRecorder: class {
    onLimitReached: (() => void) | null = null;
    async start() {
      return { fftSize: 2, getByteTimeDomainData: () => {} };
    }
    beginCapture() {}
    endCapture() {
      return fixture.preparing ?? Promise.resolve({ samples: fixture.samples, silent: false });
    }
    stop() {
      fixture.stop();
    }
  },
}));
vi.mock("./whisperClient", () => ({
  warmUpWhisper: vi.fn(async () => {}),
  transcribeAudio: fixture.transcribe,
}));
vi.mock("./voiceInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voiceInput")>()),
  isAudioSilent: () => false,
  isLikelyHallucination: () => false,
}));
vi.mock("./liveVoiceLevel", () => ({
  setLiveVoiceLevel: vi.fn(),
  clearLiveVoiceLevel: vi.fn(),
}));

import { voiceController } from "./voiceController";

describe("voice capture duration", () => {
  beforeEach(() => {
    fixture.transcribe.mockClear();
    fixture.stop.mockClear();
    fixture.preparing = null;
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("transcribes a short tap-to-toggle session rather than dropping it as a short hold", async () => {
    await voiceController.start(() => {});
    expect(await voiceController.finish()).toBe("hello captain");
    expect(fixture.transcribe).toHaveBeenCalledWith(fixture.samples);
  });

  it("drops an in-flight transcript when abandoned", async () => {
    let resolve!: (text: string) => void;
    fixture.transcribe.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await voiceController.start(() => {});
    const result = voiceController.finish();
    await Promise.resolve();
    voiceController.abandon();
    resolve("discard me");
    expect(await result).toBeNull();
  });

  it("releases the microphone before PCM preparation resolves and discards an abandoned clip", async () => {
    let resolve!: (clip: { samples: Float32Array; silent: boolean }) => void;
    fixture.preparing = new Promise((done) => {
      resolve = done;
    });
    await voiceController.start(() => {});
    const result = voiceController.finish();
    expect(fixture.stop).toHaveBeenCalledOnce();
    voiceController.abandon();
    resolve({ samples: fixture.samples, silent: false });
    expect(await result).toBeNull();
    expect(fixture.transcribe).not.toHaveBeenCalled();
  });

  it("still drops a short hold", async () => {
    await voiceController.start(() => {});
    expect(await voiceController.finish(true)).toBeNull();
    expect(fixture.transcribe).not.toHaveBeenCalled();
  });
});
