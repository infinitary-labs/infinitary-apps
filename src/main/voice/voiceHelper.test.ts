import { EventEmitter } from "node:events";
import { RECOGNIZER_IDLE_MS, recognizerPlaceFor } from "@shared/voiceRecognizer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A forked utility process the test drives: its messages, its exit. */
class FakeChild extends EventEmitter {
  sent: Array<{ id: number; type: string; audio?: Float32Array }> = [];
  postMessage = vi.fn((message: { id: number; type: string }) => this.sent.push(message));
  kill = vi.fn(() => {
    this.emit("exit", 0);
    return true;
  });
  reply(index: number, data: Record<string, unknown>) {
    this.emit("message", { id: this.sent[index]?.id, ...data });
  }
}

const fixture = vi.hoisted(() => ({
  children: [] as FakeChild[],
  fork: vi.fn(),
}));
vi.mock("electron", () => ({ utilityProcess: { fork: fixture.fork } }));

import { createVoiceHelper } from "./voiceHelper";

function forked(index: number): FakeChild {
  const child = fixture.children[index];
  if (!child) throw new Error(`No helper process ${index} was started.`);
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.children = [];
  fixture.fork.mockReset().mockImplementation(() => {
    const child = new FakeChild();
    fixture.children.push(child);
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("where this computer transcribes", () => {
  it("runs the voice helper where its library lists a graphics provider and keeps the window's recognizer elsewhere", () => {
    // What ONNX Runtime 1.24's builds list: Apple silicon's, an Intel Mac's
    // (no build) and Linux arm64's (no graphics provider).
    const graphicsCard = true;
    expect(recognizerPlaceFor({ providers: ["cpu", "webgpu", "coreml"], graphicsCard })).toBe(
      "helper",
    );
    expect(recognizerPlaceFor({ providers: null, graphicsCard })).toBe("window");
    expect(recognizerPlaceFor({ providers: ["cpu"], graphicsCard })).toBe("window");
  });
});

describe("the voice helper process", () => {
  const options = { entryPath: "/app/out/main/voiceHelper.js", modelsDir: "/data/models" };

  it("starts on the first recording with the models directory, and hands it the recording", async () => {
    const helper = createVoiceHelper(options);
    expect(fixture.fork).not.toHaveBeenCalled();
    const audio = new Float32Array([0.25, -0.25]);
    const words = helper.transcribe(audio);
    expect(fixture.fork).toHaveBeenCalledWith(options.entryPath, [options.modelsDir], {
      serviceName: "Infinitary Voice",
      stdio: "inherit",
    });
    const child = forked(0);
    expect(child.sent[0]).toMatchObject({ type: "transcribe", audio });
    child.reply(0, { type: "result", text: "Please fix the login page." });
    await expect(words).resolves.toBe("Please fix the login page.");
  });

  it("ends the process after three idle minutes and starts a fresh one for the next recording", async () => {
    const helper = createVoiceHelper(options);
    const warm = helper.warmUp();
    const child = forked(0);
    child.reply(0, { type: "ready" });
    await warm;
    vi.advanceTimersByTime(RECOGNIZER_IDLE_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledOnce();
    const again = helper.warmUp();
    expect(fixture.fork).toHaveBeenCalledTimes(2);
    forked(1).reply(0, { type: "ready" });
    await again;
  });

  it("fails a recording whose helper exits, and starts another for the next", async () => {
    const helper = createVoiceHelper(options);
    const words = helper.transcribe(new Float32Array(8));
    forked(0).emit("exit", 9);
    await expect(words).rejects.toThrow("The voice helper stopped working.");
    const next = helper.transcribe(new Float32Array(8));
    const child = forked(1);
    child.reply(0, { type: "result", text: "again" });
    await expect(next).resolves.toBe("again");
  });

  it("ends the process when the app releases it", () => {
    const helper = createVoiceHelper(options);
    void helper.warmUp().catch(() => {});
    helper.release();
    expect(forked(0).kill).toHaveBeenCalledOnce();
  });
});
