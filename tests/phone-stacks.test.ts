import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { capturePhoneKeyboardTimeout } from "./helpers/phoneStacks";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1066: the captain requested a stack at this actual PR-run UIKit timeout,
// with the photo-selection/tap order unchanged. This is the retained iPad reading.
const fault =
  "2026-10-24 16:41:17.302 F  Infinitary[7496:f94e] [com.apple.UIKit:KeyboardTaskQueue] -[UIKeyboardTaskQueue _lockWhenReadyForMainThread] Keyboard queue task timeout detected";
const pid = Number(/Infinitary\[(\d+):/.exec(fault)?.[1]);

function fixture(
  currentPid = pid,
  sample = vi.fn(async (_pid: number, _destination: string) => {}),
) {
  const evidence = scratchDir("phone-timeout-stack-");
  const readPid = vi.fn(async () => currentPid);
  const reader = capturePhoneKeyboardTimeout({ evidence, currentPid: readPid, sample });
  return {
    evidence,
    readPid,
    sample,
    reader,
    status: () => readFileSync(join(evidence, "keyboard-timeout-capture.log"), "utf8"),
  };
}

describe("the requested fault-time stack capture", () => {
  it("samples the owned app once on the real fault and joins it before cleanup", async () => {
    let finish!: () => void;
    const sampled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture(
      pid,
      vi.fn(async () => sampled),
    );
    f.reader.receive(fault);
    f.reader.receive(fault);
    let closed = false;
    const closing = f.reader.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(f.readPid).toHaveBeenCalledTimes(1);
    expect(f.sample).toHaveBeenCalledExactlyOnceWith(
      pid,
      join(f.evidence, "keyboard-timeout-stack.log"),
    );
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(f.status()).toContain("Completed owned app stack capture");
    f.reader.receive(fault);
    expect(f.sample).toHaveBeenCalledTimes(1);
  });

  it("does not sample a PID no longer owned by the simulator's current app", async () => {
    // The same journey's pre-relaunch application PID, read from its XCTest log.
    const f = fixture(7374);
    f.reader.receive(fault);
    await f.reader.close();
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.status()).toContain("no longer owns that PID");
  });

  it("keeps a failed capture honestly and never retries it", async () => {
    const f = fixture(
      pid,
      vi.fn(async () => {
        throw new Error("sampler exited before capture");
      }),
    );
    f.reader.receive(fault);
    await f.reader.close();
    f.reader.receive(fault);
    expect(f.sample).toHaveBeenCalledTimes(1);
    expect(f.status()).toContain("Stack capture failed: Error: sampler exited before capture");
    expect(f.status()).not.toContain("Completed owned app stack capture");
  });

  it("does not treat an ordinary text-input reading as a reproduced timeout", async () => {
    const f = fixture();
    f.reader.receive(
      "2026-10-24 16:41:16.145 Df Infinitary[7496:f94e] [com.apple.UIKit:KeyboardSceneDelegate] _reloadInputViewsForKeyWindowSceneResponder: 1 force: 0, fromBecomeFirstResponder: 1 (automaticKeyboard: 1, reloadIdentifier: AF19F76C-B83D-4B2B-9530-8EDCD2F883CD)",
    );
    await f.reader.close();
    expect(f.readPid).not.toHaveBeenCalled();
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.status()).toContain("no stack capture or reproduction is claimed");
  });
});
