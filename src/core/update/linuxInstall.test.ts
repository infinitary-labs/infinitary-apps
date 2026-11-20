import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createLinuxInstaller, type LinuxInstallPlan } from "./linuxInstall";

// INF-2245 (INF-2223's approved stop-and-resume update): an in-app Linux
// update saves the crew's work once its download is checked and before it
// replaces anything; when that save does not finish, nothing is replaced.

const NEW_BUILD = "the new build's bytes";

function installer(spawnImpl = vi.fn()) {
  const root = scratchDir("inf-linux-install-");
  const dataRoot = join(root, "data");
  const appFolder = join(root, "apps");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(appFolder, { recursive: true });
  const target = join(appFolder, "Infinitary.AppImage");
  writeFileSync(target, "the old build's bytes");
  const relaunch = vi.fn();
  const install = createLinuxInstaller({
    dataRoot,
    fetchImpl: vi.fn(async () => new Response(NEW_BUILD)),
    env: () => ({}),
    relaunch,
    spawnImpl: spawnImpl as never,
  });
  const plan = (kind: LinuxInstallPlan["package"]): LinuxInstallPlan => ({
    package: kind,
    version: "0.6.3",
    channel: "stable",
    download: {
      url: `https://example.invalid/Infinitary-0.6.3.${kind}`,
      sha256: createHash("sha256").update(NEW_BUILD).digest("hex"),
    },
    ...(kind === "appimage" ? { appImage: target } : {}),
  });
  return { install, plan, target, appFolder, dataRoot, relaunch, spawnImpl };
}

describe("the in-app Linux update saves the crew's work before replacing the copy", () => {
  it("replaces the AppImage only after the save, then starts the new build", async () => {
    const f = installer();
    const beforeReplace = vi.fn(async () => {
      // The download is checked and waits beside the old build, untouched.
      expect(readFileSync(f.target, "utf8")).toBe("the old build's bytes");
      expect(readdirSync(f.appFolder)).toHaveLength(2);
    });
    await f.install(f.plan("appimage"), beforeReplace);
    expect(beforeReplace).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.target, "utf8")).toBe(NEW_BUILD);
    expect(f.relaunch).toHaveBeenCalledWith(f.target);
  });

  it("leaves the AppImage and starts nothing when the save does not finish", async () => {
    const f = installer();
    await expect(
      f.install(f.plan("appimage"), async () => {
        throw new Error("Update later");
      }),
    ).rejects.toThrow("Update later");
    expect(readFileSync(f.target, "utf8")).toBe("the old build's bytes");
    expect(readdirSync(f.appFolder)).toEqual(["Infinitary.AppImage"]);
    expect(f.relaunch).not.toHaveBeenCalled();
  });

  it("never asks for the system password for a package when the save does not finish", async () => {
    const f = installer();
    await expect(
      f.install(f.plan("deb"), async () => {
        throw new Error("Update later");
      }),
    ).rejects.toThrow("Update later");
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(join(f.dataRoot, "updates"))).toBe(false);
    expect(f.relaunch).not.toHaveBeenCalled();
  });
});
