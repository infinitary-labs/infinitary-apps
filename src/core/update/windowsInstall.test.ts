import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { buildDownloadUrl, UPDATE_CHANNEL_MARKER } from "./updateChannels";
import {
  createWindowsInstaller,
  RUN_INSTALLER_SCRIPT,
  WINDOWS_UPDATES_FOLDER,
  type WindowsInstallPlan,
} from "./windowsInstall";

// INF-4258, as INF-5230's plan re-scoped INF-4243's piece 7: a Windows copy
// downloads its channel's installer, refuses a SHA-256 mismatch, saves the
// crew's work, runs the installer silently and starts again.

const INSTALLER = "the new installer's bytes";
const VERSION = "0.8.4-alpha.3";

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

function installer(options: { body?: () => Response; spawns?: Outcome } = {}) {
  const dataRoot = join(scratchDir("inf-windows-install-"), "data");
  mkdirSync(dataRoot, { recursive: true });
  const order: string[] = [];
  const spawnImpl = vi.fn((..._args: unknown[]) => {
    order.push("spawn");
    // The installer the child is handed is the checked download, whole.
    const env = (_args[2] as { env: NodeJS.ProcessEnv }).env;
    order.push(readFileSync(env.INFINITARY_UPDATE_INSTALLER as string, "utf8"));
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
    spawnImpl: spawnImpl as never,
  });
  const name = `Infinitary-${VERSION}-windows-x64-setup.exe`;
  const plan: WindowsInstallPlan = {
    version: VERSION,
    channel: "alpha",
    download: {
      url: buildDownloadUrl(VERSION, name),
      sha256: createHash("sha256").update(INSTALLER).digest("hex"),
    },
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
    // It waits for this program to end and runs the installer as a silent update.
    expect(spawned.env.INFINITARY_UPDATE_WAIT).toBe("4242");
    expect(spawned.env.INFINITARY_UPDATE_INSTALLER).toBe(join(updatesIn(f.dataRoot), f.name));
    expect(RUN_INSTALLER_SCRIPT).toContain("'--updated','/S','--force-run'");
    // The new copy follows the channel it came from.
    expect(JSON.parse(readFileSync(join(f.dataRoot, UPDATE_CHANNEL_MARKER), "utf8"))).toEqual({
      schemaVersion: 1,
      channel: "alpha",
      version: VERSION,
    });
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
    // A folder where the marker goes: the marker's write fails.
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
