import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { budgetTimer, waitCap } from "./budgets.ts";
import { logTime } from "./phonePhotos.ts";

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
      const group = /^\s+([a-z|]*): \((.*)\),?$/s.exec(line);
      if (group?.[1] === undefined || group[2] === undefined) continue;
      const modifiers = group[1] ? group[1].split("|") : [];
      for (const value of group[2].match(/"(?:\\.|[^"\\])*"|\([^)]*\)|[^,\s]+/g) ?? []) {
        let key = value;
        if (value === String.raw`"\^M"` || value === '"\r"') key = "\r";
        else if (value === String.raw`"\^I"` || value === String.raw`"\134t"` || value === '"\t"')
          key = "\t";
        else if (value.startsWith("(")) {
          // BackBoard's HID spellings, not XCTest's opaque key constants.
          const arrows: Record<string, string> = {
            "(50:leftArrow)": "leftArrow",
            "(4F:rightArrow)": "rightArrow",
            "(52:upArrow)": "upArrow",
            "(51:downArrow)": "downArrow",
          };
          const arrow = arrows[value];
          if (!arrow) continue;
          key = arrow;
        } else if (value.startsWith('"')) {
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
        deadline.cancel();
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
      const deadline = budgetTimer(() => {
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

export type PhoneTouchOutcome =
  | { outcome: "delivered" | "discarded"; sender: string; timestamp: string; proof: string }
  | { outcome: "unknown"; reason: string };
type TouchScreen = {
  sender: string;
  builtInTouchScreen: boolean;
  at: number;
  timestamp: string;
  line: string;
};
const touchSender = (hex: string) => hex.toLowerCase().replace(/^0+/, "");
const firstLine = (message: string) => message.split("\n", 1)[0] ?? "";

/** An ndjson record's own time ("2026-10-26 14:04:01.403588-0700"), in the runner's milliseconds. */
export function phoneLogMilliseconds(timestamp: string): number {
  const parts = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d*([+-]\d{2})(\d{2})$/.exec(
    timestamp,
  );
  if (!parts) return Number.NaN;
  return Date.parse(`${parts[1]}T${parts[2]}${parts[3] ?? ""}${parts[4]}:${parts[5]}`);
}

/**
 * INF-1477 (the captain's choice "Allow a proven second tap"): XCTest gives each synthesized tap a virtual
 * touch screen of its own. When a starved simulator's backboardd cannot read that screen's properties in
 * time, it attaches the screen as an accessory, or as a bad usage pair when it read no usage page, and
 * ignores its touches, and XCTest confirms the tap after five seconds with no error. backboardd's own lines
 * are the witness: the first screen it attached once the tap began was delivered when it read a built-in
 * touch screen, or reported a contact on that screen touching, and discarded only once backboardd reports
 * ignoring its touches. Anything else, an accessory screen or a bad usage pair alone included, is not
 * proof and reads as unknown. iOS 27.0 reads every XCTest screen as an accessory and still delivers its
 * touches, naming the screen on each contact line, as the Mac mini's iPad join part showed on Xcode 27.1.
 */
export class PhoneTouchOutcomes {
  private screens: TouchScreen[] = [];
  private ignored = new Map<string, string>();
  private touching = new Map<string, string>();
  private listeners = new Set<() => void>();
  private failure: Error | undefined;
  private recover: ((since: number, signal: AbortSignal) => Promise<object[]>) | undefined;

  constructor(recover?: (since: number, signal: AbortSignal) => Promise<object[]>) {
    this.recover = recover;
  }

  receive(record: { processImagePath?: string; eventMessage?: string; timestamp?: string }) {
    if (basename(record.processImagePath ?? "") !== "backboardd") return;
    const message = record.eventMessage ?? "";
    // What backboardd read the screen as, then where it sits. Phone run 40469903139 read one tap's screen as
    // "bad usage pair: (0x0 / 0x4); builtin" and ignored its touches, so only "touchScreen; builtin" takes them.
    const screen =
      /^init: <BKDirectTouchState: 0x[\dA-Fa-f]+; ([^;>]+); (builtin|accessory);[^>]*?\bsenderID: 0x([\dA-Fa-f]+);/.exec(
        message,
      );
    if (screen?.[1] && screen[2] && screen[3]) {
      const at = phoneLogMilliseconds(record.timestamp ?? "");
      if (Number.isNaN(at)) return;
      this.screens.push({
        sender: touchSender(screen[3]),
        builtInTouchScreen: screen[1] === "touchScreen" && screen[2] === "builtin",
        at,
        timestamp: record.timestamp ?? "",
        line: firstLine(message),
      });
    } else {
      const ignoring =
        /^ignoring digitizer event for display .*? from unsupported service: .*?\bid:0x([\dA-Fa-f]+)\b/.exec(
          message,
        );
      const touched = /^\[([\dA-Fa-f]+)\] contact \d+ presence: touching$/.exec(message);
      if (ignoring?.[1]) {
        const sender = touchSender(ignoring[1]);
        if (!this.ignored.has(sender)) this.ignored.set(sender, firstLine(message));
      } else if (touched?.[1]) {
        const sender = touchSender(touched[1]);
        if (!this.touching.has(sender)) this.touching.set(sender, message);
      } else return;
    }
    for (const notify of this.listeners) notify();
  }

  /**
   * The outcome of the tap the runner began at `since`, on its own clock in milliseconds, answered by `until` on the
   * wall clock at the latest.
   */
  outcome(since: number, until = phoneTouchDeadline()): Promise<PhoneTouchOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let recoveryFailure = "";
      const recovery = new AbortController();
      const finish = (result: PhoneTouchOutcome) => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        clearTimeout(wall);
        this.listeners.delete(check);
        recovery.abort();
        resolve(result);
      };
      const check = () => {
        if (this.failure) {
          finish({ outcome: "unknown", reason: this.failure.message });
          return;
        }
        // The runner sends nothing else between the tap's start and its outcome, so the first is its own.
        const screen = this.screens
          .filter((each) => each.at >= since)
          .sort((a, b) => a.at - b.at)[0];
        if (!screen) return;
        const { sender, timestamp } = screen;
        if (screen.builtInTouchScreen) {
          finish({ outcome: "delivered", sender, timestamp, proof: screen.line });
          return;
        }
        const touched = this.touching.get(sender);
        if (touched) {
          finish({ outcome: "delivered", sender, timestamp, proof: touched });
          return;
        }
        const ignored = this.ignored.get(sender);
        if (ignored) finish({ outcome: "discarded", sender, timestamp, proof: ignored });
      };
      // Failure deadlines, not delays: without a witness the runner sends no second tap.
      const unknown = () =>
        finish({
          outcome: "unknown",
          reason: `No touch screen witness since ${new Date(since).toISOString()}${recoveryFailure}`,
        });
      const deadline = budgetTimer(unknown, 30_000);
      const wall = setTimeout(unknown, Math.max(0, until - Date.now()));
      this.listeners.add(check);
      check();
      // INF-1917: the completed pager tap's contact was in log show but absent from log stream.
      // Read the kept log once if the stream has not answered, inside the existing wait, not after
      // its deadline (which can share the caller's wall cap). Never send another tap to find out.
      void Promise.resolve().then(async () => {
        if (settled || !this.recover) return;
        try {
          const records = await this.recover(since, recovery.signal);
          if (!settled) for (const record of records) this.receive(record);
        } catch (error) {
          recoveryFailure = `; the simulator's kept log could not be read: ${(error as Error).message}`;
        }
      });
    });
  }

  close(error = new Error("The simulator touch observer stopped")) {
    this.failure ??= error;
    for (const notify of this.listeners) notify();
  }
}

export type PhonePickerPreview =
  | { previewed: true; timestamp: string; proof: string }
  | { previewed: false; reason: string };

/**
 * INF-1477 (the captain's choice "Allow one more photo tap"): a photo tap the iPhone delivered can still reach
 * the photo picker as a press-and-hold. In phone run 40486884004 the lift reached the picker 1.65 seconds after
 * it left the screen, so the picker opened the photo's preview and chose nothing. The picker's own context
 * menu line, logged as it handles that lift, is the proof; the runner taps the photo once more only on it.
 */
export class PhonePickerPreviews {
  private previews: { at: number; timestamp: string; line: string }[] = [];
  private listeners = new Set<() => void>();
  private failure: Error | undefined;

  receive(record: { processImagePath?: string; eventMessage?: string; timestamp?: string }) {
    if (basename(record.processImagePath ?? "") !== "PhotosPicker") return;
    const message = record.eventMessage ?? "";
    if (!message.startsWith(PICKER_PREVIEW_LINE)) return;
    const at = phoneLogMilliseconds(record.timestamp ?? "");
    if (Number.isNaN(at)) return;
    this.previews.push({ at, timestamp: record.timestamp ?? "", line: firstLine(message) });
    for (const notify of this.listeners) notify();
  }

  /** The picker's first preview of a photo tap the runner began at `since`, on its own clock in milliseconds. */
  preview(since: number): Promise<PhonePickerPreview> {
    return new Promise((resolve) => {
      const finish = (result: PhonePickerPreview) => {
        deadline.cancel();
        this.listeners.delete(check);
        resolve(result);
      };
      const check = () => {
        if (this.failure) {
          finish({ previewed: false, reason: this.failure.message });
          return;
        }
        const preview = this.previews.find((each) => each.at >= since);
        if (preview) finish({ previewed: true, timestamp: preview.timestamp, proof: preview.line });
      };
      // A failure deadline, not a delay: a photo the picker chose leaves no preview, and the runner stops asking.
      const deadline = budgetTimer(
        () =>
          finish({
            previewed: false,
            reason: `No photo picker preview since ${new Date(since).toISOString()}`,
          }),
        30_000,
      );
      this.listeners.add(check);
      check();
    });
  }

  close(error = new Error("The simulator photo picker observer stopped")) {
    this.failure ??= error;
    for (const notify of this.listeners) notify();
  }
}

export type PhoneDisplayOutcome =
  | { outcome: "applied" | "missed"; timestamp: string; proof: string }
  | { outcome: "unknown"; reason: string };
/** What one display change did: its appearance, unchanged when the part already asked for it, and each text size save. */
export type PhoneDisplayReport = {
  appearance: PhoneDisplayOutcome | { outcome: "unchanged" };
  textSize?: PhoneDisplayOutcome[];
};
/** The simulator's names for the type sizes the journeys set, and the category its own log names for each. */
export const PHONE_TEXT_SIZES = {
  large: "UICTContentSizeCategoryL",
  "extra-extra-extra-large": "UICTContentSizeCategoryXXXL",
} as const;
export type PhoneTextSize = keyof typeof PHONE_TEXT_SIZES;
/** The app's own process, whose reads of the text size are the ones its screen draws with. */
const PHONE_APP_PROCESS = "Infinitary";
type DisplayReading = { value: string; at: number; timestamp: string; line: string };
/** UIKit's style numbers in SpringBoard's appearance arbiter lines. */
const ARBITER_STYLES: Record<string, "light" | "dark"> = { "1": "light", "2": "dark" };
/**
 * The journey's display requests' budget, `displayBudget` in PhoneJourney.swift; its wall cap is waitCap's formula.
 * INF-1786: as long as that cap, so the request's load clock never ends it before the appearance witness answers.
 */
export const PHONE_DISPLAY_REQUEST_BUDGET_MS = 600_000;
/**
 * INF-1799: the longest the runner reads the simulator's kept log for a witness line its live stream dropped. The
 * read covers the minutes since one display change and takes seconds; past a minute the host is too starved to answer.
 */
const PHONE_DISPLAY_RECOVERY_CAP_MS = 60_000;

/**
 * INF-1799: when every witness of a display control that began at `start` stops waiting. Both deadlines used to cap
 * at 10 minutes, so on a starved host the journey's request, sent first, ended before the runner's non-fatal unknown.
 * One recovery read's worth is left for the kept log, and one for the request's way to the runner and back.
 */
export function phoneDisplayDeadline(start = Date.now()): number {
  return start + waitCap(PHONE_DISPLAY_REQUEST_BUDGET_MS) - 2 * PHONE_DISPLAY_RECOVERY_CAP_MS;
}

/** The budget of the runner's request for a tap's outcome, `askPhoneHome` in PhoneKeys.swift; its wall cap is waitCap's. */
export const PHONE_TOUCH_REQUEST_BUDGET_MS = 40_000;

/**
 * INF-2076: when the witness of a tap whose outcome the runner asked for at `start` stops waiting. The witness's
 * 30-second load budget and the runner's request both capped at 10 minutes, so on a starved host the runner's
 * request, sent first, ended before the home's unknown reached it, and the tap failed with no answer. The kept-log
 * read runs inside the wait, so only one minute is left, as for a display request, for the request's way there and back.
 */
export function phoneTouchDeadline(start = Date.now()): number {
  return start + waitCap(PHONE_TOUCH_REQUEST_BUDGET_MS) - PHONE_DISPLAY_RECOVERY_CAP_MS;
}

/**
 * INF-1785 (the captain's choice "Confirm each change from the simulator's log, and set it once more only when the
 * log proves the phone missed it"): on a starved simulator a display change the runner asks for can miss the app.
 * In phone run 40788049243 the simulator saved the largest text size and the iPhone's app read the old size a
 * millisecond later and never again; in run 40792658138 SpringBoard applied light about 250 seconds after the runner
 * asked, past the journey's wait. Each change is confirmed by its consumer's own line: SpringBoard's appearance
 * arbiter changing to the asked style, or the app reading the asked text size. The app reading another size after the
 * simulator logged the save is the proof of a miss. An appearance miss leaves no line at all, so it is never proven.
 * INF-1799: a live stream can drop a line the simulator's kept log holds, so before a witness answers unknown it
 * reads `recover`, the kept log since the change.
 */
export class PhoneDisplayChanges {
  private styles: DisplayReading[] = [];
  private saves: DisplayReading[] = [];
  private reads: DisplayReading[] = [];
  private listeners = new Set<() => void>();
  private failure: Error | undefined;

  private recover: ((since: number) => Promise<object[]>) | undefined;

  constructor(recover?: (since: number) => Promise<object[]>) {
    this.recover = recover;
  }

  receive(record: { processImagePath?: string; eventMessage?: string; timestamp?: string }) {
    const process = basename(record.processImagePath ?? "");
    const message = record.eventMessage ?? "";
    let readings: DisplayReading[];
    let value: string | undefined;
    if (process === "SpringBoard") {
      readings = this.styles;
      value = ARBITER_STYLES[/^Arbiter changing style from \d+ to (\d+),/.exec(message)?.[1] ?? ""];
    } else if (process === "CoreSimulatorBridge") {
      readings = this.saves;
      value = /^Saved CategoryName: per-app = 0, category name = (\w+),/.exec(message)?.[1];
    } else if (process === PHONE_APP_PROCESS) {
      readings = this.reads;
      // The app also logs its web pages' reads, as "WebContent[pid] Read CategoryName", which draw no native text.
      value = /^Read CategoryName: per-app = 0, category name = (\w+)$/.exec(message)?.[1];
    } else return;
    const at = phoneLogMilliseconds(record.timestamp ?? "");
    if (!value || Number.isNaN(at)) return;
    readings.push({ value, at, timestamp: record.timestamp ?? "", line: firstLine(message) });
    for (const notify of this.listeners) notify();
  }

  /**
   * Whether SpringBoard applied the appearance the runner asked for at `since`, on its own clock in milliseconds.
   * INF-1786 (the captain's choice "Wait for SpringBoard's own line, up to the request's 8-minute limit"): in run
   * 40792658138 SpringBoard applied light 250 seconds after the request, so this waits until `until` alone.
   */
  appearance(
    since: number,
    style: "light" | "dark",
    until = phoneDisplayDeadline(),
  ): Promise<PhoneDisplayOutcome> {
    return this.witness(since, until, undefined, `SpringBoard did not change to ${style}`, () => {
      const changed = this.styles.find((each) => each.at >= since && each.value === style);
      return changed && { outcome: "applied", timestamp: changed.timestamp, proof: changed.line };
    });
  }

  /** Whether the app read the text size the runner asked for at `since`, or proved it missed the simulator's save. */
  textSize(
    since: number,
    size: PhoneTextSize,
    until = phoneDisplayDeadline(),
  ): Promise<PhoneDisplayOutcome> {
    const category = PHONE_TEXT_SIZES[size];
    return this.witness(since, until, 30_000, `the app did not read ${category}`, () => {
      const read = this.reads.find((each) => each.at >= since && each.value === category);
      if (read) return { outcome: "applied", timestamp: read.timestamp, proof: read.line };
      // A read in the save's own millisecond can come before it, as on the iPad of run 40788049243, so it proves nothing.
      const saved = this.saves.find((each) => each.at >= since && each.value === category);
      const stale = saved && this.reads.find((each) => each.at > saved.at);
      return (
        stale && {
          outcome: "missed",
          timestamp: stale.timestamp,
          proof: `${saved.line}; then ${stale.line}`,
        }
      );
    });
  }

  private witness(
    since: number,
    until: number,
    budget: number | undefined,
    missing: string,
    decide: () => PhoneDisplayOutcome | undefined,
  ): Promise<PhoneDisplayOutcome> {
    return new Promise((resolve) => {
      let stopped = false;
      const stop = () => {
        stopped = true;
        deadline?.cancel();
        clearTimeout(wall);
      };
      const finish = (result: PhoneDisplayOutcome) => {
        stop();
        this.listeners.delete(check);
        resolve(result);
      };
      const check = () => {
        if (this.failure) {
          finish({ outcome: "unknown", reason: this.failure.message });
          return;
        }
        const decided = decide();
        if (decided) finish(decided);
      };
      const giveUp = async () => {
        if (stopped) return;
        stop();
        let kept = "";
        if (this.recover && !this.failure)
          try {
            for (const record of await this.recover(since)) this.receive(record);
            kept = ", in its live or kept log";
          } catch (error) {
            kept = `; the simulator's kept log could not be read: ${(error as Error).message}`;
          }
        check();
        finish({
          outcome: "unknown",
          reason: `No display witness since ${new Date(since).toISOString()}: ${missing}${kept}`,
        });
      };
      // Failure deadlines, not delays: without a witness the runner sets nothing again.
      const deadline = budget === undefined ? undefined : budgetTimer(() => void giveUp(), budget);
      const wall = setTimeout(() => void giveUp(), Math.max(0, until - Date.now()));
      this.listeners.add(check);
      check();
    });
  }

  close(error = new Error("The simulator display observer stopped")) {
    this.failure ??= error;
    for (const notify of this.listeners) notify();
  }
}

/**
 * INF-1785: sets the text size, and once more only when the app's own read proves it missed the first save; the
 * simulator posts a save to the app again even when the size is unchanged. Two proven misses fail the part.
 */
export async function changePhoneTextSize(
  size: PhoneTextSize,
  write: () => Promise<unknown>,
  confirm: (since: number) => Promise<PhoneDisplayOutcome>,
): Promise<PhoneDisplayOutcome[]> {
  const outcomes: PhoneDisplayOutcome[] = [];
  do {
    // The runner's and the simulator's records share this Mac's clock; the save logs after this.
    const since = Date.now();
    await write();
    outcomes.push(await confirm(since));
  } while (outcomes.length < 2 && outcomes.at(-1)?.outcome === "missed");
  if (outcomes.every((outcome) => outcome.outcome === "missed"))
    throw new Error(
      `The app read the old text size after both of the simulator's saves of ${size}: ${JSON.stringify(outcomes)}`,
    );
  return outcomes;
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

/** UIKit's context menu line in the photo picker, logged as it handles a press-and-hold's lift. */
const PICKER_PREVIEW_LINE = "performAllAnimations for animator: <_UIContextMenuAnimator";

/** Registration subset of INF-355's observe.sh, limited to the runner's own simulator,
 * INF-1477's touch screen attachments, touching contacts that name their screen and ignored touches
 * from the same backboardd, the photo picker's press-and-hold, and INF-1785's display changes. */
const PHONE_KEYBOARD_LOG_PREDICATE =
  '(process == "backboardd" AND (composedMessage BEGINSWITH "new key command registrations for pid:"' +
  ' OR composedMessage BEGINSWITH "init: <BKDirectTouchState"' +
  ' OR (composedMessage BEGINSWITH "[" AND composedMessage ENDSWITH "presence: touching")' +
  ' OR composedMessage BEGINSWITH "ignoring digitizer event"))' +
  ` OR (process == "PhotosPicker" AND composedMessage BEGINSWITH "${PICKER_PREVIEW_LINE}")` +
  ' OR (process == "SpringBoard" AND composedMessage BEGINSWITH "Arbiter changing style from")' +
  ' OR (process == "CoreSimulatorBridge" AND composedMessage BEGINSWITH "Saved CategoryName: per-app = 0")' +
  ` OR (process == "${PHONE_APP_PROCESS}" AND composedMessage BEGINSWITH "Read CategoryName: per-app = 0")`;

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
    touch: (since: number) => stream.touch(since),
    preview: (since: number) => stream.preview(since),
    appearance: (since: number, style: "light" | "dark", until?: number) =>
      stream.appearance(since, style, until),
    textSize: (since: number, size: PhoneTextSize, until?: number) =>
      stream.textSize(since, size, until),
    close: () => stream.close(),
  };
}

/** INF-1799: the simulator's kept log of the witness lines since `since`, which holds lines a live stream dropped. */
function keptPhoneLog(
  options: PhoneKeyboardOptions,
  since: number,
  signal?: AbortSignal,
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const show = spawn(
      "xcrun",
      [
        "simctl",
        "spawn",
        options.simulator,
        "log",
        "show",
        "--start",
        logTime(new Date(since)),
        "--style",
        "ndjson",
        "--info",
        "--debug",
        "--predicate",
        PHONE_KEYBOARD_LOG_PREDICATE,
      ],
      { env: options.env, stdio: ["ignore", "pipe", "pipe"], signal },
    );
    options.children.add(show);
    const records: object[] = [];
    createInterface({ input: show.stdout }).on("line", (line) => {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* Non-record log diagnostics are not witnesses. */
      }
    });
    show.stderr.resume();
    // A wall cap, not a load budget: the display control's answer must still reach the journey in time.
    const cap = setTimeout(() => {
      show.kill("SIGTERM");
      reject(new Error(`it took over ${PHONE_DISPLAY_RECOVERY_CAP_MS / 1000} seconds`));
    }, PHONE_DISPLAY_RECOVERY_CAP_MS);
    show.once("error", (error) => {
      clearTimeout(cap);
      reject(error);
    });
    show.once("close", (status) => {
      clearTimeout(cap);
      options.children.delete(show);
      if (status === 0) resolve(records);
      else reject(new Error(`log show exited with ${status}`));
    });
  });
}

async function openPhoneKeyboardStream(options: PhoneKeyboardOptions, append: boolean) {
  const registrations = new PhoneKeyRegistrations();
  const touches = new PhoneTouchOutcomes((since, signal) => keptPhoneLog(options, since, signal));
  const previews = new PhonePickerPreviews();
  const displays = new PhoneDisplayChanges((since) => keptPhoneLog(options, since));
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
    touches.close(error);
    previews.close(error);
    displays.close(error);
    child.kill("SIGTERM");
  };
  void saved.catch(failed);
  const lines = createInterface({ input: child.stdout });
  // pipeline destroys its input on failure; readline forwards that error independently.
  lines.on("error", failed);
  const stopped = new Promise<void>((resolve) =>
    child.once("close", () => {
      registrations.close();
      touches.close();
      previews.close();
      displays.close();
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
      const deadline = budgetTimer(
        () => reject(new Error("The simulator keyboard log did not start")),
        15_000,
      );
      child.once("error", (error) => {
        deadline.cancel();
        registrations.close(error);
        touches.close(error);
        previews.close(error);
        displays.close(error);
        reject(error);
      });
      child.once("close", () => {
        deadline.cancel();
        reject(new Error("The simulator keyboard log exited"));
      });
      lines.on("line", (line) => {
        if (line.startsWith("Filtering the log data using ")) {
          deadline.cancel();
          resolve();
          return;
        }
        try {
          const record = JSON.parse(line);
          registrations.receive(record);
          touches.receive(record);
          previews.receive(record);
          displays.receive(record);
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
    touch: (since: number) => touches.outcome(since),
    preview: (since: number) => previews.preview(since),
    appearance: (since: number, style: "light" | "dark", until?: number) =>
      displays.appearance(since, style, until),
    textSize: (since: number, size: PhoneTextSize, until?: number) =>
      displays.textSize(since, size, until),
    close,
  };
}
