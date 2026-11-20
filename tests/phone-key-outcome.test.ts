import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observePhoneKeyboard,
  phoneKeyOutcome,
  phoneLogMilliseconds,
} from "./helpers/phoneKeyboard";
import { scratchDir } from "./helpers/scratchDirs";

// INF-5183: where the simulator sent the one key the fold part pressed on the open Duo, read from backboardd's own
// line for that press (tests/helpers/phoneKeyboard.ts). The observer's kept-log read replaces child_process.spawn
// with owned streams, as tests/phone-keyboard.test.ts does.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

afterEach(() => {
  spawn.mockReset();
});

describe("open Duo key delivery witness", () => {
  // Keyboard routes from the native iPhone control and open Duo investigation, respectively.
  const delivered = {
    processImagePath: "/usr/libexec/backboardd",
    timestamp: "2026-11-19 03:30:37.150+0000",
    eventMessage:
      "sequence starting with Keyboard event: <sq: 0x1089f4540; (<keyboardFocus; display: 3A1D0EBF-045B-4591-8C60-635F42F4EB0B; pid: 8556; token: 0x4B2C65FC>)>",
  };
  const discarded = {
    ...delivered,
    timestamp: "2026-11-19 17:54:16.398+0000",
    eventMessage: "sequence starting with Keyboard event: <sq: 0x10c614540; (no destinations)>",
  };
  it("requires an unambiguous keyboardFocus destination for the current app within the press", () => {
    const since = phoneLogMilliseconds(delivered.timestamp);
    expect(phoneKeyOutcome([delivered], 8556, since, since).outcome).toBe("delivered");
    expect(phoneKeyOutcome([delivered], 8557, since, since).outcome).toBe("unknown");
    expect(phoneKeyOutcome([delivered], 8556, since + 1, since + 2).outcome).toBe("unknown");
    expect(phoneKeyOutcome([delivered, delivered], 8556, since, since).outcome).toBe("unknown");
  });
  it("reads the helper's key on the open Duo as delivered to the app in front", () => {
    // INF-5183: an open Duo simulator, Tab pressed once through `phone-hinge key tab`.
    const pressed = {
      processImagePath: delivered.processImagePath,
      timestamp: "2026-11-19 11:14:03.663978-0800",
      eventMessage:
        "sequence starting with Keyboard event: <sq: 0x10e1f4310; (<keyboardFocus; display: 8AF25958-F0CD-4018-B5E2-12C18B2E53A7; pid: 94709; token: 0xA8B58429>)>",
    };
    const at = phoneLogMilliseconds(pressed.timestamp);
    expect(phoneKeyOutcome([pressed], 94709, at - 400, at + 150)).toEqual({
      outcome: "delivered",
      pid: 94709,
      proof: [pressed.eventMessage],
    });
  });
  it("counts typed text as no key press, since a Unicode event answers no key command", () => {
    // INF-5151: open Duo simulator run 44573190658, at the first typed character.
    const unicode = {
      processImagePath: delivered.processImagePath,
      timestamp: "2026-11-19 17:53:53.122+0000",
      eventMessage:
        "sequence starting with Unicode event: <sq: 0x10c6141c0; (<keyboardFocus; display: 25D01616-1976-4361-915A-25B2C70BD924; pid: 7784; token: 0x4F632A02>)>",
    };
    const at = phoneLogMilliseconds(unicode.timestamp);
    expect(phoneKeyOutcome([unicode], 7784, at, at)).toEqual({
      outcome: "unknown",
      pid: 7784,
      proof: [],
    });
  });
  it("distinguishes a dropped event from missing evidence", () => {
    const since = phoneLogMilliseconds(discarded.timestamp);
    expect(phoneKeyOutcome([discarded], 7784, since, since).outcome).toBe("discarded");
    expect(phoneKeyOutcome([], 7784, since, since).outcome).toBe("unknown");
  });
});

describe("a key's outcome read from the owned simulator's kept log (INF-5183)", () => {
  const simulator = "53B86A21-6C98-4ADA-B450-3067365D6B8F";
  const pressed = {
    processImagePath: "/usr/libexec/backboardd",
    timestamp: "2026-11-19 11:14:03.663978-0800",
    eventMessage:
      "sequence starting with Keyboard event: <sq: 0x10e1f4310; (<keyboardFocus; display: 8AF25958-F0CD-4018-B5E2-12C18B2E53A7; pid: 94709; token: 0xA8B58429>)>",
  };
  const at = phoneLogMilliseconds(pressed.timestamp);
  // An observer whose kept-log read does what `show` says with its stand-in child; a read ended by its signal fails
  // as Node's own does, with the abort's error and then its close.
  async function observer(show: (child: EventEmitter, stdout: PassThrough) => void) {
    const children = new Set<ChildProcess>();
    const reads: AbortSignal[] = [];
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
          stdout.write("Filtering the log data using the registration predicate\n");
          return;
        }
        if (!options.signal) throw new Error("A key's kept-log read carries the press's window");
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
      evidence: scratchDir("phone-key-outcome-"),
      children,
    });
    return { keyboard, reads, children };
  }
  it("answers where the key went when the kept log names it within the press's window", async () => {
    const { keyboard, reads, children } = await observer((child, stdout) => {
      stdout.write(`${JSON.stringify(pressed)}\n`);
      stdout.end();
      queueMicrotask(() => child.emit("close", 0));
    });
    await expect(
      keyboard.keyOutcome(94709, at - 400, at + 150, Date.now() + 60_000),
    ).resolves.toEqual({ outcome: "delivered", pid: 94709, proof: [pressed.eventMessage] });
    expect(reads.map((read) => read.aborted)).toEqual([false]);
    await keyboard.close();
    expect(children.size).toBe(0);
  });
  it("ends a read the kept log has not answered when the press's window does, and answers unknown", async () => {
    // The review's finding: the read had the kept log's own minute, so on a slow host it outlasted the journey's
    // request and the key's unknown never reached the journey. This log never answers.
    const { keyboard, reads, children } = await observer(() => {});
    await expect(keyboard.keyOutcome(94709, at - 400, at + 150, Date.now() + 40)).resolves.toEqual({
      outcome: "unknown",
      pid: 94709,
      proof: [],
    });
    expect(reads.map((read) => read.aborted)).toEqual([true]);
    await keyboard.close();
    expect(children.size).toBe(0);
  });
  it("reads nothing once the press's window has ended", async () => {
    const { keyboard, reads } = await observer(() => {});
    await expect(keyboard.keyOutcome(94709, at - 400, at + 150, Date.now() - 1)).resolves.toEqual({
      outcome: "unknown",
      pid: 94709,
      proof: [],
    });
    expect(reads).toEqual([]);
    await keyboard.close();
  });
  it("still fails when the read fails inside the window, never calling that unknown", async () => {
    const { keyboard } = await observer((child, stdout) => {
      stdout.end();
      queueMicrotask(() => child.emit("close", 1));
    });
    await expect(
      keyboard.keyOutcome(94709, at - 400, at + 150, Date.now() + 60_000),
    ).rejects.toThrow("log show exited with 1");
    await keyboard.close();
  });
});
