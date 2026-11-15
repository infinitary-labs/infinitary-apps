import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Launchctl } from "@core/helper/background";
import { loginAgentFile, sessionAgentFile } from "@core/helper/runAgent";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { RUN_SETTINGS_EXIT, RUN_WORDS } from "./runCommand";
import {
  BOOT_WORDS,
  type BootContext,
  bootAsked,
  helpWords,
  macHandAgentFile,
  runStartAtBoot,
  startAtBootCommand,
} from "./startAtBoot";

/**
 * `infinitary start-at-boot` (docs/run.md, "Starting at boot"): INF-1228's
 * answer boot=both, "start-at-boot writes what the account may and prints
 * the one administrator line", carried unchanged as piece 5 of INF-1352's
 * plan; on a Mac, the captain's choice on INF-1659 below.
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
    uid: 501,
    homeDir: join(root, "home"),
    unitsDir: join(root, "config", "systemd", "user"),
    daemonsDir: join(root, "Library", "LaunchDaemons"),
    label: LABEL,
    launcher: { executable: "/opt/Infinitary/infinitary", args: [] },
    dataDir: join(root, "data"),
    env: {},
    cwd: root,
    systemctl: fake.systemctl,
    loginctl: fake.loginctl,
    launchctl: null,
    alive: () => true,
    ...more,
  };
  return { root, calls: fake.calls, context: value, unit: join(value.unitsDir, SERVICE) };
}

const lines = (text: string) => text.trimEnd().split("\n");

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

/** The plist a Mac's entry is, read back as launchd reads it: dicts, arrays, strings and booleans. */
function parsePlist(text: string): Record<string, PlistValue> {
  const tokens = [...text.matchAll(/<(\/?)(dict|array|key|string|true|false)(\/?)>([^<]*)/g)];
  let at = 0;
  const xmlText = (raw: string) =>
    raw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  const value = (): PlistValue => {
    const [, , tag, , content = ""] = tokens[at++] ?? [];
    if (tag === "true" || tag === "false") return tag === "true";
    if (tag === "string") {
      at++;
      return xmlText(content);
    }
    if (tag === "array") {
      const items: PlistValue[] = [];
      while (tokens[at]?.[1] !== "/") items.push(value());
      at++;
      return items;
    }
    if (tag === "dict") {
      const dict: Record<string, PlistValue> = {};
      while (tokens[at]?.[1] !== "/") {
        const key = xmlText(tokens[at]?.[4] ?? "");
        at += 2;
        dict[key] = value();
      }
      at++;
      return dict;
    }
    throw new Error(`Not a plist value: ${tag}`);
  };
  const root = value();
  if (typeof root !== "object" || Array.isArray(root)) throw new Error("Not a plist dict");
  return root;
}

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
    expect(text).toContain('ExecStart="/opt/Infinitary/infinitary" "--ozone-platform=x11" "run"\n');
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
      `ExecStart="/opt/Infinitary/infinitary" "--ozone-platform=x11" "run" "--settings" "${join(root, "settings.json")}"\n`,
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

/** launchd as it answers this user: logged in or not, the agent loaded or not, and whether it starts it. */
function launchd(options: { session: boolean; loaded?: boolean; starts?: boolean }) {
  const calls: string[] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(`launchctl ${args.join(" ")}`);
    const [verb, target] = args;
    if (verb === "print")
      return { ok: target === "gui/501" ? options.session : Boolean(options.loaded), output: "" };
    if (verb === "bootstrap") return { ok: options.starts ?? true, output: "" };
    return { ok: true, output: "" };
  };
  return { calls, launchctl };
}

describe("starting at boot on a Mac", () => {
  // The captain's choice on INF-1659 (aqua-run-now): a login agent in the
  // person's own session with automatic log in, never a system job, so the
  // run started at boot sees the login keychain unlocked and can use Secrets.
  const MAC = { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] };

  function mac(
    more: Partial<BootContext> = {},
    answers: Parameters<typeof launchd>[0] = { session: true },
  ) {
    const fake = launchd(answers);
    const made = context("on", {
      platform: "darwin",
      launcher: MAC,
      launchctl: fake.launchctl,
      ...more,
    });
    const name = `${LABEL}.plist`;
    return {
      ...made,
      launchd: fake.calls,
      agent: join(made.context.homeDir, "Library", "LaunchAgents", name),
      prepared: join(made.context.homeDir, "Library", "LaunchDaemons", name),
      placed: join(made.context.daemonsDir, name),
      log: join(made.context.homeDir, "Library", "Logs", `${LABEL}.log`),
    };
  }

  it("writes a login agent in the account's own session, asks for automatic log in and starts it now", async () => {
    const { calls, launchd: asked, context: c, agent, placed, log } = mac();
    const result = await runStartAtBoot({ off: false }, c);

    expect(result.code).toBe(0);
    expect(lines(result.out)).toEqual([
      ...BOOT_WORDS.macSet("fm"),
      BOOT_WORDS.startedNow,
      BOOT_WORDS.macLog(log),
    ]);
    // No systemd, logind or administrator: launchd starts it in this user's session.
    expect(calls).toEqual([]);
    expect(asked).toEqual([
      "launchctl print gui/501",
      `launchctl bootout gui/501/${LABEL}`,
      `launchctl bootstrap gui/501 ${agent}`,
    ]);
    expect(existsSync(placed)).toBe(false);

    const entry = parsePlist(readFileSync(agent, "utf8"));
    expect(entry).toEqual({
      Label: LABEL,
      ProgramArguments: [MAC.executable, "run"],
      // Only the logged-in session, where its log in unlocked the keychain.
      LimitLoadToSessionType: "Aqua",
      RunAtLoad: true,
      // An update's 75 starts the new version; a clean stop does not start it again.
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Interactive",
      StandardOutPath: log,
      StandardErrorPath: log,
    });
    expect(statSync(agent).mode & 0o777).toBe(0o600);
    expect(existsSync(dirname(log))).toBe(true);
  });

  // The reviewer's finding on INF-1352's piece 7: an agent the window left would start a second
  // run beside the boot entry's. On a Mac the boot entry is the window's login agent itself.
  it("takes the window's own agent's place with one login agent", async () => {
    const { context: c, log } = mac();
    const agents = [loginAgentFile(c), sessionAgentFile(c)];
    for (const agent of agents) {
      mkdirSync(dirname(agent), { recursive: true });
      writeFileSync(agent, "the window's agent\n");
    }
    expect((await runStartAtBoot({ off: false }, c)).code).toBe(0);
    expect(agents.filter((agent) => existsSync(agent))).toEqual([loginAgentFile(c)]);
    expect(readFileSync(loginAgentFile(c), "utf8")).toContain(`<string>${log}</string>`);
  });

  it("says it starts at the next log in when nobody is logged in, or launchd does not start it", async () => {
    const away = mac({}, { session: false });
    const out = lines((await runStartAtBoot({ off: false }, away.context)).out);
    expect(out).toEqual([
      ...BOOT_WORDS.macSet("fm"),
      BOOT_WORDS.macNextLogIn("fm"),
      BOOT_WORDS.macLog(away.log),
    ]);
    expect(away.launchd).toEqual(["launchctl print gui/501"]);
    expect(existsSync(away.agent)).toBe(true);

    const refused = mac({}, { session: true, starts: false });
    const words = lines((await runStartAtBoot({ off: false }, refused.context)).out);
    expect(words).toContain(BOOT_WORDS.macNextLogIn("fm"));
    expect(words).not.toContain(BOOT_WORDS.startedNow);
  });

  it("leaves an Infinitary open here alone, and starts its own run again with the new file", async () => {
    const open = mac();
    mkdirSync(open.context.dataDir, { recursive: true });
    symlinkSync("host-777", join(open.context.dataDir, "SingletonLock"));
    const beside = await runStartAtBoot({ off: false }, open.context);
    expect(lines(beside.out)).toEqual(expect.arrayContaining([...BOOT_WORDS.openNow]));
    expect(open.launchd.some((call) => call.startsWith("launchctl bootstrap"))).toBe(false);

    // The agent's own run holds the folder: launchd reads the new file and starts it again.
    const own = mac({}, { session: true, loaded: true });
    mkdirSync(own.context.dataDir, { recursive: true });
    symlinkSync("host-777", join(own.context.dataDir, "SingletonLock"));
    const again = await runStartAtBoot({ off: false }, own.context);
    expect(lines(again.out)).toContain(BOOT_WORDS.startedNow);
    expect(own.launchd).toContain(`launchctl bootstrap gui/501 ${own.agent}`);
  });

  it("takes an earlier version's system job away: its own copy goes, and one in place gets the administrator's line", async () => {
    const { context: c, prepared, placed } = mac();
    mkdirSync(dirname(prepared), { recursive: true });
    writeFileSync(prepared, "an earlier version's entry");
    mkdirSync(c.daemonsDir, { recursive: true });
    writeFileSync(placed, "an earlier version's entry");

    const out = lines((await runStartAtBoot({ off: false }, c)).out);
    expect(out).toEqual(
      expect.arrayContaining([
        ...BOOT_WORDS.macEarlier(
          `sudo launchctl bootout system/${LABEL} 2>/dev/null; sudo rm -f ${placed}`,
        ),
      ]),
    );
    expect(existsSync(prepared)).toBe(false);
    // The administrator's folder is theirs to change.
    expect(existsSync(placed)).toBe(true);
  });

  it("says when a login agent saved by hand from an earlier help run also starts it, and leaves that file alone", async () => {
    // The captain's answer on the review (help-run-duplicate-agent=c): help
    // run no longer shows that file, and start-at-boot says when it is there.
    const { context: c } = mac();
    const hand = macHandAgentFile(c.homeDir);
    mkdirSync(dirname(hand), { recursive: true });
    writeFileSync(hand, "a login agent the person saved");

    expect(lines((await runStartAtBoot({ off: false }, c)).out)).toContain(
      BOOT_WORDS.macHandAgent(hand),
    );
    expect(lines((await runStartAtBoot({ off: true }, c)).out)).toEqual([
      ...BOOT_WORDS.off("fm"),
      BOOT_WORDS.macHandAgentOff(hand),
    ]);
    expect(existsSync(hand)).toBe(true);
  });

  it("quotes a folder with a space or a quote in the administrator's line", async () => {
    const root = scratchDir("start-at-boot-space-");
    const daemonsDir = join(root, "Kun's daemons");
    const { context: c } = mac({ daemonsDir });
    mkdirSync(daemonsDir, { recursive: true });
    writeFileSync(join(daemonsDir, `${LABEL}.plist`), "an earlier version's entry");
    const out = lines((await runStartAtBoot({ off: false }, c)).out);
    const placed = join(root, "Kun'\\''s daemons", `${LABEL}.plist`);
    expect(out).toContain(
      `sudo launchctl bootout system/${LABEL} 2>/dev/null; sudo rm -f '${placed}'`,
    );
  });

  it("names the settings file by its full path, and refuses one to fix before writing anything", async () => {
    const { root, context: c, agent } = mac();
    writeFileSync(join(root, "settings.json"), '{ "path": ["/usr/bin", "/bin"] }');
    await runStartAtBoot({ off: false, settings: "settings.json" }, c);
    expect(parsePlist(readFileSync(agent, "utf8")).ProgramArguments).toEqual([
      MAC.executable,
      "run",
      "--settings",
      join(root, "settings.json"),
    ]);

    const fresh = mac();
    writeFileSync(join(fresh.root, "bad.json"), '{ "paths": [] }');
    const refused = await runStartAtBoot({ off: false, settings: "bad.json" }, fresh.context);
    expect(refused.code).toBe(RUN_SETTINGS_EXIT);
    expect(lines(refused.error)[0]).toMatch(/^Infinitary could not use the settings file /);
    expect(existsSync(fresh.agent)).toBe(false);
    expect(fresh.launchd).toEqual([]);
  });

  it("carries a development run's stand-ins", async () => {
    const { context: c, agent } = mac({ env: { INFINITARY_USER_DATA_DIR: "/tmp/fm data" } });
    await runStartAtBoot({ off: false }, c);
    expect(parsePlist(readFileSync(agent, "utf8")).EnvironmentVariables).toEqual({
      INFINITARY_USER_DATA_DIR: "/tmp/fm data",
    });
  });

  it("undoes it with --off: the agent and its run, and an earlier system job by an administrator's line", async () => {
    const { launchd: asked, context: c, agent, prepared, placed } = mac();
    await runStartAtBoot({ off: false }, c);
    const off = await runStartAtBoot({ off: true }, c);
    expect(off.code).toBe(0);
    expect(lines(off.out)).toEqual([...BOOT_WORDS.off("fm")]);
    expect(existsSync(agent)).toBe(false);
    expect(asked.at(-1)).toBe(`launchctl bootout gui/501/${LABEL}`);
    // With no agent in place, a run under the same label, as the window's own
    // agent in the data folder starts, keeps running.
    const before = asked.length;
    expect(lines((await runStartAtBoot({ off: true }, c)).out)).toEqual([
      ...BOOT_WORDS.wasOff("fm"),
    ]);
    expect(asked.slice(before)).toEqual([]);

    // An earlier version's own copy goes too; one an administrator put in place takes one to remove.
    mkdirSync(dirname(prepared), { recursive: true });
    writeFileSync(prepared, "an earlier version's entry");
    mkdirSync(c.daemonsDir, { recursive: true });
    writeFileSync(placed, "an earlier version's entry");
    const placedOff = await runStartAtBoot({ off: true }, c);
    expect(lines(placedOff.out)).toEqual([
      ...BOOT_WORDS.macOff(
        "fm",
        `sudo launchctl bootout system/${LABEL} 2>/dev/null; sudo rm -f ${placed}`,
      ),
    ]);
    expect(existsSync(prepared)).toBe(false);
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

    // A run from a checkout starts Electron with its folder: each its own word, quoted where it has a space.
    const checkout = { executable: "/repo x/Electron", args: ["/repo x"] };
    const words = helpWords(["run"], checkout).lines;
    expect(words).toContain("    '/repo x/Electron' '/repo x' run");
    expect(helpWords([], mac).code).toBe(0);
    expect(helpWords(["nope"], mac).code).toBe(2);
  });
});
