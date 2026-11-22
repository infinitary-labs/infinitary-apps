import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHONE_BOOT_BUDGET_MS,
  PHONE_IOS_BUILDS,
  PHONE_PIN,
  PHONE_PREWARM_BUDGET_MS,
  PREWARM_FAILURE_LOG,
  PREWARM_LOG,
  phonePrewarmFinished,
  phoneSharedCacheFolder,
  phoneSimulator,
  phoneSimulatorBooted,
  phoneXcode,
  removeEmptyPhoneSharedCache,
  SIMULATOR_CACHES,
  type SimulatorCatalog,
} from "../scripts/phone-simulator";
import { logTime } from "./helpers/phonePhotos";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1645 (the captain's "Approve and build the pin"): every Mac's phone check uses the one Xcode phone-pin.json names
// and, for each device, the iOS simulator it names, and refuses any other. A crewmate's MacBook with Xcode 27.1's real
// simctl list, trimmed to the fields read here and the three gate devices: iOS 26.4, 27.0 and a 27.1 build, which hosts
// only iPhone Duo (INF-1552), as Xcode 27.1's own 27.1 does (INF-1653). INF-4241 piece 8 (the captain's "the iPhone 16
// and iPad stay on iOS 27.0"): the Duo takes iOS 27.1 and the others keep iOS 27.0.
const catalog: SimulatorCatalog = JSON.parse(
  readFileSync("tests/fixtures/phone-simulator/xcode-27.1.json", "utf8"),
);

describe("the phone check's pinned simulator", () => {
  it.each(["iphone", "ipad", "duo"] as const)(
    "takes the runtime pinned for %s, never a newer one",
    (device) => {
      const pin = PHONE_PIN.devices[device];
      const { kind, runtime } = phoneSimulator(catalog, device);
      expect(kind.name).toBe(pin.name);
      expect([runtime.version, runtime.buildversion]).toEqual([pin.ios, pin.iosBuild]);
      // Enumeration order is not installation order or version order.
      expect(
        phoneSimulator({ ...catalog, runtimes: [...catalog.runtimes].reverse() }, device),
      ).toEqual({
        kind,
        runtime,
      });
    },
  );

  it.each(["iphone", "ipad", "duo"] as const)(
    "refuses a Mac without the runtime pinned for %s rather than taking another one",
    (device) => {
      const pin = PHONE_PIN.devices[device];
      const without = {
        ...catalog,
        runtimes: catalog.runtimes.filter((runtime) => runtime.buildversion !== pin.iosBuild),
      };
      expect(() => phoneSimulator(without, device)).toThrow(
        `needs the iOS ${pin.ios} simulator ${pin.iosBuild} for the ${pin.name}`,
      );
      expect(() => phoneSimulator(without, device)).toThrow(
        `xcodebuild -downloadPlatform iOS -buildVersion ${pin.iosBuild}`,
      );
    },
  );

  it("needs both runtimes on a phone Mac, since neither runs all three devices", () => {
    expect(PHONE_IOS_BUILDS).toEqual([
      PHONE_PIN.devices.iphone.iosBuild,
      PHONE_PIN.devices.duo.iosBuild,
    ]);
    // Each device's pinned runtime is one the other kind of device cannot run on.
    const runs = (device: "iphone" | "duo", build: string) => {
      const kind = catalog.devicetypes.find(
        (type) => type.name === PHONE_PIN.devices[device].name,
      )!;
      return catalog.runtimes
        .find((runtime) => runtime.buildversion === build)!
        .supportedDeviceTypes!.some((type) => type.identifier === kind.identifier);
    };
    expect(runs("duo", PHONE_PIN.devices.iphone.iosBuild)).toBe(false);
    expect(runs("iphone", PHONE_PIN.devices.duo.iosBuild)).toBe(false);
  });

  it("refuses the pinned runtime when it has no supported-device reading", () => {
    const unread = structuredClone(catalog);
    for (const runtime of unread.runtimes) delete runtime.supportedDeviceTypes;
    expect(() => phoneSimulator(unread, "iphone")).toThrow(
      `does not support ${PHONE_PIN.devices.iphone.name}`,
    );
  });

  it("refuses a missing requested device type rather than substituting another device", () => {
    expect(() => phoneSimulator({ ...catalog, devicetypes: [] }, "iphone")).toThrow(
      `Install the ${PHONE_PIN.devices.iphone.name} simulator device type`,
    );
  });

  it("refuses any Xcode but the pinned one, naming the reading it found", () => {
    // The Mac mini's own `xcodebuild -version` before its update.
    expect(() => phoneXcode("Xcode 26.4\nBuild version 17E192\n")).toThrow(
      `needs Xcode ${PHONE_PIN.xcode}, not 26.4`,
    );
    expect(() => phoneXcode("")).toThrow("not an unreadable Xcode");
    // A crewmate's MacBook.
    expect(() => phoneXcode(`Xcode ${PHONE_PIN.xcode}\nBuild version 27A9275\n`)).not.toThrow();
  });
});

// INF-2445: the phone check's virtual Mac (macOS 26.6.2, build 25G83) holds a folder for the pinned runtime that an
// obsolete cache build left with only its two output files. CoreSimulator named it as the simulator's cache folder, and
// the simulator's kept log wrote 14,586 of 21,017 SpringBoard records as `<compose failure [shared UUID]>`; after
// `simctl runtime dyld_shared_cache remove` took it away, the next simulator used the runtime's own cache and its kept
// log spelled out every SpringBoard record, the appearance line among them.
const OBSOLETE_BUILD =
  "update_dyld_sim_shared_cache: warning: This tool is obsolete. Simulator runtimes now have a prebuilt dyld cache\n";

describe("the pinned runtime's shared-cache folder on the Mac", () => {
  const pinned = phoneSimulator(catalog, "iphone").runtime;
  const cacheFolder = (contents: Record<string, string>) => {
    const folder = phoneSharedCacheFolder("25G83", pinned, scratchDir("phone-shared-cache-"));
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(contents)) writeFileSync(join(folder, name), text);
    return folder;
  };
  // A stand-in for `simctl runtime dyld_shared_cache remove`, which removed the folder on the virtual Mac.
  const simctlRemove = (folder: string) => {
    const calls: string[] = [];
    return {
      calls,
      remove: async () => {
        calls.push(folder);
        rmSync(folder, { recursive: true });
      },
    };
  };

  it("is the folder CoreSimulator named as the virtual Mac's simulator cache folder", () => {
    // The simulator's launchd_sim environment on the virtual Mac, without its trailing slash.
    expect(phoneSharedCacheFolder("25G83", pinned)).toBe(
      "/Library/Developer/CoreSimulator/Caches/dyld/25G83/com.apple.CoreSimulator.SimRuntime.iOS-27-0.24A434",
    );
    expect(SIMULATOR_CACHES).toBe("/Library/Developer/CoreSimulator/Caches/dyld");
  });

  it("removes the folder an obsolete cache build left, once, and says the kept log reads the cache's words", async () => {
    const folder = cacheFolder({
      "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD,
      "update_dyld_sim_shared_cache-stdout.txt": "",
    });
    const simctl = simctlRemove(folder);
    const line = await removeEmptyPhoneSharedCache(folder, simctl.remove);
    expect(simctl.calls).toEqual([folder]);
    expect(existsSync(folder)).toBe(false);
    expect(line).toBe(
      `Removed ${folder}, which held no shared cache, so the simulator uses its runtime's own cache and its kept log spells out that cache's words`,
    );
    // The next start finds nothing to remove.
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([folder]);
  });

  it("removes an empty folder too", async () => {
    const folder = cacheFolder({});
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toMatch(/^Removed /);
    expect(simctl.calls).toEqual([folder]);
  });

  it("keeps a folder that holds a cache this Mac built, as for an iOS 26 runtime", async () => {
    const folder = cacheFolder({
      dyld_sim_shared_cache_arm64: "cache",
      "dyld_sim_shared_cache_arm64.map": "map",
      "update_dyld_sim_shared_cache-stderr.txt": "",
    });
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([]);
    expect(existsSync(join(folder, "dyld_sim_shared_cache_arm64"))).toBe(true);
  });

  it("does nothing on a Mac with no folder for the runtime, as on a Mac whose system knows the runtime's own cache", async () => {
    const folder = phoneSharedCacheFolder("26B123", pinned, scratchDir("phone-shared-cache-"));
    const simctl = simctlRemove(folder);
    expect(await removeEmptyPhoneSharedCache(folder, simctl.remove)).toBeUndefined();
    expect(simctl.calls).toEqual([]);
  });

  it("names a removal that failed or left the folder, and what the kept log then cannot read", async () => {
    const failed = cacheFolder({ "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD });
    expect(
      await removeEmptyPhoneSharedCache(failed, async () => {
        throw new Error("xcrun failed (1)");
      }),
    ).toBe(
      `Could not remove ${failed}, which holds no shared cache, so the simulator's kept log cannot spell out messages whose words live in its shared cache: xcrun failed (1)`,
    );
    expect(existsSync(failed)).toBe(true);
    const kept = cacheFolder({ "update_dyld_sim_shared_cache-stderr.txt": OBSOLETE_BUILD });
    expect(await removeEmptyPhoneSharedCache(kept, async () => {})).toBe(
      `Removing ${kept}, which holds no shared cache, left it in place, so the simulator's kept log cannot spell out messages whose words live in its shared cache`,
    );
  });
});

// INF-3689: a release check's iPhone simulator never finished booting, and the gate's `simctl bootstatus -b` sat silent
// until the job's 90-minute limit. The pinned iPhone's real `simctl bootstatus -b` output on a Mac mini, from create to
// finished, in 15 seconds.
const BOOT_TEXT = readFileSync("tests/fixtures/phone-simulator/bootstatus-iphone-16.txt", "utf8");
const BOOT_READING = BOOT_TEXT.split("\n");
const BOOTED =
  /^Monitoring boot status for .* \(([0-9A-F-]+)\)\.$/m.exec(BOOT_TEXT)?.[1] ?? "unread";

describe("the gate's wait for a simulator to boot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A stand-in for the gate's `run` of `simctl bootstatus -b`: it prints `lines` as the boot does, then ends when
  // `finishes`, or, as a boot that never finishes, only once the wait stops it.
  const bootstatus = (lines: string[], finishes: boolean) => {
    const stops: AbortSignal[] = [];
    const boot = (stop: AbortSignal, heard: (line: string) => void) => {
      stops.push(stop);
      for (const line of lines) heard(line);
      if (finishes) return Promise.resolve(lines.join("\n"));
      return new Promise<string>((_resolve, reject) => {
        stop.addEventListener("abort", () => reject(new Error("xcrun failed (null)")), {
          once: true,
        });
      });
    };
    return { boot, stops };
  };

  it("fails a boot that never finishes once its budget has passed, naming the simulator and the step it last printed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The boot as far as its first migration step that names a plugin, where it then stays.
    const until = BOOT_READING.findIndex((line) => line.includes("Reason:Running plugin"));
    const printed = BOOT_READING.slice(0, until + 3);
    const { boot, stops } = bootstatus(printed, false);
    let ended = false;
    const waiting = phoneSimulatorBooted({ device: "iphone", simulator: BOOTED, boot }).finally(
      () => {
        ended = true;
      },
    );
    waiting.catch(() => {});
    await vi.advanceTimersByTimeAsync(PHONE_BOOT_BUDGET_MS - 1);
    expect(ended).toBe(false);
    expect(stops.map((stop) => stop.aborted)).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await waiting.then(
      () => undefined,
      (error: Error) => error.message,
    );
    // The gate stopped the boot it no longer waits for.
    expect(stops.map((stop) => stop.aborted)).toEqual([true]);
    const lastStep = printed
      .slice(printed.findLastIndex((line) => / Status=/.test(line)) + 1)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lastStep[0]).toBe("Waiting on Data Migration");
    expect(failure).toBe(
      `iphone: simulator ${BOOTED} had not finished booting after ${(PHONE_BOOT_BUDGET_MS / 60_000).toFixed(1)} minutes,` +
        ` so the gate stopped waiting; its boot last printed: ${lastStep.join("; ")}`,
    );
  });

  it("ends as soon as a boot finishes, leaving no budget running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { boot, stops } = bootstatus(BOOT_READING, true);
    await phoneSimulatorBooted({ device: "iphone", simulator: BOOTED, boot });
    expect(stops.map((stop) => stop.aborted)).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// INF-6058: on a phone Mac the simulator's scheduler ran SpringBoard's wallpaper prewarm inside the take-over part, and
// the Face ID prompt the part waited for never came. SpringBoard's real prewarm lines from that run's kept log: the
// scheduler's run request, the launch and, 45 seconds later, the end. Its lane's simulator had begun its boot about
// four minutes before the run request, and finished it about half a minute later.
const PREWARM_READING = readFileSync(
  "tests/fixtures/phone-simulator/prewarm-phone-mac.txt",
  "utf8",
).split("\n");
const PREWARM_END = PREWARM_READING.findIndex((line) =>
  line.includes("PosterBoardUpdate completed"),
);
const PREWARM_SIMULATOR = "D2CD5959-46C7-4235-9DC4-6B7936F03B11";
const PREWARM_BOOT_BEGAN = new Date(2026, 10, 22, 1, 46, 34);
const PREWARM_BOOTED = new Date(2026, 10, 22, 1, 47, 9);
// The first lines a simulator's real `log stream` of those lines printed, on a Mac mini.
const PREWARM_STREAM_STARTED = [
  "getpwuid_r did not find a match for uid 501",
  'Filtering the log data using "process == "SpringBoard" AND composedMessage CONTAINS "posterboardupdate.prewarm""',
  "Timestamp               Ty Process[PID:TID]",
];

describe("the gate's wait for a simulator's wallpaper prewarm", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // A stand-in for the gate's `run` of `xcrun`: the log stream prints its first lines and ends only once the wait stops
  // it, `say` printing each line after them; every query since boot answers `shown`.
  const simctl = (shown: string[]) => {
    const calls: string[][] = [];
    const stops: AbortSignal[] = [];
    let streamHeard: ((line: string) => void) | undefined;
    const run = async (args: string[], heard?: (line: string) => void, stop?: AbortSignal) => {
      calls.push(args);
      if (!args.includes("stream") || !heard || !stop) return shown.join("\n");
      stops.push(stop);
      streamHeard = heard;
      for (const line of PREWARM_STREAM_STARTED) heard(line);
      return new Promise<string>((_resolve, reject) => {
        stop.addEventListener("abort", () => reject(new Error("xcrun failed (null)")), {
          once: true,
        });
      });
    };
    return { run, calls, stops, say: (line: string) => streamHeard?.(line) };
  };
  const since = (predicate: string, ...info: string[]) => [
    "simctl",
    "spawn",
    PREWARM_SIMULATOR,
    "log",
    "show",
    "--style",
    "compact",
    ...info,
    "--start",
    logTime(PREWARM_BOOT_BEGAN),
    "--predicate",
    predicate,
  ];

  it("waits through the prewarm's run and ends when SpringBoard says it finished, stopping its stream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(PREWARM_BOOTED);
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    // Before the stream began the scheduler had not run the prewarm yet; then it runs it, as on the phone Mac.
    const { run, calls, stops, say } = simctl(PREWARM_READING.slice(0, 2));
    let ended = false;
    const waiting = phonePrewarmFinished({
      device: "iphone",
      simulator: PREWARM_SIMULATOR,
      booting: PREWARM_BOOT_BEGAN,
      run,
    }).finally(() => {
      ended = true;
    });
    for (const line of PREWARM_READING.slice(2, PREWARM_END)) say(line);
    await vi.advanceTimersByTimeAsync(
      new Date(2026, 10, 22, 1, 51, 32).getTime() - PREWARM_BOOTED.getTime(),
    );
    expect(ended).toBe(false);
    for (const line of PREWARM_READING.slice(PREWARM_END, PREWARM_END + 1)) say(line);
    await waiting;
    expect(calls).toEqual([
      [
        "simctl",
        "spawn",
        PREWARM_SIMULATOR,
        "log",
        "stream",
        "--style",
        "compact",
        "--predicate",
        PREWARM_LOG,
      ],
      since(PREWARM_LOG),
    ]);
    expect(stops.map((stop) => stop.aborted)).toEqual([true]);
    expect(said.mock.calls).toEqual([
      [
        `iphone: simulator ${PREWARM_SIMULATOR}'s wallpaper prewarm finished 298 seconds after its boot began`,
      ],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends on a prewarm that finished before its stream began, which the query since boot reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { run, calls, stops } = simctl(PREWARM_READING);
    await phonePrewarmFinished({
      device: "iphone",
      simulator: PREWARM_SIMULATOR,
      booting: PREWARM_BOOT_BEGAN,
      run,
    });
    expect(calls.at(-1)).toEqual(since(PREWARM_LOG));
    expect(stops.map((stop) => stop.aborted)).toEqual([true]);
  });

  it("fails a prewarm still running once its budget has passed, naming the simulator and keeping the log since boot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(PREWARM_BOOTED);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { run, calls, stops } = simctl(PREWARM_READING.slice(0, PREWARM_END));
    let ended = false;
    const waiting = phonePrewarmFinished({
      device: "iphone",
      simulator: PREWARM_SIMULATOR,
      booting: PREWARM_BOOT_BEGAN,
      run,
    }).finally(() => {
      ended = true;
    });
    waiting.catch(() => {});
    await vi.advanceTimersByTimeAsync(PHONE_PREWARM_BUDGET_MS - 1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await waiting.then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toBe(
      `iphone: simulator ${PREWARM_SIMULATOR}'s wallpaper prewarm had not finished ${(PHONE_PREWARM_BUDGET_MS / 60_000).toFixed(1)}` +
        " minutes after its boot finished, so the gate stopped waiting rather than let it run during a part",
    );
    expect(stops.map((stop) => stop.aborted)).toEqual([true]);
    // SpringBoard's wallpaper lines and the scheduler's about its task, since boot, are kept with the command logs.
    expect(calls.at(-1)).toEqual(since(PREWARM_FAILURE_LOG, "--info"));
  });
});
