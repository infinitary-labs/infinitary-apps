import { afterEach, expect, it, vi } from "vitest";

vi.mock("./prepareClip", () => ({
  ClipPreparer: class {
    prepare = vi.fn(async () => ({ samples: new Float32Array(), silent: true }));
    close = vi.fn();
    begin = vi.fn();
    push = vi.fn();
  },
}));

import { MicRecorder } from "./micRecorder";

it("reuses a no-output context and loaded worklet, but releases the mic on every stop", async () => {
  const connect = vi.fn();
  const disconnect = vi.fn();
  const graphNode = () => ({ connect, disconnect });
  const close = vi.fn();
  const addModule = vi.fn(async () => {});
  const constructed = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 48000;
      destination = {};
      audioWorklet = { addModule };
      constructor(options: unknown) {
        constructed(options);
      }
      resume = vi.fn(async () => {});
      close = close;
      createMediaStreamSource = graphNode;
      createAnalyser = graphNode;
      createGain = () => ({ ...graphNode(), gain: { value: 1 } });
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null };
      connect = connect;
      disconnect = disconnect;
    },
  );
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  for (let i = 0; i < 2; i++) {
    const recorder = new MicRecorder();
    await recorder.start();
    recorder.beginCapture();
    const clip = recorder.endCapture();
    recorder.stop();
    expect((await clip).silent).toBe(true);
  }
  expect(constructed).toHaveBeenCalledExactlyOnceWith({ sinkId: { type: "none" } });
  expect(addModule).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());
