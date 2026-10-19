import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hardwareKeyboardArguments,
  observePhoneKeyboard,
  PHONE_HARDWARE_KEYBOARD_STATE,
  PhoneKeyRegistrations,
  phoneApplicationPid,
  withPhoneHardwareKeyboard,
} from "./helpers/phoneKeyboard";
import { scratchDir } from "./helpers/scratchDirs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

// INF-355: the event router must acknowledge a chord before the native test sends it.
// These are the relevant real readings from its failing 54571 process, not an app-side command list.
const registration = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-17 20:54:17.626",
  eventMessage: String.raw`new key command registrations for pid:54571 environment: keyboardFocus; token: 0x187EFC0B; keyCommands: {
    cmd|opt|shft: (v),
    cmd: (b, (50:leftArrow), ",", c, (51:downArrow), "-", (52:upArrow), e, f, g, u, "?", v, "[", i, w, x, z, "\^M", a, (4F:rightArrow), "+"),
    glb|ctrl|opt|shft|capslock|numpad: (" "),
    cmd|shft: (k, z, g),
    glb: (e, d),
    cmd|opt: (f, w),
    cmd|ctrl: (" ")
}`,
};
// The resumed full iPhone run emitted a literal Return inside its ndjson message.
// Unlike log's compact output above, this is not the printed \\^M spelling.
const ndjsonRegistration = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 00:46:50.430122-0700",
  eventMessage: `new key command registrations for pid:77224 environment: keyboardFocus; token: 0x68D23FFE; keyCommands: {
    cmd|opt|shft: (v),
    cmd: (b, (50:leftArrow), ",", c, (51:downArrow), "-", (52:upArrow), e, f, g, u, "?", v, "[", i, w, x, z, "\r", a, (4F:rightArrow), "+"),
    glb|ctrl|opt|shft|capslock|numpad: (" "),
    cmd|shft: (k, z, g),
    glb: (e, d),
    cmd|opt: (f, w),
    cmd|ctrl: (" ")
}`,
};
// INF-82: the last iPhone reading before its missing PID, and the sibling iPad paging reading.
const beforeRelaunch = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 19:28:54.561884-0700",
  eventMessage:
    'new key command registrations for pid:19471 environment: keyboardFocus; token: 0x4B9CD982; keyCommands: {\n    cmd|opt|shft: (v),\n    cmd: ("?", f, v, g, w, x, i, ",", "\r", a, "[", c, (4F:rightArrow), (50:leftArrow), (52:upArrow), (51:downArrow), z, e),\n    glb|ctrl|opt|shft|capslock|numpad: (" "),\n    cmd|shft: (g, k, z),\n    glb: (e, d),\n    cmd|opt: (w, f),\n    cmd|ctrl: (" ")\n}',
};
const afterRelaunch = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 19:42:03.409124-0700",
  eventMessage:
    'new key command registrations for pid:80895 environment: keyboardFocus; token: 0x8BD835D2; keyCommands: {\n    cmd|opt|shft: (v),\n    cmd: ("?", f, v, g, w, x, i, ",", a, "[", c, (4F:rightArrow), (50:leftArrow), (52:upArrow), (51:downArrow), z, e),\n    glb|ctrl|opt|shft|capslock|numpad: (" "),\n    cmd|shft: (k, "]", g, z),\n    glb: (e, d),\n    cmd|opt: (w, f),\n    cmd|ctrl: (" ")\n}',
};
const pid = Number(/pid:(\d+)/.exec(registration.eventMessage)?.[1]);
const dismiss = { key: "k", modifiers: ["shft", "cmd"] };

afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});

describe("the native chord's backboard registration witness (INF-355)", () => {
  it("does not release a chord until the router, rather than the app, acknowledges it", async () => {
    vi.useFakeTimers();
    const reader = new PhoneKeyRegistrations();
    let dispatched = false;
    const ready = reader.wait(pid, dismiss).then(() => {
      dispatched = true;
    });
    reader.receive({
      processImagePath: "/Applications/Infinitary.app/Infinitary",
      eventMessage:
        "flushing changes: {\n    contentsMask: 0x8; keyCommandsRegistrations: [environment: keyboardFocus; token: 0x187EFC0B; keyCommands: 33];\n}",
    });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    reader.receive(registration);
    await ready;
    expect(dispatched).toBe(true);
    reader.close();
  });

  it.each([registration, ndjsonRegistration])(
    "reads the actual modifier groups and Return spelling from $timestamp",
    async (record) => {
      vi.useFakeTimers();
      const reader = new PhoneKeyRegistrations();
      reader.receive(record);
      const registeredPid = Number(/pid:(\d+)/.exec(record.eventMessage)?.[1]);
      for (const chord of [
        dismiss,
        { key: "i", modifiers: ["cmd"] },
        { key: "\r", modifiers: ["cmd"] },
      ]) {
        const ready = expect(reader.wait(registeredPid, chord)).resolves.toMatchObject({
          pid: registeredPid,
          timestamp: record.timestamp,
          ...chord,
        });
        await Promise.all([ready, vi.runAllTimersAsync()]);
      }
      reader.close();
    },
  );

  it("never uses the wrong modifiers or a previous process's registration", async () => {
    vi.useFakeTimers();
    const reader = new PhoneKeyRegistrations();
    reader.receive(registration);
    const missing = expect(reader.wait(pid, { key: "k", modifiers: ["cmd"] })).rejects.toThrow(
      "No backboard registration",
    );
    // The later before-wait journey's app PID, not the old process that supplied this registration.
    const relaunched = expect(reader.wait(11487, dismiss)).rejects.toThrow(
      "No backboard registration",
    );
    await vi.runAllTimersAsync();
    await Promise.all([missing, relaunched]);
    reader.close();
  });

  it("fails closed if its observer ends, even when an earlier witness was cached", async () => {
    const reader = new PhoneKeyRegistrations();
    const pending = expect(reader.wait(pid, dismiss)).rejects.toThrow("observer stopped");
    reader.close();
    await pending;
    const cached = new PhoneKeyRegistrations();
    cached.receive(registration);
    cached.close();
    await expect(cached.wait(pid, dismiss)).rejects.toThrow("observer stopped");
  });

  it("renews a still-open subscription before relaunch without reusing its witnesses or losing evidence", async () => {
    const evidence = scratchDir("phone-keyboard-relaunch-");
    const children = new Set<ChildProcess>();
    const streams: ReturnType<typeof makeChild>[] = [];
    function makeChild() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          stdout.end();
          stderr.end();
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          return true;
        }),
      });
      return child;
    }
    spawn.mockImplementation(() => {
      // Closing and joining the old writer is a prerequisite, not a background cleanup.
      if (streams.length) {
        expect(children.size).toBe(0);
        expect(streams[0]?.stdout.destroyed).toBe(true);
        expect(streams[0]?.stderr.destroyed).toBe(true);
      }
      const child = makeChild();
      streams.push(child);
      queueMicrotask(() =>
        child.stdout.write("Filtering the log data using the registration predicate\n"),
      );
      return child;
    });
    const observer = await observePhoneKeyboard({
      simulator: "E673564E-BBAF-46DD-BAA4-A458F11C1AF6",
      env: {},
      evidence,
      children,
    });
    const previousPid = Number(/pid:(\d+)/.exec(beforeRelaunch.eventMessage)?.[1]);
    const nextPid = Number(/pid:(\d+)/.exec(afterRelaunch.eventMessage)?.[1]);
    const next = { key: "]", modifiers: ["cmd", "shft"] };
    streams[0]?.stdout.write(`${JSON.stringify(beforeRelaunch)}\n`);
    await expect(observer.wait(previousPid, dismiss)).resolves.toMatchObject({ pid: previousPid });
    // Like INF-82's failed run, the old child stays open but supplies no new-process record.
    const oldWait = expect(observer.wait(nextPid, next)).rejects.toThrow("observer stopped");
    await expect(observer.beforeLaunch()).resolves.toEqual({ generation: 2 });
    await oldWait;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(streams[0]?.kill).toHaveBeenCalledTimes(1);
    let released = false;
    const ready = observer.wait(nextPid, next).then((witness) => {
      released = true;
      return witness;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    streams[1]?.stdout.write(`${JSON.stringify(afterRelaunch)}\n`);
    await expect(ready).resolves.toMatchObject({ pid: nextPid, ...next });
    const noCachedOldProcess = expect(observer.wait(previousPid, dismiss)).rejects.toThrow(
      "observer stopped",
    );
    await observer.close();
    await noCachedOldProcess;
    expect(children.size).toBe(0);
    const saved = gunzipSync(
      readFileSync(join(evidence, "keyboard-registrations.ndjson.gz")),
    ).toString();
    expect(saved.split("\n").filter((line) => line.startsWith("{"))).toEqual([
      JSON.stringify(beforeRelaunch),
      JSON.stringify(afterRelaunch),
    ]);
  });

  // INF-230 offline review: either evidence writer must fail readiness without bypassing cleanup.
  it.each(["keyboard-registrations.ndjson.gz", "keyboard-registrations.stderr"])(
    "closes its observer and both streams when %s cannot be written",
    async (file) => {
      const evidence = scratchDir("phone-keyboard-writer-");
      // A real EISDIR, not an invented error or a failing simulator command.
      mkdirSync(join(evidence, file));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let stopped = false;
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          if (!stopped) {
            stopped = true;
            stdout.end();
            stderr.end();
            queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          }
          return true;
        }),
      });
      spawn.mockImplementation(() => {
        queueMicrotask(() => {
          stdout.write("Filtering the log data using the registration predicate\n");
          stdout.write(`${JSON.stringify(registration)}\n`);
        });
        return child;
      });
      const children = new Set<ChildProcess>();
      const observer = await observePhoneKeyboard({
        simulator: "DA593B42-3668-49E5-AA53-39CA3677EABD",
        env: {},
        evidence,
        children,
      });
      await expect(observer.wait(11487, dismiss)).rejects.toThrow("EISDIR");
      await expect(observer.close()).rejects.toThrow("EISDIR");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(children.size).toBe(0);
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
    },
  );

  it("reads the app PID rather than its test runner from the owned simulator's service list", () => {
    // Actual service rows from the before-wait full iPhone journey.
    const services =
      "23175\t0\tUIKitApplication:com.getinfinitary.infinitary.uitests.xctrunner[6212][rb-legacy]\n11487\t0\tUIKitApplication:com.getinfinitary.infinitary[98ff][rb-legacy]";
    expect(phoneApplicationPid(services, "com.getinfinitary.infinitary")).toBe(11487);
    expect(() =>
      phoneApplicationPid(
        services.slice(0, services.indexOf("\n")),
        "com.getinfinitary.infinitary",
      ),
    ).toThrow("got 0");
  });
});

// UIKit publishes key commands only while a hardware keyboard is attached when its deferred update runs.
// The home attaches one to its own simulator for the wait; XCTest's own keyboard detaches within a millisecond.
describe("the owned simulator's hardware keyboard during a chord's acknowledgement wait", () => {
  const simulator = "A9EEAD2F-B238-4612-9A9C-250E64BC7E52";

  it("attaches it before the wait and detaches it after, also when no registration arrives", async () => {
    const commands: string[][] = [];
    const run = async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      return "";
    };
    await expect(
      withPhoneHardwareKeyboard(run, simulator, async () => {
        expect(commands).toEqual([["xcrun", ...hardwareKeyboardArguments(simulator, true)]]);
        // The refusal a captured iPhone run produced once its app had launched after the keyboard detached.
        throw new Error("No backboard registration for app 61016, cmd|shft:k");
      }),
    ).rejects.toThrow("No backboard registration");
    expect(commands).toEqual([
      ["xcrun", ...hardwareKeyboardArguments(simulator, true)],
      ["xcrun", ...hardwareKeyboardArguments(simulator, false)],
    ]);
    const states = commands.map((command) => {
      const [xcrun, simctl, spawn, owned, tool, set, key, value, post, posted] = command;
      expect([xcrun, simctl, spawn, owned, tool, set, post]).toEqual([
        "xcrun",
        "simctl",
        "spawn",
        simulator,
        "notifyutil",
        "-s",
        "-p",
      ]);
      expect(key).toBe(PHONE_HARDWARE_KEYBOARD_STATE);
      expect(posted).toBe(PHONE_HARDWARE_KEYBOARD_STATE);
      return Number(value);
    });
    // GraphicsServices reads the low byte as the attached flag; backboardd wrote 8449 and 8448 for
    // XCTest's own US keyboard (country code 33) connecting and disconnecting in the captured runs.
    expect(states.map((state) => state & 0xff)).toEqual([1, 0]);
    expect(states.map((state) => state >> 8)).toEqual([33, 33]);
  });

  it("returns the witness the wait produced once the keyboard is detached again", async () => {
    const commands: string[] = [];
    const run = async (_command: string, args: string[]) => {
      commands.push(args[6] ?? "");
      return "";
    };
    const witness = { pid: 7425, token: "0x9c03bb08", timestamp: "", key: "i", modifiers: ["cmd"] };
    await expect(withPhoneHardwareKeyboard(run, simulator, async () => witness)).resolves.toBe(
      witness,
    );
    expect(commands).toEqual([String((33 << 8) | 1), String(33 << 8)]);
  });
});
