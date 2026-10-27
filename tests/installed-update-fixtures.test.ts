import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper";
import { describe, expect, it, vi } from "vitest";
import { runInstallerCommand } from "../scripts/installer-command";
import { verifyInstallerTicket } from "../scripts/installer-ticket";
import {
  installStageRecorder,
  keepShipItLogs,
  shipItCache,
} from "../scripts/installer-update-trace";
import { runMove } from "../src/core/folderMove/move";
import { hostEnv } from "../src/core/hostEnv";
import { RETIRED_PROFILE_MARKER } from "../src/core/storage/retiredProfile";
import { resetMacDownloadCache } from "./fixtures/installed-updates/downloadCache";
import { readInstalledVersion } from "./fixtures/installed-updates/readVersion";
import { assertSavedWorkMoved, seedSavedWork } from "./fixtures/installed-updates/savedWork";
import { scratchDir } from "./helpers/scratchDirs";

// Integration: the actual folder mover uses the system copier and SQLite on
// scratch data. Keep the default five-second budget; no signed app is launched.
const require = createRequire(import.meta.url);
const asarPath = require.resolve("@electron/asar", {
  paths: [require.resolve("electron-builder")],
});
const asar = require(asarPath) as {
  createPackage: (source: string, target: string) => Promise<void>;
};
const wrappedFs = require(join(dirname(asarPath), "wrapped-fs.js")).default as {
  openSync: typeof import("node:fs").openSync;
};
const versions = JSON.parse(
  readFileSync(join(__dirname, "fixtures/installed-updates/versions.json"), "utf8"),
) as { alphaAfter: string; promotedStable: string };
const manifest = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

async function archiveAt(root: string, version: string, corrupt = false): Promise<string> {
  const source = join(root, version);
  mkdirSync(source, { recursive: true });
  const body = JSON.stringify({ ...manifest, version }, null, 2);
  const following = readFileSync(join(__dirname, "../README.md"), "utf8");
  writeFileSync(join(source, "package.json"), body + (corrupt ? following : ""));
  copyFileSync(join(__dirname, "../README.md"), join(source, "readme.md"));
  const archive = `${source}.asar`;
  await asar.createPackage(source, archive);
  return archive;
}

// INF-1248 reproduced stapler's exit 65 with this reason on stdout and empty
// stderr. Exercise the fixture's actual command runner without invoking Apple,
// a signature tool, or any keychain; the child only replays that observed result.
it("retains stdout, status and signal when a verification command fails", () => {
  const reason = "Infinitary.app does not have a ticket stapled to it.";
  expect(() =>
    runInstallerCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1]); process.exitCode = 65", reason],
      hostEnv(),
    ),
  ).toThrow(`failed (status 65, signal null): ${reason}`);
  expect(() =>
    runInstallerCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('Processing'); process.stderr.write(process.argv[1]); process.exitCode = 65",
        reason,
      ],
      hostEnv(),
    ),
  ).toThrow(`failed (status 65, signal null): ${reason}`);
  expect(() =>
    runInstallerCommand(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      hostEnv(),
    ),
  ).toThrow("failed (status null, signal SIGTERM)");
});

// INF-1539 (captain approved on the fix-and-recheck card): run 40444437680's
// live stapler lookup lost its network after a Homebrew upgrade although the
// installed ticket matched. Installed checks now require the exact ticket the
// build validated, offline, and must fail on a missing, changed or unreadable one.
it("requires the installed stapled ticket to match the build-validated ticket without a live lookup", () => {
  const root = scratchDir("inf-installed-ticket-");
  const app = join(root, "Infinitary.app");
  const ticket = join(app, "Contents/CodeResources");
  const archive = join(root, "fixture.zip");
  mkdirSync(dirname(ticket), { recursive: true });
  copyFileSync("packaging/mac-installation.json", ticket);
  const digest = createHash("sha256").update(readFileSync(ticket)).digest("hex");
  const env = hostEnv();
  runInstallerCommand(
    "/usr/bin/python3",
    [
      "-c",
      `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.write(sys.argv[2], "Infinitary.app/Contents/CodeResources")
`,
      archive,
      ticket,
    ],
    env,
  );
  const record = vi.fn();
  const run = vi.fn((command: string, args: string[]) => runInstallerCommand(command, args, env));
  function verify(): unknown {
    run.mockClear();
    record.mockClear();
    try {
      verifyInstallerTicket(app, archive, run, record);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      expect(run.mock.calls.filter(([command]) => command === "/usr/bin/xcrun")).toHaveLength(0);
    }
  }
  function mismatch() {
    expect(verify()).toBeInstanceOf(Error);
    expect(record).toHaveBeenCalledTimes(1);
    return JSON.parse(record.mock.calls[0]![1]);
  }
  expect(verify()).toBeUndefined();
  expect(record).not.toHaveBeenCalled();
  rmSync(ticket);
  expect(mismatch()).toEqual({
    installed: { exists: false },
    fixture: { exists: true, sha256: digest },
    matches: false,
  });
  copyFileSync("README.md", ticket);
  expect(mismatch()).toMatchObject({ installed: { exists: true }, matches: false });
  copyFileSync("packaging/mac-installation.json", ticket);
  rmSync(archive);
  expect(mismatch()).toMatchObject({
    fixture: { exists: null, error: expect.any(String) },
    matches: false,
  });
});

// INF-643 run 40141491758: fresh() removed the shared Library/Caches root
// and failed with ENOTEMPTY. Reproduce the overbroad deletion, not an invented
// cache writer: another owner's open file and directory must survive reset,
// while the actual updater can no longer reuse its previous download.
it("resets the configured download cache without deleting another cache owner's files", async () => {
  const home = scratchDir("inf-installed-cache-");
  const cacheRoot = join(home, "Library/Caches");
  const otherCache = join(cacheRoot, "another-owner", "active-cache");
  mkdirSync(dirname(otherCache), { recursive: true });
  const rootInode = statSync(cacheRoot).ino;
  const openCache = openSync(otherCache, "a+");
  const config = join(__dirname, "../packaging/app-update.yml");
  const { AppUpdater } = require("electron-updater/out/AppUpdater") as {
    AppUpdater: new (
      options: null,
      app: {
        version: string;
        baseCachePath: string;
        appUpdateConfigPath: string;
      },
    ) => { getOrCreateDownloadHelper: () => Promise<DownloadedUpdateHelper> };
  };
  const newCacheReader = () =>
    new AppUpdater(null, {
      version: versions.alphaAfter,
      baseCachePath: cacheRoot,
      appUpdateConfigPath: config,
    }).getOrCreateDownloadHelper();
  try {
    writeSync(openCache, "before reset\n");
    // The first install has no previous download cache to remove.
    resetMacDownloadCache(home, config);
    const cache = await newCacheReader();
    // A real small ASAR supplies opaque transport bytes; this test does not
    // claim a ZIP, signature or native replacement has been verified.
    const archive = await archiveAt(home, versions.alphaAfter);
    const name = "cached-app.asar";
    const downloaded = join(cache.cacheDirForPendingUpdate, name);
    mkdirSync(dirname(downloaded), { recursive: true });
    copyFileSync(archive, downloaded);
    const fileInfo = {
      url: new URL(
        `https://github.com/infinitary-labs/infinitary/releases/download/v${versions.alphaAfter}/${name}`,
      ),
      info: {
        url: name,
        sha512: createHash("sha512").update(readFileSync(archive)).digest("base64"),
      },
    };
    const info = {
      version: versions.alphaAfter,
      files: [fileInfo.info],
      path: fileInfo.info.url,
      sha512: fileInfo.info.sha512,
      releaseDate: statSync(archive).mtime.toISOString(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await cache.setDownloadedFile(downloaded, null, info, fileInfo, name, true);
    expect(
      await (await newCacheReader()).validateDownloadedPath(downloaded, info, fileInfo, logger),
    ).toBe(downloaded);

    resetMacDownloadCache(home, config);

    expect(
      await (await newCacheReader()).validateDownloadedPath(downloaded, info, fileInfo, logger),
    ).toBeNull();
    expect(existsSync(cache.cacheDir)).toBe(false);
    expect(statSync(cacheRoot).ino).toBe(rootInode);
    writeSync(openCache, "after reset\n");
    expect(readFileSync(otherCache, "utf8")).toBe("before reset\nafter reset\n");
    console.log(
      "Cache reset: previous artifact is not reusable; shared root and another owner's live file remain intact.",
    );
  } finally {
    closeSync(openCache);
  }
});

// The scoped reset must refuse a configuration that would regain ownership
// of the shared directory (or its parent), even in a disposable home.
it.each([".", ".."])('refuses the shared cache identity "%s" before removing files', (name) => {
  const home = scratchDir("inf-installed-cache-boundary-");
  const config = join(home, "app-update.yml");
  const otherCache = join(home, "Library/Caches/another-owner/active-cache");
  mkdirSync(dirname(otherCache), { recursive: true });
  writeFileSync(otherCache, "still owned elsewhere\n");
  writeFileSync(config, `updaterCacheDirName: ${name}\n`);
  expect(() => resetMacDownloadCache(home, config)).toThrow("one directory");
  expect(readFileSync(otherCache, "utf8")).toBe("still owned elsewhere\n");
});

// INF-643: the signed probe must observe native replacement, not fail because
// its own ASAR reader combines one version's header with another's payload.
describe("installed-update observations", () => {
  // INF-1539: the captain chose "Add logging and recheck once" after Apple
  // silicon's first replacement downloaded and then stalled with no record of
  // which stage it reached. The recheck must keep ShipIt's own files and a
  // timeline of what the probe saw.
  it("keeps ShipIt's logs from the scratch home and records each install stage once", () => {
    const home = scratchDir("shipit-home-");
    const evidence = scratchDir("shipit-evidence-");
    const appId = "com.getinfinitary.infinitary";
    const cache = shipItCache(home, appId);
    // The layout Squirrel.Mac left in run 40463274324: a staged update folder beside its logs.
    mkdirSync(join(cache, "update.apD0xjr"), { recursive: true });
    writeFileSync(join(cache, "update.apD0xjr", "update.zip"), "staged");
    writeFileSync(join(cache, "ShipIt_stderr.log"), "Installation error: code requirement\n");
    writeFileSync(join(cache, "ShipItState.plist"), "<plist/>");

    expect(keepShipItLogs(home, appId, evidence, "upgrade-0.5.0-alpha.10")).toEqual([
      "upgrade-0.5.0-alpha.10-ShipIt_stderr.log",
      "upgrade-0.5.0-alpha.10-ShipItState.plist",
    ]);
    expect(
      readFileSync(join(evidence, "upgrade-0.5.0-alpha.10-ShipIt_stderr.log"), "utf8"),
    ).toContain("code requirement");
    expect(existsSync(join(evidence, "upgrade-0.5.0-alpha.10-update.zip"))).toBe(false);
    expect(keepShipItLogs(scratchDir("shipit-empty-"), appId, evidence, "final")).toEqual([]);

    let clock = Date.parse("2026-10-27T07:54:05Z");
    const stage = installStageRecorder(evidence, "upgrade-0.5.0-alpha.10", () => new Date(clock));
    const running = {
      appRunning: true,
      shipItRunning: false,
      installedVersion: "0.5.0-alpha.9",
      phase: "downloading",
      problem: null,
    };
    expect(stage(running)).toBe(true);
    clock += 2_000;
    expect(stage({ ...running })).toBe(false);
    clock += 2_000;
    expect(stage({ ...running, appRunning: false, shipItRunning: true, phase: null })).toBe(true);
    const lines = readFileSync(join(evidence, "install-stages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.at, line.shipItRunning])).toEqual([
      ["2026-10-27T07:54:05.000Z", false],
      ["2026-10-27T07:54:09.000Z", true],
    ]);
  });

  it("reads one archive when replacement occurs between the ASAR reader's opens", async () => {
    const root = scratchDir("inf-installed-version-");
    const app = join(root, "Infinitary.app");
    const live = join(app, "Contents/Resources/app.asar");
    const snapshot = join(root, "observation.asar");
    mkdirSync(dirname(live), { recursive: true });
    const before = await archiveAt(root, versions.alphaAfter);
    const after = await archiveAt(root, versions.promotedStable);
    copyFileSync(before, live);
    let opens = 0;
    let replaced = false;
    const open = wrappedFs.openSync;
    const observation = vi.spyOn(wrappedFs, "openSync").mockImplementation((file, ...args) => {
      if ((file === live || file === snapshot) && ++opens === 2) {
        renameSync(after, live);
        replaced = true;
      }
      return open(file, ...args);
    });
    try {
      expect(readInstalledVersion(app, snapshot)).toBe(versions.alphaAfter);
      expect(replaced).toBe(true);
      expect(existsSync(snapshot)).toBe(false);
    } finally {
      observation.mockRestore();
    }
    expect(readInstalledVersion(app, snapshot)).toBe(versions.promotedStable);
    expect(existsSync(snapshot)).toBe(false);
  });

  it("reports a missing replacement as unobserved and still rejects malformed content", async () => {
    const root = scratchDir("inf-installed-version-refusal-");
    const app = join(root, "Infinitary.app");
    const live = join(app, "Contents/Resources/app.asar");
    const snapshot = join(root, "observation.asar");
    expect(readInstalledVersion(app, snapshot)).toBeUndefined();
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(await archiveAt(root, versions.promotedStable, true), live);
    expect(() => readInstalledVersion(app, snapshot)).toThrow(SyntaxError);
    expect(existsSync(snapshot)).toBe(false);
  });

  // INF-643's preservation promise follows the existing migration contract:
  // the retired original is the recovery copy, never a folder to delete.
  it("checks the real handover and refuses a missing or reopened recovery copy", async () => {
    const root = realpathSync(scratchDir("inf-installed-handover-"));
    const from = join(root, "firstmate-3000");
    const to = join(root, "infinitary");
    seedSavedWork(from);
    const result = await runMove(
      { from, to },
      { platform: process.platform, hostname: hostname(), claudeConfigDir: join(root, ".claude") },
    );
    expect(result.kind).toBe("moved");
    expect(() => assertSavedWorkMoved(from, to)).not.toThrow();
    rmSync(join(from, RETIRED_PROFILE_MARKER));
    expect(() => assertSavedWorkMoved(from, to)).toThrow("The recovery copy must be retired");
    rmSync(from, { recursive: true });
    expect(() => assertSavedWorkMoved(from, to)).toThrow();
  });
});
