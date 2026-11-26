import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observePhoneKeyboard,
  PhonePickerPreviews,
  phoneLogMilliseconds,
} from "./helpers/phoneKeyboard";
import { observePhoneLog } from "./helpers/phoneLogs";
import { logTime } from "./helpers/phonePhotos";
import { photosPicker, photoTapBegan, pickerHeld } from "./helpers/phonePickerReadings";
import { scratchDir } from "./helpers/scratchDirs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

// The card list's tap, copied from tests/phone-keyboard.test.ts: a backboardd reading that is not the photo picker's.
const listTap = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-26 21:03:58.314000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10ab23560; touchScreen; builtin; senderID: 0x109C09400001A; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};

afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});

// INF-1477 (the captain's choice "Allow one more photo tap"): phone run 40486884004's iPhone talk part, at the
// compact log's millisecond times in that virtual Mac's UTC. The iPhone delivered the second photo tap, but its lift
// reached the photo picker 1.65 seconds late: the picker opened the photo's preview, then logged its context menu
// line as it handled the lift, and chose nothing.
const pickerPreviewOpened = {
  processImagePath: photosPicker,
  timestamp: "2026-10-27 11:06:58.651000+0000",
  eventMessage:
    "Current asset changed and not scrubbing. UUID: B84E8479-475C-4727-A4A4-B77AA9980897",
};
// When testmanagerd began synthesizing that photo tap, and when the runner asked for the next tap's outcome.
const nextTapBegan = phoneLogMilliseconds("2026-10-27 11:07:28.133000+0000");

// INF-2305: main run 41429548461's rest iPhone logged this real Photos response in simulator-live.log
// (line 405931), but its narrow registration stream omitted it. The test home recorded this press's start.
const restPhotoPress = Date.parse("2026-11-02T13:28:54.217Z");
const restPickerHeld = {
  processImagePath: photosPicker,
  timestamp: "2026-11-02 13:28:56.433000+0000",
  eventMessage: "performAllAnimations for animator: <_UIContextMenuAnimator: 0x1107ff1b0>",
};

describe("a photo tap the picker read as a press-and-hold (INF-1477)", () => {
  it("proves the press-and-hold only by the picker's context menu line after the tap began", async () => {
    vi.useFakeTimers();
    const previews = new PhonePickerPreviews();
    let preview: unknown;
    const read = previews.preview(photoTapBegan).then((value) => {
      preview = value;
    });
    // The picker opening a preview is not the end of the press, and backboardd's lines are not the picker's.
    previews.receive(pickerPreviewOpened);
    previews.receive(listTap);
    await Promise.resolve();
    expect(preview).toBeUndefined();
    previews.receive(pickerHeld);
    await read;
    expect(preview).toEqual({
      previewed: true,
      timestamp: pickerHeld.timestamp,
      proof: pickerHeld.eventMessage,
    });
  });

  it("reads no line since the tap, or a stopped observer, as no preview, so the runner taps no more", async () => {
    vi.useFakeTimers();
    const previews = new PhonePickerPreviews();
    previews.receive(pickerHeld);
    // The earlier photo tap's preview is not the next tap's.
    const later = previews.preview(nextTapBegan);
    await vi.runAllTimersAsync();
    await expect(later).resolves.toMatchObject({
      previewed: false,
      reason: expect.stringContaining("No photo picker preview"),
    });
    const stopped = new PhonePickerPreviews();
    const pending = stopped.preview(photoTapBegan);
    stopped.close();
    await expect(pending).resolves.toMatchObject({
      previewed: false,
      reason: expect.stringContaining("observer stopped"),
    });
    stopped.receive(pickerHeld);
    await expect(stopped.preview(photoTapBegan)).resolves.toMatchObject({ previewed: false });
  });
});

// INF-2305: run 41545873258's iPad rest, simulator-live.log line 526342, and the home's press start.
// The narrow stream and the later kept log both omitted this response. The virtual Mac used UTC.
const broadPickerHeld =
  "2026-11-03 01:09:25.552 Df PhotosPicker[15243:18b70] [com.apple.UIKit:UICMILifecycle] performAllAnimations for animator: <_UIContextMenuAnimator: 0x111cc4090>";
const broadPhotoPress = Date.parse("2026-11-03T01:09:23.235Z");

describe("the existing broad log's Photos witness (INF-2305)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("delivers the real broad-only response through onLine while the other sources have none", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const evidence = scratchDir("phone-preview-broad-");
    const children = new Set<ChildProcess>();
    const simulator = "FD8EB24A-6434-4959-842F-1E3AB3D1B415";
    let broad: PassThrough | undefined;
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      if (args.includes("compact")) broad = stdout;
      queueMicrotask(() => {
        if (args.includes("stream"))
          stdout.write("Filtering the log data using the requested predicate\n");
        else end(0); // The actual failure's later log show held no preview witness either.
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    const log = await observePhoneLog({
      device: simulator,
      env: {},
      evidence,
      children,
      predicate: 'process == "PhotosPicker"',
      onLine: observer.previewLine,
    });
    try {
      let answered = false;
      const read = observer.preview(broadPhotoPress).then((result) => {
        answered = true;
        return result;
      });
      const split = broadPickerHeld.indexOf("performAllAnimations");
      broad?.write(broadPickerHeld.slice(0, split));
      await Promise.resolve();
      expect(answered).toBe(false);
      broad?.write(`${broadPickerHeld.slice(split)}\n`);
      await vi.advanceTimersToNextTimerAsync();
      await expect(read).resolves.toEqual({
        previewed: true,
        timestamp: "2026-11-03 01:09:25.552+0000",
        proof: broadPickerHeld.slice(split),
      });
      expect(spawn.mock.calls.filter(([, args]) => args.includes("stream"))).toHaveLength(2);
    } finally {
      await observer.close();
      await log.close();
    }
    expect(children.size).toBe(0);
  });

  it("keeps process, message, press-time and deadline boundaries for broad records", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const at = Date.parse("2026-11-03T01:09:25.552Z");
    // Controlled negatives derived from the captured response: a BackBoard sender, the different
    // completion message seen in run 41464279524, and a request that begins after this response.
    for (const [line, since] of [
      [broadPickerHeld.replace("PhotosPicker[", "backboardd["), broadPhotoPress],
      [broadPickerHeld.replace("performAllAnimations", "performAllCompletions"), broadPhotoPress],
      [broadPickerHeld, at + 1],
    ] as const) {
      const previews = new PhonePickerPreviews();
      const read = previews.preview(since);
      const original = new PhonePickerPreviews().preview(since);
      previews.receiveLine(line);
      await vi.advanceTimersToNextTimerAsync();
      expect(await read).toEqual(await original);
      expect(await read).toMatchObject({ previewed: false });
      previews.receiveLine(broadPickerHeld);
      expect(await read).toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a real Photos preview omitted by the live observer (INF-2305)", () => {
  it("reads the same timestamped Photos witness once from the kept log", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async (_since: number, _signal: AbortSignal) => [restPickerHeld]);
    const previews = new PhonePickerPreviews(recover);
    await expect(previews.preview(restPhotoPress)).resolves.toEqual({
      previewed: true,
      timestamp: restPickerHeld.timestamp,
      proof: restPickerHeld.eventMessage,
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith(restPhotoPress, expect.any(AbortSignal));
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    // A cached live witness requires no kept-log read.
    const cached = vi.fn(async () => []);
    const live = new PhonePickerPreviews(cached);
    live.receive(restPickerHeld);
    await expect(live.preview(restPhotoPress)).resolves.toMatchObject({ previewed: true });
    expect(cached).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts an older preview, another process, or a failed read as this press's proof", async () => {
    vi.useFakeTimers();
    for (const recover of [
      async () => [pickerHeld, listTap, pickerPreviewOpened],
      async () => {
        throw new Error("log show exited with 1");
      },
    ]) {
      const read = new PhonePickerPreviews(recover).preview(restPhotoPress);
      await vi.runAllTimersAsync();
      await expect(read).resolves.toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline and ignores records arriving after it", async () => {
    vi.useFakeTimers();
    let release!: (records: object[]) => void;
    const pending = new Promise<object[]>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
    const previews = new PhonePickerPreviews(recover);
    const read = previews.preview(restPhotoPress);
    const unchanged = new PhonePickerPreviews().preview(restPhotoPress);
    await vi.advanceTimersToNextTimerAsync();
    expect(await read).toEqual(await unchanged);
    expect(await read).toMatchObject({ previewed: false });
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    release([restPickerHeld]);
    await pending;
    expect(await read).toMatchObject({ previewed: false });
    // The expired read must not cache its late witness for a later caller either.
    recover.mockResolvedValue([]);
    const later = previews.preview(restPhotoPress);
    await vi.runAllTimersAsync();
    await expect(later).resolves.toMatchObject({ previewed: false });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "stopped"])(
    "cancels the kept-log read when the %s observer settles",
    async (outcome) => {
      vi.useFakeTimers();
      let release!: (records: object[]) => void;
      const pending = new Promise<object[]>((resolve) => {
        release = resolve;
      });
      const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
      const previews = new PhonePickerPreviews(recover);
      const read = previews.preview(restPhotoPress);
      await Promise.resolve();
      if (outcome === "live") previews.receive(restPickerHeld);
      else previews.close();
      await expect(read).resolves.toMatchObject({ previewed: outcome === "live" });
      expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
      release([restPickerHeld]);
      await pending;
      await expect(read).resolves.toMatchObject({ previewed: outcome === "live" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the owned simulator's existing log reader for a missing preview", async () => {
    const evidence = scratchDir("phone-preview-recovery-");
    const children = new Set<ChildProcess>();
    const simulator = "E97A9867-4D42-4251-85CD-7785C10EDB3D";
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      queueMicrotask(() => {
        if (args.includes("stream")) {
          stdout.write("Filtering the log data using the registration predicate\n");
        } else {
          expect(args.slice(0, 5)).toEqual(["simctl", "spawn", simulator, "log", "show"]);
          expect(args[args.indexOf("--start") + 1]).toBe(logTime(new Date(restPhotoPress)));
          stdout.write(`${JSON.stringify(restPickerHeld)}\n`);
          end(0);
        }
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    await expect(observer.preview(restPhotoPress)).resolves.toMatchObject({
      previewed: true,
      proof: restPickerHeld.eventMessage,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    await observer.close();
    expect(children.size).toBe(0);
  });
});

// INF-2444: main run 41627462640's iPhone rest, the press PhoneJourney.swift:759 asked about. The test home's answer
// named the press's start; the narrow stream held no Photos record; the virtual Mac's kept log (17-xcrun.log) held the
// response and its two completions only as unreadable records. These are those compact lines and their ndjson form,
// which `log show --style ndjson` writes for an unreadable shared-cache message with its process, subsystem and
// category intact. Their neighbours are the same log's other unreadable Photos records of that second.
const unreadablePress = Date.parse("2026-11-03T12:56:07.809Z");
const unreadableLines = [
  "2026-11-03 12:56:09.811 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
  "2026-11-03 12:56:10.551 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
  "2026-11-03 12:56:10.552 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
];
const unreadableNeighbours = [
  "2026-11-03 12:56:09.822 Df PhotosPicker[28117:347f8] [com.apple.UIKit:EventDispatch] <compose failure [shared UUID]>",
  "2026-11-03 12:56:09.840 Df PhotosPicker[28117:347f8] [com.apple.photos.ui:OneUp] <compose failure [shared UUID]>",
];
function keptRecord(line: string) {
  const [, time, process = "", subsystem, category, eventMessage] =
    /^(\S+ \S+) \S+ +([^[]+)\[[^\]]+\] \[([^:\]]+):([^\]]+)\] (.*)$/.exec(line) ?? [];
  return {
    processImagePath: photosPicker.replaceAll("PhotosPicker", process),
    timestamp: `${time}000+0000`,
    subsystem,
    category,
    formatString: "",
    eventMessage,
  };
}
const unreadableResponse = keptRecord(unreadableLines[0] ?? "");

describe("a Photos response the kept log holds without its words (INF-2444)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the press from the kept log's first unreadable context menu record after it", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async (_since: number, _signal: AbortSignal) =>
      [...unreadableNeighbours, ...unreadableLines].map(keptRecord),
    );
    const read = new PhonePickerPreviews(recover).preview(unreadablePress);
    // The original deadline passes either way: only the kept records can make this answer true.
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({
      previewed: true,
      timestamp: unreadableResponse.timestamp,
      proof: "[com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith(unreadablePress, expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the same unreadable record on the broad stream's compact line", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const previews = new PhonePickerPreviews();
    const read = previews.preview(unreadablePress);
    for (const line of unreadableNeighbours) previews.receiveLine(line);
    await Promise.resolve();
    previews.receiveLine(unreadableLines[0] ?? "");
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({
      previewed: true,
      timestamp: "2026-11-03 12:56:09.811+0000",
      proof: "[com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never takes another category, another process, a record before the press or another readable line", async () => {
    vi.useFakeTimers();
    // Controlled negatives derived from the captured response: the same record from the app, a press after all
    // three, the readable completion the same run's iPad logged in this category, and the record with no category.
    const cases: [object[], number][] = [
      [unreadableNeighbours.map(keptRecord), unreadablePress],
      [
        [keptRecord((unreadableLines[0] ?? "").replace("PhotosPicker[", "Infinitary["))],
        unreadablePress,
      ],
      [unreadableLines.map(keptRecord), phoneLogMilliseconds("2026-11-03 12:56:10.553000+0000")],
      [
        [
          {
            ...unreadableResponse,
            eventMessage:
              "performAllCompletions for animator: <_UIContextMenuAnimator: 0x1114ef510>",
          },
        ],
        unreadablePress,
      ],
      [[{ ...unreadableResponse, subsystem: undefined, category: undefined }], unreadablePress],
    ];
    for (const [records, since] of cases) {
      const read = new PhonePickerPreviews(async () => records).preview(since);
      await vi.runAllTimersAsync();
      await expect(read).resolves.toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers the owned simulator's unreadable kept record to the press's answer", async () => {
    const evidence = scratchDir("phone-preview-unreadable-");
    const children = new Set<ChildProcess>();
    const simulator = "C199C565-5DE7-4346-BFB2-4C3BD7780141";
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      queueMicrotask(() => {
        if (args.includes("stream")) {
          stdout.write("Filtering the log data using the registration predicate\n");
        } else {
          for (const line of [...unreadableNeighbours, ...unreadableLines])
            stdout.write(`${JSON.stringify(keptRecord(line))}\n`);
          end(0);
        }
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    await expect(observer.preview(unreadablePress)).resolves.toMatchObject({
      previewed: true,
      timestamp: unreadableResponse.timestamp,
    });
    await observer.close();
    expect(children.size).toBe(0);
  });
});
