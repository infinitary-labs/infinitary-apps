import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Launchctl } from "@core/helper/background";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { RUN_SETTINGS_EXIT, RUN_WORDS } from "./runCommand";
import {
  BOOT_WORDS,
  type BootContext,
  bootAsked,
  helpWords,
  runStartAtBoot,
  startAtBootCommand,
} from "./startAtBoot";

/**
 * `infinitary start-at-boot` (docs/run.md, "Starting at boot"): INF-1228's
 * answer boot=both, "start-at-boot writes what the account may and prints
 * the one administrator line", carried unchanged as piece 5 of INF-1352's plan.
 */

const LABEL = "com.getinfinitary.infinitary.run";
const SERVICE = `${LABEL}.service`;

/** A user's systemd and logind as they answer: linger allowed, refused or already on. */
function system(options: { linger: "allowed" | "refused" | "on"; mainPid?: number }) {
  const calls: string[] = [];
  let lingers = options.linger === "on";
  const systemctl: Launchctl = async (args) => {
    calls.push(`systemctl ${args.join(" ")}`);
    if (args.includes("MainPID") || args.includes("--property=MainPID"))
      return { ok: true, output: String(options.mainPid ?? 0) };
    return { ok: true, output: "" };
  };
  const loginctl: Launchctl = async (args) => {
    calls.push(`loginctl ${args.join(" ")}`);
    if (args[0] === "show-user") return { ok: true, output: lingers ? "yes\n" : "no\n" };
    if (args[0] === "enable-linger" && options.linger === "allowed") {
      lingers = true;
      return { ok: true, output: "" };
    }
    return { ok: false, output: "Access denied" };
  };
  return { calls, systemctl, loginctl };
}

function context(
  linger: "allowed" | "refused" | "on",
  more: Partial<BootContext> & { mainPid?: number } = {},
) {
  const root = scratchDir("start-at-boot-");
  const fake = system({ linger, mainPid: more.mainPid });
  const value: BootContext = {
    platform: "linux",
    user: "fm",
    unitsDir: join(root, "config", "systemd", "user"),
    label: LABEL,
    launcher: { executable: "/opt/Infinitary/infinitary", args: [] },
    dataDir: join(root, "data"),
    env: {},
    cwd: root,
    systemctl: fake.systemctl,
    loginctl: fake.loginctl,
    alive: () => true,
    ...more,
  };
  return { root, calls: fake.calls, context: value, unit: join(value.unitsDir, SERVICE) };
}

const lines = (text: string) => text.trimEnd().split("\n");

describe("starting at boot on Linux", () => {
  it("sets up the user's own service for run, lingers where allowed and starts it now", async () => {
    const { calls, context: c, unit } = context("allowed");
    const result = await runStartAtBoot({ off: false }, c);

    expect(result.code).toBe(0);
    expect(lines(result.out)).toEqual([
      ...BOOT_WORDS.set("fm", true),
      BOOT_WORDS.startedNow,
      BOOT_WORDS.log(SERVICE),
    ]);
    const text = readFileSync(unit, "utf8");
    expect(text).toContain('ExecStart="/opt/Infinitary/infinitary" "run"\n');
    // An update's 75 starts the new version; a file to fix (78) is not retried.
    expect(text).toContain("Restart=on-failure\n");
    expect(text).toContain(`RestartPreventExitStatus=${RUN_SETTINGS_EXIT}\n`);
    expect(text).toContain("WantedBy=default.target\n");
    expect(readlinkSync(join(c.unitsDir, "default.target.wants", SERVICE))).toBe(unit);
    expect(calls).toEqual([
      "loginctl show-user fm --property=Linger --value",
      "loginctl enable-linger --no-ask-password fm",
      "systemctl --user daemon-reload",
      `systemctl --user restart ${SERVICE}`,
    ]);
  });

  it("prints the one administrator line where systemd does not let the user linger", async () => {
    const { context: c, unit } = context("refused");
    const result = await runStartAtBoot({ off: false }, c);

    expect(result.code).toBe(0);
    expect(lines(result.out)).toContain("sudo loginctl enable-linger fm");
    expect(lines(result.out)[0]).toBe(BOOT_WORDS.set("fm", false)[0]);
    expect(existsSync(unit)).toBe(true);
  });

  it("asks for no linger when the user already lingers", async () => {
    const { calls, context: c } = context("on");
    await runStartAtBoot({ off: false }, c);
    expect(calls).not.toContain("loginctl enable-linger --no-ask-password fm");
  });

  it("leaves an Infinitary open here alone, and restarts its own run with a new file", async () => {
    const open = context("on", { mainPid: 4242 });
    mkdirSync(open.context.dataDir, { recursive: true });
    symlinkSync("host-777", join(open.context.dataDir, "SingletonLock"));
    const beside = await runStartAtBoot({ off: false }, open.context);
    expect(lines(beside.out)).toEqual(expect.arrayContaining([...BOOT_WORDS.openNow]));
    expect(open.calls).not.toContain(`systemctl --user restart ${SERVICE}`);

    const own = context("on", { mainPid: 777 });
    mkdirSync(own.context.dataDir, { recursive: true });
    symlinkSync("host-777", join(own.context.dataDir, "SingletonLock"));
    const again = await runStartAtBoot({ off: false }, own.context);
    expect(lines(again.out)).toContain(BOOT_WORDS.startedNow);
    expect(own.calls).toContain(`systemctl --user restart ${SERVICE}`);
  });

  it("names the settings file by its full path, and refuses one to fix before writing anything", async () => {
    const { root, context: c, unit } = context("on");
    writeFileSync(join(root, "settings.json"), '{ "path": ["/usr/bin", "/bin"] }');
    await runStartAtBoot({ off: false, settings: "settings.json" }, c);
    expect(readFileSync(unit, "utf8")).toContain(
      `ExecStart="/opt/Infinitary/infinitary" "run" "--settings" "${join(root, "settings.json")}"\n`,
    );

    const fresh = context("on");
    writeFileSync(join(fresh.root, "bad.json"), '{ "paths": [] }');
    const refused = await runStartAtBoot({ off: false, settings: "bad.json" }, fresh.context);
    expect(refused.code).toBe(RUN_SETTINGS_EXIT);
    expect(lines(refused.error)[0]).toMatch(/^Infinitary could not use the settings file /);
    expect(existsSync(fresh.unit)).toBe(false);
  });

  it("undoes it with --off, and says so when nothing was set up", async () => {
    const { calls, context: c, unit } = context("on");
    await runStartAtBoot({ off: false }, c);
    const off = await runStartAtBoot({ off: true }, c);
    expect(off.code).toBe(0);
    expect(lines(off.out)[0]).toBe(BOOT_WORDS.off("fm")[0]);
    // Linger was on, so it says how an administrator turns that off.
    expect(lines(off.out)).toContain("sudo loginctl disable-linger fm");
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(join(c.unitsDir, "default.target.wants", SERVICE))).toBe(false);
    expect(calls).toContain(`systemctl --user stop ${SERVICE}`);

    const again = await runStartAtBoot({ off: true }, c);
    expect(lines(again.out)[0]).toBe(BOOT_WORDS.wasOff("fm")[0]);
  });

  it("says so with no systemd for this user", async () => {
    const { context: c, unit } = context("on", { systemctl: null });
    const result = await runStartAtBoot({ off: false }, c);
    expect(result.code).toBe(1);
    expect(lines(result.error)).toEqual([...BOOT_WORDS.noSystemd]);
    expect(existsSync(unit)).toBe(false);
  });
});

describe("starting at boot on a Mac", () => {
  // A Mac's boot entry waits for its check on a disposable Mac (INF-1228, piece 7).
  it("changes nothing and points to the other ways to start it", async () => {
    const { calls, context: c, unit } = context("on", { platform: "darwin" });
    const result = await runStartAtBoot({ off: false }, c);
    expect(result.code).toBe(1);
    expect(lines(result.error)).toEqual([...BOOT_WORDS.mac]);
    expect(calls).toEqual([]);
    expect(existsSync(unit)).toBe(false);
  });
});

describe("the words of the command", () => {
  it("reads start-at-boot and its words, and refuses any other", () => {
    expect(
      startAtBootCommand(["/opt/Infinitary/infinitary", "start-at-boot", "--off"], false),
    ).toEqual(["--off"]);
    expect(startAtBootCommand(["/opt/Infinitary/infinitary", "run"], false)).toBeNull();
    expect(bootAsked([])).toEqual({ off: false });
    expect(bootAsked(["--off"])).toEqual({ off: true });
    expect(bootAsked(["--settings", "s.json"])).toEqual({ off: false, settings: "s.json" });
    expect(bootAsked(["--settings"])).toBeNull();
    expect(bootAsked(["--off", "--settings", "s.json"])).toBeNull();
  });

  it("help run prints run's usage and the ways to start it as this app starts itself", () => {
    const mac = { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] };
    const help = helpWords(["run"], mac);
    expect(help.code).toBe(0);
    expect(help.lines.slice(0, RUN_WORDS.usage.length)).toEqual([...RUN_WORDS.usage]);
    expect(help.lines).toContain(`    ${mac.executable} run`);
    expect(help.lines).toContain(`    ${mac.executable} start-at-boot`);
    expect(help.lines.join("\n")).toContain(
      `<array><string>${mac.executable}</string><string>run</string></array>`,
    );

    // A run from a checkout starts Electron with its folder: each its own word, quoted where it has a space.
    const checkout = { executable: "/repo x/Electron", args: ["/repo x"] };
    const words = helpWords(["run"], checkout).lines;
    expect(words).toContain("    '/repo x/Electron' '/repo x' run");
    expect(words.join("\n")).toContain(
      "<array><string>/repo x/Electron</string><string>/repo x</string><string>run</string></array>",
    );
    expect(helpWords([], mac).code).toBe(0);
    expect(helpWords(["nope"], mac).code).toBe(2);
  });
});
