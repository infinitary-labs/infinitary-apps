import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createKeychainUnlocker, type UnlockHelperProcess } from "./keychainUnlock";

const HELPER = "/app/out/main/keychainUnlockHelper.js";
const STORE = "/Users/kun/Library/Keychains/login.keychain-db";

/** A forked helper the test answers for: a message, an exit, or nothing at all. */
class FakeHelper extends EventEmitter implements UnlockHelperProcess {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
  answer(status: number): void {
    this.emit("message", { status });
    this.emit("exit", 0);
  }
}

function forkRecorder() {
  const forks: Array<{ modulePath: string; args: string[]; helper: FakeHelper }> = [];
  const fork = (modulePath: string, args: string[]) => {
    const helper = new FakeHelper();
    forks.push({ modulePath, args, helper });
    return helper;
  };
  return { forks, fork };
}

describe("createKeychainUnlocker", () => {
  it("runs the helper on the store and resolves with the status it reports", async () => {
    const { forks, fork } = forkRecorder();
    const unlock = createKeychainUnlocker({ helperPath: HELPER, fork });
    const pending = unlock(STORE);
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ modulePath: HELPER, args: [STORE] });
    forks[0]?.helper.answer(-128);
    await expect(pending).resolves.toBe(-128);
  });

  it("rejects when the helper exits without answering", async () => {
    const { forks, fork } = forkRecorder();
    const pending = createKeychainUnlocker({ helperPath: HELPER, fork })(STORE);
    forks[0]?.helper.emit("exit", 1);
    await expect(pending).rejects.toThrow("The unlock helper exited (1) without an answer.");
  });

  it("kills a helper whose dialog is never answered", async () => {
    const { forks, fork } = forkRecorder();
    const pending = createKeychainUnlocker({ helperPath: HELPER, fork, timeoutMs: 5 })(STORE);
    await expect(pending).rejects.toThrow("timed out");
    expect(forks[0]?.helper.killed).toBe(true);
  });

  it("shows one dialog per store: a second Retry waits for the first answer", async () => {
    const { forks, fork } = forkRecorder();
    const unlock = createKeychainUnlocker({ helperPath: HELPER, fork });
    const first = unlock(STORE);
    const second = unlock(STORE);
    expect(forks).toHaveLength(1);
    forks[0]?.helper.answer(0);
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    // Answered: the next Retry asks again.
    const third = unlock(STORE);
    expect(forks).toHaveLength(2);
    forks[1]?.helper.answer(0);
    await expect(third).resolves.toBe(0);
  });

  it("a helper that cannot start is a rejection, not a hang", async () => {
    const unlock = createKeychainUnlocker({
      helperPath: HELPER,
      fork: () => {
        throw new Error("spawn failed");
      },
    });
    await expect(unlock(STORE)).rejects.toThrow("spawn failed");
  });
});
