import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observePhoneKeyboard,
  phoneCaretOutcome,
  phoneLogMilliseconds,
} from "./helpers/phoneKeyboard";
import { scratchDir } from "./helpers/scratchDirs";

// INF-6074: whether the system's keyboard took back the caret a phone text field took after a key, read from UIKit's
// and the keyboard arbiter's own lines in the app (tests/helpers/phoneKeyboard.ts). The observer's subscription and
// kept-log read replace child_process.spawn with owned streams, as tests/phone-key-outcome.test.ts does.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

afterEach(() => {
  spawn.mockReset();
});

// Phone run 44991488174, attempt 2, the iPhone's talk-tasks part: Find a task opened the task search with the caret,
// its keyboard took six seconds to come up, and the arbiter's connection failed and resigned the caret 16 seconds later.
const app = "/private/var/containers/Bundle/Application/7C1D4B2E/Infinitary.app/Infinitary";
const pid = 5746;
const field = {
  processImagePath: app,
  processID: pid,
  subsystem: "com.apple.UIKit",
  category: "KeyboardSceneDelegate",
  timestamp: "2026-11-22 06:41:29.604000+0000",
  eventMessage:
    "Try reloading input views for responder:<SwiftUI.UIKitTextField: 0x16d9a9400> requiresKB:Y force:N scene-identity:com.apple.frontboard.systemappservices/FBSceneManager:sceneID%3Acom.getinfinitary.infinitary-default",
};
const failed = {
  processImagePath: app,
  processID: pid,
  subsystem: "com.apple.KeyboardArbiter",
  category: "Client",
  timestamp: "2026-11-22 06:41:45.607000+0000",
  eventMessage: "failedConnection",
};
const resigned = {
  ...failed,
  timestamp: "2026-11-22 06:41:45.610000+0000",
  eventMessage: "handleKeyboardChange: resignFirstResponder",
};
// backboardd matched the key to the app 1.6 seconds before the field took the caret.
const pressed = phoneLogMilliseconds("2026-11-22 06:41:28.035000+0000");
const line = (record: { timestamp: string; eventMessage: string }) =>
  `${record.timestamp} ${record.eventMessage}`;

describe("a phone text field's caret taken back by the system's keyboard", () => {
  it("reads the field taking the caret, the arbiter's failed connection and its resign, in that order", () => {
    expect(phoneCaretOutcome([resigned, field, failed], pid, pressed)).toEqual({
      outcome: "taken-back",
      pid,
      proof: [line(field), line(failed), line(resigned)],
    });
  });
  it("is unknown when no text field took the caret after the key", () => {
    expect(phoneCaretOutcome([failed, resigned], pid, pressed).outcome).toBe("unknown");
    const before = phoneLogMilliseconds(field.timestamp) + 1;
    expect(phoneCaretOutcome([field, failed, resigned], pid, before).outcome).toBe("unknown");
  });
  it("is unknown when the system resigned the caret without a failed connection first", () => {
    const early = { ...resigned, timestamp: "2026-11-22 06:41:45.600000+0000" };
    expect(phoneCaretOutcome([field, early, failed], pid, pressed).outcome).toBe("unknown");
    expect(phoneCaretOutcome([field, failed], pid, pressed).outcome).toBe("unknown");
  });
  it("is unknown when a text field took the caret again after the resign", () => {
    const again = { ...field, timestamp: "2026-11-22 06:41:47.100000+0000" };
    expect(phoneCaretOutcome([field, failed, resigned, again], pid, pressed)).toEqual({
      outcome: "unknown",
      pid,
      proof: [line(field), line(failed), line(resigned), line(again)],
    });
  });
  it("reads only the current app process, never a line another process or launch logged", () => {
    expect(phoneCaretOutcome([field, failed, resigned], pid + 1, pressed).outcome).toBe("unknown");
    const springBoard = [field, failed, resigned].map((record) => ({
      ...record,
      processImagePath: "/System/Library/CoreServices/SpringBoard.app/SpringBoard",
    }));
    expect(phoneCaretOutcome(springBoard, pid, pressed).outcome).toBe("unknown");
  });
  it("never reads a line the Mac could not compose as proof", () => {
    const unreadable = { ...resigned, eventMessage: "<compose failure [shared UUID]>" };
    expect(phoneCaretOutcome([field, failed, unreadable], pid, pressed).outcome).toBe("unknown");
  });
});

describe("the caret witness read from the owned simulator's log (INF-6074)", () => {
  const simulator = "53B86A21-6C98-4ADA-B450-3067365D6B8F";
  async function observer(show: (child: EventEmitter, stdout: PassThrough) => void) {
    const children = new Set<ChildProcess>();
    const reads: AbortSignal[] = [];
    let subscription: PassThrough | undefined;
    spawn.mockImplementation((_command, args, options: { signal?: AbortSignal }) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          stdout.end();
          stderr.end();
          queueMicrotask(() => child.emit("close", null));
          return true;
        }),
      });
      queueMicrotask(() => {
        if (args.includes("stream")) {
          subscription = stdout;
          stdout.write("Filtering the log data using the registration predicate\n");
          return;
        }
        if (!options.signal) throw new Error("A caret's kept-log read carries its deadline");
        reads.push(options.signal);
        options.signal.addEventListener("abort", () => {
          child.emit("error", options.signal?.reason);
          child.emit("close", null);
        });
        show(child, stdout);
      });
      return child;
    });
    const keyboard = await observePhoneKeyboard({
      simulator,
      env: {},
      evidence: scratchDir("phone-caret-outcome-"),
      children,
    });
    return { keyboard, reads, children, subscription: () => subscription };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("answers from the subscription's lines without reading the kept log", async () => {
    const { keyboard, reads, children, subscription } = await observer(() => {});
    for (const record of [field, failed, resigned])
      subscription()?.write(`${JSON.stringify(record)}\n`);
    await settle();
    await expect(keyboard.caret(pid, pressed, Date.now() + 60_000)).resolves.toEqual({
      outcome: "taken-back",
      pid,
      proof: [line(field), line(failed), line(resigned)],
    });
    expect(reads).toEqual([]);
    await keyboard.close();
    expect(children.size).toBe(0);
  });
  it("reads the kept log when the subscription dropped a line", async () => {
    const { keyboard, reads, children, subscription } = await observer((child, stdout) => {
      for (const record of [field, failed, resigned]) stdout.write(`${JSON.stringify(record)}\n`);
      stdout.end();
      queueMicrotask(() => child.emit("close", 0));
    });
    subscription()?.write(`${JSON.stringify(field)}\n`);
    await settle();
    await expect(keyboard.caret(pid, pressed, Date.now() + 60_000)).resolves.toEqual({
      outcome: "taken-back",
      pid,
      proof: [line(field), line(failed), line(resigned)],
    });
    expect(reads.map((read) => read.aborted)).toEqual([false]);
    await keyboard.close();
    expect(children.size).toBe(0);
  });
  it("ends a kept-log read at the deadline and answers unknown with what the subscription heard", async () => {
    const { keyboard, reads, children, subscription } = await observer(() => {});
    subscription()?.write(`${JSON.stringify(field)}\n`);
    await settle();
    await expect(keyboard.caret(pid, pressed, Date.now() + 40)).resolves.toEqual({
      outcome: "unknown",
      pid,
      proof: [line(field)],
    });
    expect(reads.map((read) => read.aborted)).toEqual([true]);
    await keyboard.close();
    expect(children.size).toBe(0);
  });
  it("still fails when the kept log cannot be read before the deadline, never calling that unknown", async () => {
    const { keyboard } = await observer((child, stdout) => {
      stdout.end();
      queueMicrotask(() => child.emit("close", 1));
    });
    await expect(keyboard.caret(pid, pressed, Date.now() + 60_000)).rejects.toThrow(
      "log show exited with 1",
    );
    await keyboard.close();
  });
});
