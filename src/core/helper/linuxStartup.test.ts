import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import {
  type BackgroundContext,
  backgroundState,
  readAutomaticStartup,
  readInstalled,
  type Systemctl,
  startInBackground,
  writeInstalled,
} from "./background";
import { linuxStartup, systemdRuntime } from "./linuxStartup";
import { updateHere } from "./update";

// INF-1575/INF-1617: keep joining when automatic startup is unsupported, without a next-login promise.
// Failure readings are from the plan's disposable Ubuntu 24.04 container, not localized-error matching.
const noBus = { ok: false, output: "Failed to connect to bus: No medium found" };
const noManager: Systemctl = async () => noBus;

describe("Linux automatic startup facts", () => {
  it("distinguishes the reproduced container from an inactive systemd user", async () => {
    expect(await linuxStartup(noManager, 1000, () => "unavailable")).toBe("unavailable");
    const loggedOut: Systemctl = async (args) =>
      args[0] === "--system" ? { ok: true, output: "inactive\n" } : noBus;
    expect(await linuxStartup(loggedOut, 1000, () => "systemd")).toBe("at-login");
  });
  it("keeps a working user manager under unusual system startup", async () => {
    expect(
      await linuxStartup(
        async () => ({ ok: true, output: "PATH=/usr/bin" }),
        1000,
        () => "unavailable",
      ),
    ).toBe("available");
  });
  it("never invents an absent session from failed or unreadable probes", async () => {
    expect(await linuxStartup(noManager, 1000, () => "systemd")).toBe("unknown");
    expect(await linuxStartup(noManager, 1000, () => "unknown")).toBe("unknown");
    expect(
      await linuxStartup(
        async () => {
          throw new Error("read refused");
        },
        1000,
        () => "systemd",
      ),
    ).toBe("unknown");
    expect(
      await linuxStartup(
        async (args) => (args[0] === "--system" ? { ok: true, output: "active\n" } : noBus),
        1000,
        () => "systemd",
      ),
    ).toBe("unknown");
  });
  it("reads the runtime marker and keeps unreadable facts unknown", () => {
    const dir = scratchDir("infinitary-systemd-runtime-");
    expect(systemdRuntime(join(dir, "absent"))).toBe("unavailable");
    mkdirSync(join(dir, "system"));
    expect(systemdRuntime(join(dir, "system"))).toBe("systemd");
    writeFileSync(join(dir, "file"), "not a directory");
    expect(systemdRuntime(join(dir, "file"))).toBe("unknown");
    expect(systemdRuntime(join(dir, "file", "system"))).toBe("unknown");
  });
});

// The approved plan also requires the setup and status owners to preserve the distinction.
describe("Linux worker setup and reconnect classification", () => {
  function setup(options: {
    runtime: "systemd" | "unavailable" | "unknown";
    user: boolean;
    restart?: boolean;
  }) {
    const homeDir = scratchDir("infinitary-linux-background-");
    const calls: string[][] = [];
    const context: BackgroundContext = {
      homeDir,
      dataDir: join(homeDir, "work"),
      configHome: join(homeDir, ".config"),
      uid: 1000,
      flavor: "dev",
      runtime: () => options.runtime,
      systemctl: async (args) => {
        calls.push([...args]);
        if (args[0] === "--system")
          return options.runtime === "systemd" ? { ok: true, output: "inactive\n" } : noBus;
        if (args[1] === "show-environment")
          return options.user ? { ok: true, output: "PATH=/usr/bin" } : noBus;
        if (args[1] === "restart" && options.restart === false)
          return { ok: false, output: "Operation refused" };
        if (args[1] === "show")
          return { ok: true, output: options.restart === false ? "inactive\n" : "active\n" };
        return { ok: true, output: "" };
      },
    };
    return { context, calls };
  }
  for (const expected of ["unavailable", "unknown", "at-login", "running", "failed"] as const) {
    it(`does not infer an update restart from a saved unit when startup is ${expected}`, async () => {
      const { context } = setup({
        runtime: expected === "unavailable" || expected === "unknown" ? expected : "systemd",
        user: expected === "running" || expected === "failed",
        restart: expected !== "failed",
      });
      const own = createKeyIdentity("Joined worker");
      const grant: DeviceGrant = {
        kind: "work",
        deviceId: "ubuntu-box",
        at: "127.0.0.1:47623",
        homeKey: createKeyIdentity("Home").pin,
        key: own.key,
        cert: own.cert,
      };
      writeInstalled(context.dataDir, {
        app: null,
        service: {
          label: "com.getinfinitary.infinitary.dev.work.service",
          file: join(
            context.homeDir,
            ".config/systemd/user/com.getinfinitary.infinitary.dev.work.service",
          ),
        },
      });
      expect(
        await updateHere({ dataDir: context.dataDir, grant, background: { context, env: {} } }),
      ).toEqual({ restarts: expected === "running" });
      expect(await updateHere({ dataDir: context.dataDir, grant })).toEqual({ restarts: false });
    });
    it(`keeps ${expected} distinct through setup and the next status read`, async () => {
      const { context, calls } = setup({
        runtime: expected === "unavailable" || expected === "unknown" ? expected : "systemd",
        user: expected === "running" || expected === "failed",
        restart: expected !== "failed",
      });
      expect(
        await startInBackground(context, {
          launcher: { executable: "/opt/infinitary/infinitary", args: [] },
          env: {},
          app: null,
        }),
      ).toBe(expected);
      const installed = readInstalled(context.dataDir);
      expect(readAutomaticStartup(context.dataDir)).toBe(
        expected === "running" ? "available" : expected,
      );
      expect(Object.keys(installed).sort()).toEqual(["app", "service"]);
      if (expected === "unavailable" || expected === "unknown") {
        expect(installed.service).toBeNull();
        expect(
          calls.some((args) => args.includes("restart") || args.includes("daemon-reload")),
        ).toBe(false);
      } else {
        expect(installed.service).not.toBeNull();
        expect(await backgroundState(context, installed.service!)).toBe(expected);
      }
    });
  }
});
