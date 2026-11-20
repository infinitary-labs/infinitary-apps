import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { buildDownloadUrl, UPDATE_CHANNEL_MARKER } from "./updateChannels";
import {
  createWindowsInstaller,
  RUN_INSTALLER_SCRIPT,
  takeWindowsHandOverResult,
  WINDOWS_HAND_OVER_RESULT,
  WINDOWS_UPDATES_FOLDER,
  type WindowsInstallPlan,
  windowsHandOverScript,
} from "./windowsInstall";

// INF-4258, as INF-5230's plan re-scoped INF-4243's piece 7: a Windows copy
// downloads its channel's installer, refuses a SHA-256 mismatch, saves the
// crew's work, runs the installer silently and starts again.

const INSTALLER = "the new installer's bytes";
const VERSION = "0.8.4-alpha.3";
const RUNNING = "0.8.4-alpha.2";
const EXECUTABLE = "C:\\Users\\person\\AppData\\Local\\Programs\\Infinitary\\Infinitary.exe";
const PAGE = "https://example.invalid/releases/alpha";

/**
 * The script's process as `spawn` returns one: Windows started the
 * hand-over (exit 0), refused it (exit 1), or the script could not start.
 */
type Outcome = "started" | "refused" | "error";
function child(outcome: Outcome) {
  const emitter = new EventEmitter();
  setImmediate(() => {
    if (outcome === "error") {
      emitter.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
      return;
    }
    emitter.emit("spawn");
    emitter.emit("exit", outcome === "started" ? 0 : 1, null);
  });
  return emitter;
}

const name = `Infinitary-${VERSION}-windows-x64-setup.exe`;

function installer(
  options: {
    body?: () => Response;
    spawns?: Outcome;
    onSpawn?: (dataRoot: string) => void;
    openedOn?: string;
  } = {},
) {
  const dataRoot = join(scratchDir("inf-windows-install-"), "data");
  mkdirSync(dataRoot, { recursive: true });
  const order: string[] = [];
  const spawnImpl = vi.fn((..._args: unknown[]) => {
    order.push("spawn");
    // The installer the child is handed is the checked download, whole.
    order.push(readFileSync(join(updatesIn(dataRoot), name), "utf8"));
    options.onSpawn?.(dataRoot);
    return child(options.spawns ?? "started");
  });
  const end = vi.fn(() => {
    order.push("end");
  });
  const install = createWindowsInstaller({
    dataRoot,
    fetchImpl: vi.fn(async () => options.body?.() ?? new Response(INSTALLER)),
    env: () => ({ SystemRoot: "C:\\Windows" }),
    end,
    pid: 4242,
    currentVersion: RUNNING,
    executable: EXECUTABLE,
    ...(options.openedOn ? { openedOn: options.openedOn } : {}),
    spawnImpl: spawnImpl as never,
  });
  const plan: WindowsInstallPlan = {
    version: VERSION,
    channel: "alpha",
    download: {
      url: buildDownloadUrl(VERSION, name),
      sha256: createHash("sha256").update(INSTALLER).digest("hex"),
    },
    page: PAGE,
  };
  const saved = vi.fn(async () => {
    order.push("saved");
  });
  return { install, plan, dataRoot, spawnImpl, end, order, saved, name };
}

const updatesIn = (dataRoot: string) => join(dataRoot, WINDOWS_UPDATES_FOLDER);

describe("the in-app Windows update", () => {
  it("saves the work, hands the checked installer to Windows PowerShell and ends", async () => {
    const f = installer();
    await f.install(f.plan, f.saved);
    expect(f.order).toEqual(["saved", "spawn", INSTALLER, "end"]);
    const [program, args, spawned] = f.spawnImpl.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(program).toBe(
      join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", RUN_INSTALLER_SCRIPT]);
    // The hand-over it starts waits for this program, runs this download and
    // opens this copy again, saying what it kept as this version.
    expect(
      Buffer.from(spawned.env.INFINITARY_UPDATE_HAND_OVER as string, "base64").toString("utf16le"),
    ).toBe(
      windowsHandOverScript({
        pid: 4242,
        installer: join(updatesIn(f.dataRoot), f.name),
        executable: EXECUTABLE,
        resultFile: join(f.dataRoot, WINDOWS_HAND_OVER_RESULT),
        result: { from: RUNNING, to: VERSION },
        page: PAGE,
      }),
    );
    // The new copy follows the channel it came from.
    expect(JSON.parse(readFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), "utf8"))).toEqual({
      schemaVersion: 1,
      channel: "alpha",
      version: VERSION,
    });
  });

  it("hands over the data folder the copy was opened on, to open it again there", async () => {
    const openedOn = join(scratchDir("inf-windows-profile-"), "a person's other folder");
    const f = installer({ openedOn });
    await f.install(f.plan, f.saved);
    const [, , spawned] = f.spawnImpl.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(
      Buffer.from(spawned.env.INFINITARY_UPDATE_HAND_OVER as string, "base64").toString("utf16le"),
    ).toBe(
      windowsHandOverScript({
        pid: 4242,
        installer: join(updatesIn(f.dataRoot), f.name),
        executable: EXECUTABLE,
        dataDir: openedOn,
        resultFile: join(f.dataRoot, WINDOWS_HAND_OVER_RESULT),
        result: { from: RUNNING, to: VERSION },
        page: PAGE,
      }),
    );
  });

  it("refuses an installer whose bytes do not match the published checksum", async () => {
    const f = installer({ body: () => new Response("an installer someone changed") });
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "The download did not match its published checksum, so nothing was installed.",
    );
    expect(f.order).toEqual([]);
    expect(existsSync(updatesIn(f.dataRoot))).toBe(false);
    expect(existsSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER))).toBe(false);
  });

  it("runs nothing from a download that stopped partway", async () => {
    const f = installer({
      body: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(INSTALLER.slice(0, 8)));
              controller.error(new Error("connection reset"));
            },
          }),
        ),
    });
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "The download stopped before it finished. Try again.",
    );
    expect(f.order).toEqual([]);
    expect(existsSync(updatesIn(f.dataRoot))).toBe(false);
  });

  it("hands nothing over when the work is not saved", async () => {
    const f = installer();
    await expect(
      f.install(f.plan, async () => {
        throw new Error("Update later");
      }),
    ).rejects.toThrow("Update later");
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
    expect(existsSync(updatesIn(f.dataRoot))).toBe(false);
  });

  it("hands nothing over when the new channel cannot be recorded", async () => {
    const f = installer();
    // A folder where the marker goes: the marker can be neither read nor written.
    mkdirSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER, "held"), { recursive: true });
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "Infinitary could not record the update's channel, so nothing was installed.",
    );
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
    expect(existsSync(updatesIn(f.dataRoot))).toBe(false);
  });

  it("puts the earlier channel back when the installer cannot start", async () => {
    const f = installer({ spawns: "refused" });
    const earlier = `${JSON.stringify({ schemaVersion: 1, channel: "stable", version: "0.8.3" })}\n`;
    writeFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), earlier);
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "The installer could not start, so nothing was installed.",
    );
    expect(readFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), "utf8")).toBe(earlier);
  });

  it("says so when the earlier channel cannot be put back", async () => {
    // A folder with something in it takes the marker's place while the
    // hand-over is refused, so no file can be renamed onto it.
    const f = installer({
      spawns: "refused",
      onSpawn: (dataRoot) => {
        rmSync(join(dataRoot, UPDATE_CHANNEL_MARKER));
        mkdirSync(join(dataRoot, UPDATE_CHANNEL_MARKER, "held"), { recursive: true });
      },
    });
    writeFileSync(
      join(f.dataRoot, UPDATE_CHANNEL_MARKER),
      `${JSON.stringify({ schemaVersion: 1, channel: "stable", version: "0.8.3" })}\n`,
    );
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "The installer could not start, so nothing was installed. Infinitary could not put back the update channel it followed before, so check the channel in Settings → General.",
    );
    expect(f.end).not.toHaveBeenCalled();
  });

  it.each([
    ["Windows PowerShell cannot start", "error"],
    ["Windows refuses to start the hand-over", "refused"],
  ] as const)("keeps running, and remembers no new channel, when %s", async (_, spawns) => {
    const f = installer({ spawns });
    await expect(f.install(f.plan, f.saved)).rejects.toThrow(
      "The installer could not start, so nothing was installed.",
    );
    expect(f.end).not.toHaveBeenCalled();
    expect(existsSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER))).toBe(false);
    expect(readdirSync(f.dataRoot)).toEqual([]);
  });
});

describe("what the hand-over said of an update it did not finish", () => {
  const said = (dataRoot: string, result: unknown) =>
    writeFileSync(join(dataRoot, WINDOWS_HAND_OVER_RESULT), `\uFEFF${JSON.stringify(result)}`);

  it("is read once, by the copy it kept", () => {
    const dataRoot = scratchDir("inf-windows-hand-over-");
    said(dataRoot, { outcome: "install-failed", from: RUNNING, to: VERSION });
    expect(takeWindowsHandOverResult(dataRoot, RUNNING)).toBe("install-failed");
    expect(takeWindowsHandOverResult(dataRoot, RUNNING)).toBeNull();
    expect(existsSync(join(dataRoot, WINDOWS_HAND_OVER_RESULT))).toBe(false);
  });

  it("says nothing to a copy installed since", () => {
    const dataRoot = scratchDir("inf-windows-hand-over-");
    said(dataRoot, { outcome: "shutdown-timeout", from: RUNNING, to: VERSION });
    expect(takeWindowsHandOverResult(dataRoot, VERSION)).toBeNull();
    expect(existsSync(join(dataRoot, WINDOWS_HAND_OVER_RESULT))).toBe(false);
  });
});
