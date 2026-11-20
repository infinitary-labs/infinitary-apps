import { afterEach, expect, it, vi } from "vitest";
import { ClipPreparer } from "./prepareClip";

class FakeWorker {
  static last: FakeWorker;
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
}

it("transfers each frame as it arrives and sends no clip-sized payload at release", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const preparer = new ClipPreparer(48000, 14400);
  const worker = FakeWorker.last;
  expect(worker.postMessage).toHaveBeenCalledWith(
    { type: "init", sampleRate: 48000, maxPreRoll: 14400 },
    [],
  );
  const frame = new Float32Array([1, 2, 3]);
  preparer.push(frame);
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "frame", frame }, [frame.buffer]);
  preparer.begin();
  const result = preparer.prepare();
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "end" }, []);
  const clip = { samples: new Float32Array([1, 4]), silent: false };
  worker.onmessage?.(new MessageEvent("message", { data: clip }));
  expect(await result).toBe(clip);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("the real worker owns pre-roll, resampling and silence, including empty clips", async () => {
  const ctx = { onmessage: null as unknown as (e: MessageEvent) => void, postMessage: vi.fn() };
  vi.stubGlobal("self", ctx);
  await import("./pcm.worker");
  const send = (data: import("./pcm.worker").PcmRequest) =>
    ctx.onmessage(new MessageEvent("message", { data }));
  send({ type: "init", sampleRate: 48000, maxPreRoll: 3 });
  send({ type: "frame", frame: new Float32Array([7, 8, 9]) });
  send({ type: "frame", frame: new Float32Array([1, 2, 3]) }); // Discards the older pre-roll.
  send({ type: "begin" });
  send({ type: "frame", frame: new Float32Array([4, 5, 6]) });
  send({ type: "end" });
  const clip = ctx.postMessage.mock.calls[0]?.[0];
  expect([...clip.samples]).toEqual([1, 4]);
  expect(clip.silent).toBe(false);
  expect(ctx.postMessage.mock.calls[0]?.[1]).toEqual([clip.samples.buffer]);
  send({ type: "begin" });
  send({ type: "end" });
  expect(ctx.postMessage.mock.calls[1]?.[0].silent).toBe(true);
});

it("reports a worker startup failure instead of leaving the clip pending", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const preparer = new ClipPreparer(48000, 14400);
  const worker = FakeWorker.last;
  worker.onerror?.(
    Object.assign(new Event("error"), { message: "worker load failed" }) as ErrorEvent,
  );
  await expect(preparer.prepare()).rejects.toThrow("worker load failed");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.postMessage).toHaveBeenCalledOnce(); // Configuration only, never an end request.
});

afterEach(() => vi.unstubAllGlobals());
