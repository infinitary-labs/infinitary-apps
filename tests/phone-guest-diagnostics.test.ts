import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { type FSWatcher, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phonePartBudget } from "../scripts/phone-deadlines";
import { PHONE_PART_TIMES, partTimes, phoneExecutionArguments } from "../scripts/phone-test-plan";
import { phoneProxyReadings } from "./fixtures/phone-proxy-readings";
import {
  observePhoneLauncherLog,
  phoneLauncherLogSource,
  phoneSimulatorLogDirectory,
} from "./helpers/phoneLauncherLog";
import {
  observePhoneLookupWait,
  phoneDiagnosticSampleIntervalMs,
  phoneDiagnosticSampleSeconds,
} from "./helpers/phoneLookupWait";
import { phoneWebLaunchObservationMs } from "./helpers/phoneWebStacks";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1936, approved after-alpha diagnostic: device/PID readings from artifact 13016371608.
// Descriptor fields use lsof's machine-readable protocol; filesystem identities come from the fixture itself.
const simulator = "B0AD50AE-A822-4B59-85B6-04B82BAF532A";
const launcher = 5901;
const lookupPid = 7414;
const savedLogDirectory = `/private/var/folders/p7/f_99nxmj7s16qrxbl0cbpz4r0000gn/T/infinitary-native-ZCG3xx/home/Library/Logs/CoreSimulator/${simulator}`;
// The guest observer runs beside a cards part, sampling as long as its test may run (INF-5387's plan, piece 1).
const execution = phoneExecutionArguments(
  false,
  phonePartBudget(
    "cards-diagram",
    partTimes(readFileSync(join(import.meta.dirname, "..", PHONE_PART_TIMES), "utf8")),
  ) / 1000,
);
const captureSeconds = Number(
  execution[execution.indexOf("-maximum-test-execution-time-allowance") + 1],
);
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.useRealTimers();
});

const lookup = () =>
  Object.assign(new EventEmitter(), {
    pid: lookupPid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as ChildProcess & { stdout: PassThrough; stderr: PassThrough };

// INF-2176: keep the silent-lookup witness for the proposed guest-wide capture;
// this callback observes a wait, not a separate sample of the setuid ps child.
describe("the approved owned lookup wait observation", () => {
  it("reports silence once only after ten seconds with no output, and joins the observer", async () => {
    vi.useFakeTimers();
    const child = lookup();
    let finish!: () => void;
    const capture = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const observer = observePhoneLookupWait(child, capture);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs - 1);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledExactlyOnceWith(lookupPid);
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    expect(capture).toHaveBeenCalledTimes(1);
    let joined = false;
    const closed = observer.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish();
    await closed;
    expect(joined).toBe(true);
    // Preserve the captain's sample bounds; the proxy sampler consumes these values.
    expect(phoneDiagnosticSampleSeconds).toBe(5);
    expect(phoneDiagnosticSampleIntervalMs).toBe(100);
  });
  it.each(["stdout", "stderr"] as const)(
    "does not report silence after %s output",
    async (pipe) => {
      vi.useFakeTimers();
      const child = lookup();
      const capture = vi.fn(async () => {});
      const observer = observePhoneLookupWait(child, capture);
      child[pipe].write(" 5901 1 Fri Oct 30 21:21:56 2026 launchd_sim\n");
      await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
      expect(capture).not.toHaveBeenCalled();
      await observer.close();
    },
  );
  it.each(["exit", "close", "error"])(
    "does not report silence after the child reports %s",
    async (event) => {
      vi.useFakeTimers();
      const child = lookup();
      const capture = vi.fn(async () => {});
      const observer = observePhoneLookupWait(child, capture);
      child.emit(event, event === "error" ? new Error("spawn failed") : 0);
      await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
      expect(capture).not.toHaveBeenCalled();
      await observer.close();
    },
  );
  it("cancels an unspent observation when the native journey ends", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => {});
    const observer = observePhoneLookupWait(lookup(), capture);
    await observer.close();
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    expect(capture).not.toHaveBeenCalled();
  });
});

async function logFixture(observedDirectory = false) {
  const root = scratchDir("phone-launcher-log-");
  const recordedDirectory = join(root, simulator);
  const directory = observedDirectory
    ? join(root, `com.apple.CoreSimulator.SimDevice.${simulator}`)
    : recordedDirectory;
  await mkdir(directory);
  const path = join(directory, "launchd.log");
  await writeFile(path, "before capture\n");
  const identity = await stat(path, { bigint: true });
  const descriptor = `f9\naw\ntREG\nD0x${identity.dev.toString(16)}\ni${identity.ino}\nn${path}\n`;
  const listing = `p${launcher}\n${descriptor}`;
  const source = phoneLauncherLogSource(launcher, recordedDirectory, listing);
  const destination = join(root, "captured.log");
  const events: { event: string; detail?: Record<string, unknown> }[] = [];
  const observe = async (
    onLine?: (line: string) => void,
    watchPath?: Parameters<typeof observePhoneLauncherLog>[0]["watchPath"],
  ) => {
    const result = await observePhoneLauncherLog({
      directory: source.directory,
      source,
      destination,
      seconds: captureSeconds,
      onLine,
      watchPath,
      record: (event, detail) => events.push({ event, detail }),
    });
    closes.push(() => result.close());
    return result;
  };
  return { root, directory, path, descriptor, listing, source, destination, events, observe };
}

class LogWatcher extends EventEmitter implements FSWatcher {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

function logNotices() {
  const changed = new Map<string, () => void>();
  const watchers = new Map<string, FSWatcher>();
  const watchPath = vi.fn((path: string, notify: () => void) => {
    changed.set(path, notify);
    const watcher = new LogWatcher();
    watchers.set(path, watcher);
    return watcher;
  });
  return { changed, watchers, watchPath };
}

describe("the approved launcher file log", () => {
  it("selects the recorded owned simulator, never another device", () => {
    const listing = JSON.stringify({
      devices: {
        runtime: [
          { udid: simulator, logPath: savedLogDirectory },
          { udid: "FEC13C09-54C7-4D54-8DF9-9CC817B2062F", logPath: "/another-device" },
        ],
      },
    });
    expect(phoneSimulatorLogDirectory(simulator, listing)).toBe(savedLogDirectory);
    expect(() => phoneSimulatorLogDirectory(simulator, '{"devices":{}}')).toThrow("no unique");
  });
  it("requires one writable regular file held by the owned launcher", async () => {
    const f = await logFixture();
    expect(phoneLauncherLogSource(launcher, f.directory, f.listing + f.descriptor)).toEqual(
      f.source,
    );
    for (const listing of [
      f.listing.replace(`p${launcher}`, "p5903"),
      f.listing.replace("aw", "ar"),
      f.listing.replace("tREG", "tCHR"),
    ])
      expect(() => phoneLauncherLogSource(launcher, f.directory, listing)).toThrow("no unique");
    const other = f.descriptor.replace("f9", "f10").replace(f.path, join(f.directory, "other.log"));
    expect(() => phoneLauncherLogSource(launcher, f.directory, f.listing + other)).toThrow(
      "no unique",
    );
    expect(() =>
      phoneLauncherLogSource(
        launcher,
        f.directory,
        f.listing.replace(f.path, join(f.root, "outside.log")),
      ),
    ).toThrow("no unique");
  });
  // Captain: repair the ownership check using the observed descriptor and owned UUID.
  // Real descriptor/identity readings: run 41193851532 attempt 2, artifact 13041674115.
  it.each([
    {
      device: "iphone",
      uuid: "A5718DD1-A005-4BA9-82E2-66E63D3C26EE",
      pid: 6057,
      inode: 1300398,
      home: "wiKVtw",
    },
    {
      device: "ipad",
      uuid: "140A79A9-90A3-4189-A621-D4CA4D66854E",
      pid: 6053,
      inode: 1300395,
      home: "PXlSO9",
    },
  ])("selects $device's actual log outside the listing's logPath", ({ uuid, pid, inode, home }) => {
    const directory = `/private/var/folders/p7/f_99nxmj7s16qrxbl0cbpz4r0000gn/T/infinitary-native-${home}/home/Library/Logs/CoreSimulator/${uuid}`;
    const path = `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${uuid}/launchd.log`;
    const listing = `p${pid}\nf7\naw\ntREG\nD0x100000f\ni${inode}\nn${path}\n`;
    expect(phoneLauncherLogSource(pid, directory, listing)).toEqual({
      path,
      directory: dirname(path),
      device: 0x100000fn,
      inode: BigInt(inode),
    });
    for (const wrongPath of [
      path.replace(uuid, simulator),
      path.replace(uuid, `${uuid}-other`),
      path.replace("/launchd.log", "/nested/launchd.log"),
    ])
      expect(() =>
        phoneLauncherLogSource(pid, directory, listing.replace(path, wrongPath)),
      ).toThrow("no unique");
    expect(() => phoneLauncherLogSource(pid, directory, listing.replace("aw", "ar"))).toThrow(
      "no unique",
    );
    expect(() => phoneLauncherLogSource(launcher, directory, listing)).toThrow("no unique");
    expect(() =>
      phoneLauncherLogSource(pid, directory, listing.replace(`i${inode}\n`, "")),
    ).toThrow("no file identity");
    expect(() =>
      phoneLauncherLogSource(
        pid,
        directory,
        listing + listing.replace(`i${inode}`, `i${inode + 1}`),
      ),
    ).toThrow("identity changed");
    const second = listing.replace(path, join(directory, "launchd.log"));
    expect(() => phoneLauncherLogSource(pid, directory, listing + second)).toThrow("no unique");
  });
  it("captures the observed simulator directory without requiring the listed directory to exist", async () => {
    const f = await logFixture(true);
    const observer = await f.observe();
    await appendFile(f.path, "during capture\n");
    await observer.flush();
    await observer.close();
    expect(await readFile(f.destination, "utf8")).toBe("before capture\nduring capture\n");
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail?.complete).toBe(true);
  });
  it("refuses a directory link that loses the owned simulator identity", async () => {
    const f = await logFixture(true);
    const other = join(
      f.root,
      "com.apple.CoreSimulator.SimDevice.FEC13C09-54C7-4D54-8DF9-9CC817B2062F",
    );
    await rename(f.directory, other);
    await symlink(other, f.directory);
    await expect(f.observe()).rejects.toThrow("escapes");
  });
  it("captures existing and appended bytes, then stops at the native result", async () => {
    const f = await logFixture();
    const observer = await f.observe();
    await appendFile(f.path, "during capture\n");
    await observer.flush();
    await observer.close();
    await appendFile(f.path, "after native result\n");
    expect(await readFile(f.destination, "utf8")).toBe("before capture\nduring capture\n");
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail?.complete).toBe(true);
  });
  it("ends at the existing capture allowance even if the journey has no result", async () => {
    const f = await logFixture();
    vi.useFakeTimers();
    const observer = await f.observe();
    await vi.advanceTimersByTimeAsync(captureSeconds * 1000);
    await observer.close();
    expect(f.events.find((e) => e.event === "launcher-log-stop-requested")?.detail?.reason).toBe(
      "The existing capture allowance ended",
    );
  });
  it("refuses a source replaced between descriptor discovery and opening", async () => {
    const f = await logFixture();
    await rename(f.path, `${f.path}.old`);
    await writeFile(f.path, "replacement\n");
    await expect(f.observe()).rejects.toThrow("identity changed");
  });
  it("never follows a symlink outside the owned directory", async () => {
    const f = await logFixture();
    const outside = join(f.root, "outside.log");
    await writeFile(outside, "not captured\n");
    await rename(f.path, `${f.path}.old`);
    await symlink(outside, f.path);
    await expect(f.observe()).rejects.toThrow("escapes");
  });
  // Captain's INF-1936 proxy review: use the existing owned file, not a second log reader.
  it.each([false, true])(
    "notifies only complete appended lines, with initial partial=%s",
    async (partial) => {
      const f = await logFixture();
      const { spawned, running } = phoneProxyReadings[0];
      await writeFile(f.path, partial ? spawned.slice(0, 70) : spawned + "\n");
      const received: string[] = [];
      const observer = await f.observe((line) => received.push(line));
      expect(received).toEqual([]);
      if (partial) {
        await appendFile(f.path, spawned.slice(70) + "\n");
        await observer.flush();
        expect(received).toEqual([]);
      }
      await appendFile(f.path, running.slice(0, 70));
      await observer.flush();
      expect(received).toEqual([]);
      await appendFile(f.path, running.slice(70) + "\n");
      await observer.flush();
      expect(received).toEqual([running]);
      await observer.close();
      await appendFile(f.path, spawned + "\n");
      expect(received).toEqual([running]);
      expect(await readFile(f.destination, "utf8")).toBe(spawned + "\n" + running + "\n");
    },
  );
  // Captain's one more diagnostic run: prove live delivery even without a delayed proxy.
  // Run 41224118439 retained appended records but no live observations; notification
  // delivery is controlled here, while the file identity, bytes and native reading are real.
  it("delivers a file notice before closing even when no directory notice arrives", async () => {
    const f = await logFixture(true);
    const notices = logNotices();
    const { spawned } = phoneProxyReadings[0];
    const lines: string[] = [];
    let delivered!: () => void;
    const receipt = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const observer = await f.observe((line) => {
      lines.push(line);
      delivered();
    }, notices.watchPath);
    await appendFile(f.path, spawned + "\n");
    expect(notices.changed.has(f.path)).toBe(true);
    notices.changed.get(f.path)!();
    await receipt;
    expect(lines).toEqual([spawned]);
    expect(f.events.findLast((e) => e.event === "launcher-log-read")?.detail).toMatchObject({
      trigger: "file",
      delivered: 1,
      live: 1,
    });
    expect(f.events.some((e) => e.event === "launcher-log-closed")).toBe(false);
    // Both notifications refer to one serialized reader, not two copies of a line.
    notices.changed.get(f.directory)!();
    await observer.close();
    expect(lines).toEqual([spawned]);
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail).toMatchObject({
      complete: true,
      notifications: { file: 1, directory: 1 },
      deliveredLines: 1,
      liveLines: 1,
    });
    for (const watcher of notices.watchers.values()) expect(watcher.close).toHaveBeenCalledOnce();
  });
  it("distinguishes a closing-only read from proof of live delivery", async () => {
    const f = await logFixture();
    const notices = logNotices();
    const onLine = vi.fn();
    const observer = await f.observe(onLine, notices.watchPath);
    const { spawned } = phoneProxyReadings[0];
    await appendFile(f.path, spawned + "\n");
    await observer.close();
    expect(onLine).toHaveBeenCalledExactlyOnceWith(spawned);
    expect(f.events.findLast((e) => e.event === "launcher-log-read")?.detail).toMatchObject({
      trigger: "close",
      delivered: 1,
      live: 0,
    });
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail).toMatchObject({
      notifications: { file: 0, directory: 0 },
      deliveredLines: 1,
      liveLines: 0,
    });
  });
  it("fails closed when the file watcher reports an error", async () => {
    const f = await logFixture();
    const notices = logNotices();
    const onLine = vi.fn();
    const observer = await f.observe(onLine, notices.watchPath);
    notices.watchers.get(f.path)!.emit("error", new Error("The file watch failed"));
    await appendFile(f.path, phoneProxyReadings[0].spawned + "\n");
    notices.changed.get(f.directory)!();
    await observer.close();
    expect(onLine).not.toHaveBeenCalled();
    expect(await readFile(f.destination, "utf8")).toBe("before capture\n");
    expect(f.events.find((e) => e.event === "launcher-log-error")?.detail).toMatchObject({
      watch: "file",
      error: "Error: The file watch failed",
    });
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail?.complete).toBe(false);
  });
  it("closes the directory watcher when attaching the file watcher fails", async () => {
    const f = await logFixture();
    const notices = logNotices();
    await expect(
      f.observe(undefined, (path, notify) => {
        if (path === f.path) throw new Error("The file cannot be watched");
        return notices.watchPath(path, notify);
      }),
    ).rejects.toThrow("cannot be watched");
    expect(notices.watchers.get(f.directory)!.close).toHaveBeenCalledOnce();
  });
  it("records rotation as missing evidence instead of reading a replacement", async () => {
    const f = await logFixture();
    const observer = await f.observe();
    await rename(f.path, `${f.path}.old`);
    await writeFile(f.path, "replacement\n");
    await observer.flush();
    await observer.close();
    expect(await readFile(f.destination, "utf8")).toBe("before capture\n");
    expect(f.events.find((e) => e.event === "launcher-log-error")).toBeDefined();
    expect(f.events.find((e) => e.event === "launcher-log-closed")?.detail?.complete).toBe(false);
  });
});
