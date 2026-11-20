import { describe, expect, it } from "vitest";
import { SettingSave } from "./settingSave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function arrange() {
  let stored = false;
  const writer = new SettingSave(
    async () => stored,
    () => {},
  );
  return {
    writer,
    store: (next: boolean) => {
      stored = next;
    },
  };
}

describe("Settings save recovery", () => {
  it("keeps the confirmed value until receipt and clears refusal feedback on retry", async () => {
    const { writer } = arrange();
    await writer.refresh();
    expect(
      await writer.save(async () => {
        throw new Error("Could not save notifications: Locked.");
      }),
    ).toBe(false);
    expect(writer.state).toEqual({
      value: false,
      error: "Could not save notifications: Locked.",
      saving: false,
    });
    const held = deferred<boolean>();
    const retry = writer.save(() => held.promise);
    await Promise.resolve();
    expect(writer.state).toEqual({ value: false, error: null, saving: true });
    held.resolve(true);
    expect(await retry).toBe(true);
    expect(writer.state).toEqual({ value: true, error: null, saving: false });
  });

  it("re-reads the actual saved value when a write partially succeeds then rejects", async () => {
    const { writer, store } = arrange();
    await writer.refresh();
    expect(
      await writer.save(async () => {
        store(true);
        throw new Error("The dock could not be changed.");
      }),
    ).toBe(false);
    expect(writer.state).toEqual({
      value: true,
      error: "The dock could not be changed.",
      saving: false,
    });
  });

  it("names a failed recovery instead of claiming the last value is still saved", async () => {
    let failRead = false;
    const writer = new SettingSave(
      async () => {
        if (failRead) throw new Error("Transport detail");
        return true;
      },
      () => {},
    );
    await writer.refresh();
    failRead = true;
    await writer.save(async () => {
      throw new Error("Could not save notifications. Please try again.");
    });
    expect(writer.state.value).toBe(true);
    expect(writer.state.error).toBe(
      "Could not save notifications. Please try again. Could not reload the saved value. Close and reopen Settings to try again.",
    );
    expect(writer.state.saving).toBe(false);
  });

  it("offers the caller's recovery action outside Settings and can retry", async () => {
    let failRead = false;
    const writer = new SettingSave(
      async () => {
        if (failRead) throw new Error("Unavailable");
        return true;
      },
      () => {},
      "Try Turn off or OK again to save your choice.",
    );
    await writer.refresh();
    failRead = true;
    expect(
      await writer.save(async () => {
        throw new Error("Locked.");
      }),
    ).toBe(false);
    expect(writer.state).toEqual({
      value: true,
      saving: false,
      error:
        "Locked. Could not reload the saved value. Try Turn off or OK again to save your choice.",
    });
    expect(await writer.save(async () => false)).toBe(true);
    expect(writer.state).toEqual({ value: false, error: null, saving: false });
  });

  it("orders writes and their recovery before allowing the next write", async () => {
    const events: string[] = [];
    const recovery = deferred<number>();
    const first = deferred<number>();
    const writer = new SettingSave(
      () => {
        events.push("read");
        return recovery.promise;
      },
      () => {},
    );
    const a = writer.save(() => {
      events.push("first");
      return first.promise;
    });
    const b = writer.save(async () => {
      events.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    first.reject(new Error("Refused"));
    expect(writer.state.saving).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first", "read"]);
    recovery.resolve(1);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(events).toEqual(["first", "read", "second"]);
    expect(writer.state).toEqual({ value: 2, error: null, saving: false });
  });

  it("never lets an older poll replace a save or recovery", async () => {
    const poll = deferred<boolean>();
    let reads = 0;
    const writer = new SettingSave(
      () => {
        ++reads;
        return poll.promise;
      },
      () => {},
    );
    const refresh = writer.refresh();
    const write = deferred<boolean>();
    const saving = writer.save(() => write.promise);
    await writer.refresh();
    expect(reads).toBe(1);
    write.resolve(true);
    await saving;
    poll.resolve(false);
    await refresh;
    expect(writer.state.value).toBe(true);
  });

  it("clears a recovered initial-read failure but retains save feedback across polls", async () => {
    let failRead = true;
    const writer = new SettingSave(
      async () => {
        if (failRead) throw new Error("Offline");
        return false;
      },
      () => {},
    );
    await writer.refresh();
    expect(writer.state.error).not.toBeNull();
    failRead = false;
    await writer.refresh();
    expect(writer.state).toEqual({ value: false, error: null, saving: false });
    await writer.save(async () => {
      throw new Error("Could not save notifications: Locked.");
    });
    await writer.refresh();
    expect(writer.state.error).toBe("Could not save notifications: Locked.");
  });

  it("takes a pushed value as saved, but never over a save, its recovery or a newer push", async () => {
    let stored = 1;
    const recovery = deferred<number>();
    let reads = 0;
    const writer = new SettingSave(
      () => (++reads === 1 ? Promise.resolve(stored) : recovery.promise),
      () => {},
    );
    await writer.refresh();
    writer.apply(2);
    expect(writer.state).toEqual({ value: 2, error: null, saving: false });

    // A refused write re-reads; the push that arrives meanwhile does not decide what shows.
    stored = 2;
    const refused = writer.save(async () => {
      throw new Error("Could not change sharing: Locked.");
    });
    await Promise.resolve();
    writer.apply(9);
    recovery.resolve(stored);
    expect(await refused).toBe(false);
    expect(writer.state).toEqual({
      value: 2,
      error: "Could not change sharing: Locked.",
      saving: false,
    });

    // An older poll never replaces a later push, and the refusal stays said.
    const poll = deferred<number>();
    const slow = new SettingSave(
      () => poll.promise,
      () => {},
    );
    const polling = slow.refresh();
    slow.apply(3);
    poll.resolve(1);
    await polling;
    expect(slow.state.value).toBe(3);
    writer.apply(4);
    expect(writer.state.error).toBe("Could not change sharing: Locked.");
  });

  it("clears a failed initial read once a push brings the saved value", async () => {
    const writer = new SettingSave<number>(
      async () => {
        throw new Error("Offline");
      },
      () => {},
    );
    await writer.refresh();
    expect(writer.state.error).toBe("Could not load this setting. Please try again.");
    writer.apply(5);
    expect(writer.state).toEqual({ value: 5, error: null, saving: false });
  });

  it("contains a failed initial read, but allows explicit refresh actions to report their reason", async () => {
    const writer = new SettingSave(
      async () => {
        throw new Error("Could not load models: Offline.");
      },
      () => {},
    );
    await writer.refresh();
    expect(writer.state.error).toBe("Could not load this setting. Please try again.");
    await expect(writer.refresh(true)).rejects.toThrow("Could not load models: Offline.");
  });
});
