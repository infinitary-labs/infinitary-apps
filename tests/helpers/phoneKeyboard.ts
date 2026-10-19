import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export type PhoneChord = { key: string; modifiers: string[] };
type Registration = { pid: number; token: string; keys: Set<string>; timestamp: string };
export type PhoneKeyWitness = Omit<Registration, "keys"> & PhoneChord;
const signature = (chord: PhoneChord) => `${[...chord.modifiers].sort().join("|")}:${chord.key}`;

/** INF-355: an app-side keyCommands array is not the event router's acknowledgement. */
export class PhoneKeyRegistrations {
  private registrations = new Map<string, Registration>();
  private listeners = new Set<() => void>();
  private failure: Error | undefined;

  receive(record: { processImagePath?: string; eventMessage?: string; timestamp?: string }) {
    if (basename(record.processImagePath ?? "") !== "backboardd") return;
    const message = record.eventMessage ?? "";
    const header =
      /^new key command registrations for pid:(\d+) environment: keyboardFocus; token: (0x[\dA-Fa-f]+); keyCommands:/.exec(
        message,
      );
    if (!header?.[1] || !header[2]) return;
    const keys = new Set<string>();
    // ndjson retains a literal Return inside the quoted key; compact logs print it as \^M.
    // A carriage return must not make the whole modifier group's match disappear.
    for (const line of message.split("\n")) {
      const group = /^\s+([a-z|]+): \((.*)\),?$/s.exec(line);
      if (!group?.[1] || group[2] === undefined) continue;
      const modifiers = group[1].split("|");
      for (const value of group[2].match(/"(?:\\.|[^"\\])*"|\([^)]*\)|[^,\s]+/g) ?? []) {
        let key = value;
        if (value === String.raw`"\^M"` || value === '"\r"') key = "\r";
        else if (value.startsWith('"')) {
          try {
            key = JSON.parse(value);
          } catch {
            continue;
          }
        }
        keys.add(signature({ key, modifiers }));
      }
    }
    const pid = Number(header[1]);
    const token = header[2].toLowerCase();
    // An empty replacement removes readiness; a former command list is never a fallback.
    this.registrations.set(`${pid}:${token}`, {
      pid,
      token,
      keys,
      timestamp: record.timestamp ?? "",
    });
    for (const notify of this.listeners) notify();
  }

  wait(pid: number, chord: PhoneChord): Promise<PhoneKeyWitness> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(deadline);
        this.listeners.delete(check);
      };
      const check = () => {
        if (this.failure) {
          finish();
          reject(this.failure);
          return;
        }
        const registration = [...this.registrations.values()].find(
          (entry) => entry.pid === pid && entry.keys.has(signature(chord)),
        );
        if (registration) {
          finish();
          resolve({ pid, token: registration.token, timestamp: registration.timestamp, ...chord });
        }
      };
      // A failure deadline, not a delay before sending: only an observed acknowledgement resolves.
      const deadline = setTimeout(() => {
        finish();
        reject(new Error(`No backboard registration for app ${pid}, ${signature(chord)}`));
      }, 30_000);
      this.listeners.add(check);
      check();
    });
  }

  close(error = new Error("The simulator keyboard observer stopped")) {
    this.failure ??= error;
    for (const notify of this.listeners) notify();
  }
}

/** The simulator-wide state UIKit reads through GSEventIsHardwareKeyboardAttached. */
export const PHONE_HARDWARE_KEYBOARD_STATE = "GSEventHardwareKeyboardAttached";
// GraphicsServices packs (countryCode << 8) | (type << 16) | attached, and tests the low byte.
// 33 is the US country code XCTest's own virtual keyboard reports, so these match backboardd's values.
const HARDWARE_KEYBOARD_ATTACHED = String((33 << 8) | 1);
const HARDWARE_KEYBOARD_DETACHED = String(33 << 8);

export function hardwareKeyboardArguments(simulator: string, attached: boolean): string[] {
  return [
    "simctl",
    "spawn",
    simulator,
    "notifyutil",
    "-s",
    PHONE_HARDWARE_KEYBOARD_STATE,
    attached ? HARDWARE_KEYBOARD_ATTACHED : HARDWARE_KEYBOARD_DETACHED,
    "-p",
    PHONE_HARDWARE_KEYBOARD_STATE,
  ];
}

/**
 * UIKit publishes an app's key commands to backboardd only while a hardware keyboard is attached when
 * its deferred update runs, and XCTest's own keyboard detaches within a millisecond of a key press.
 * Attach one to the owned simulator for the acknowledgement wait; detach it again however the wait ends.
 */
export async function withPhoneHardwareKeyboard<T>(
  run: (command: string, args: string[]) => Promise<unknown>,
  simulator: string,
  wait: () => Promise<T>,
): Promise<T> {
  await run("xcrun", hardwareKeyboardArguments(simulator, true));
  try {
    return await wait();
  } finally {
    await run("xcrun", hardwareKeyboardArguments(simulator, false));
  }
}

/** launchctl's PID/status/service columns, scoped to the runner's own simulator. */
export function phoneApplicationPid(services: string, bundle: string): number {
  const pids = services.split("\n").flatMap((line) => {
    const columns = line.trim().split(/\s+/);
    const [pid, , service] = columns;
    return columns.length === 3 &&
      pid &&
      service &&
      /^\d+$/.test(pid) &&
      service.startsWith(`UIKitApplication:${bundle}[`)
      ? [Number(pid)]
      : [];
  });
  const [pid] = pids;
  if (pids.length !== 1 || pid === undefined)
    throw new Error(`Expected one running ${bundle} on the owned simulator, got ${pids.length}`);
  return pid;
}

/** Registration subset of INF-355's observe.sh, limited to the runner's own simulator. */
const PHONE_KEYBOARD_LOG_PREDICATE =
  'process == "backboardd" AND composedMessage BEGINSWITH "new key command registrations for pid:"';

type PhoneKeyboardOptions = {
  simulator: string;
  env: NodeJS.ProcessEnv;
  evidence: string;
  children: Set<ChildProcess>;
};

export async function observePhoneKeyboard(options: PhoneKeyboardOptions) {
  let stream = await openPhoneKeyboardStream(options, false);
  let generation = 1;
  return {
    // INF-82's live subscription stopped supplying records across a relaunch.
    // Renew before launching, never after a timeout or an attempted chord.
    async beforeLaunch() {
      await stream.close();
      stream = await openPhoneKeyboardStream(options, true);
      return { generation: ++generation };
    },
    wait: (pid: number, chord: PhoneChord) => stream.wait(pid, chord),
    close: () => stream.close(),
  };
}

async function openPhoneKeyboardStream(options: PhoneKeyboardOptions, append: boolean) {
  const registrations = new PhoneKeyRegistrations();
  const child = spawn(
    "xcrun",
    [
      "simctl",
      "spawn",
      options.simulator,
      "log",
      "stream",
      "--style",
      "ndjson",
      "--level",
      "debug",
      "--predicate",
      PHONE_KEYBOARD_LOG_PREDICATE,
    ],
    {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  options.children.add(child);
  const outputs = [
    pipeline(
      child.stdout,
      createGzip(),
      createWriteStream(join(options.evidence, "keyboard-registrations.ndjson.gz"), {
        flags: append ? "a" : "w",
      }),
    ),
    pipeline(
      child.stderr,
      createWriteStream(join(options.evidence, "keyboard-registrations.stderr"), {
        flags: append ? "a" : "w",
      }),
    ),
  ];
  const saved = Promise.all(outputs);
  // Handle a writer failure immediately, but also rethrow it after every writer has stopped.
  const failed = (error: Error) => {
    registrations.close(error);
    child.kill("SIGTERM");
  };
  void saved.catch(failed);
  const lines = createInterface({ input: child.stdout });
  // pipeline destroys its input on failure; readline forwards that error independently.
  lines.on("error", failed);
  const stopped = new Promise<void>((resolve) =>
    child.once("close", () => {
      registrations.close();
      options.children.delete(child);
      resolve();
    }),
  );
  const close = async () => {
    child.kill("SIGTERM");
    await stopped;
    await Promise.allSettled(outputs);
    lines.close();
    await saved;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("The simulator keyboard log did not start")),
        15_000,
      );
      child.once("error", (error) => {
        clearTimeout(deadline);
        registrations.close(error);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(deadline);
        reject(new Error("The simulator keyboard log exited"));
      });
      lines.on("line", (line) => {
        if (line.startsWith("Filtering the log data using ")) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        try {
          registrations.receive(JSON.parse(line));
        } catch {
          /* Non-record log diagnostics are not witnesses. */
        }
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    wait: (pid: number, chord: PhoneChord) => registrations.wait(pid, chord),
    close,
  };
}
