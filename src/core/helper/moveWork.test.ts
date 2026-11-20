import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { workLabelOf } from "@shared/codeNames";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { stagedFolderFor } from "../folderMove/due";
import { acquireMoveLock, moveLockPathFor } from "../storage/moveLock";
import { isProfileRetired } from "../storage/retiredProfile";
import { type BackgroundContext, readInstalled, servicePlist, writeInstalled } from "./background";
import { moveWork } from "./moveWork";
import { helperPlace } from "./place";

/**
 * The work's own part in the one-time move of the Infinitary rename
 * (docs/helper.md, "Under the other name"): Infinitary's run finds its work
 * in Firstmate 3000's folder, moves that folder into its own with the move
 * engine, and hands its background to Infinitary's label in the new folder.
 * The engine copies with Node's own copy (a Linux computer's), so nothing
 * is spawned; launchctl is a stand-in that writes down what it was asked.
 */

const OLDER_LABEL = workLabelOf("fm", "release");
const OWN_LABEL = workLabelOf("inf", "release");

function computer(
  options: {
    agent?: "older" | "own" | "none";
    refuses?: string;
    /** Joined as the Mac mini was: `work`, through the home's SSH connection, its agent already starting it as an app. */
    separateOverSsh?: boolean;
  } = {},
) {
  const appData = scratchDir("infinitary-move-work-");
  const homeDir = scratchDir("infinitary-move-work-home-");
  const older = join(appData, "firstmate-3000");
  const own = join(appData, "infinitary");
  const work = join(older, "work");
  mkdirSync(join(work, "tasks", "t1"), { recursive: true });
  mkdirSync(join(work, "app"), { recursive: true });
  mkdirSync(join(work, "chromium"), { recursive: true });
  if (options.separateOverSsh) {
    const own = createKeyIdentity("Firstmate device");
    new JoinedHome(work, () => {}).join(
      {
        at: "127.0.0.1:47623",
        via: "ssh",
        homeKey: createKeyIdentity("The home").pin,
        deviceId: "mini",
        kind: "work",
        key: own.key,
        cert: own.cert,
        // What the home's welcome said and the grant keeps.
        onHomeMac: false,
      },
      1_000,
    );
  } else
    writeFileSync(join(work, "home.json"), '{"grant":"the home it joined"}\n', { mode: 0o600 });
  writeFileSync(join(work, "tasks", "t1", "conversation.json"), "a conversation\n");
  // The copy the run starts from: an AppImage keeps one name whichever app it is.
  const app = join(work, "app", "infinitary.AppImage");
  writeFileSync(app, "#!/bin/sh\n", { mode: 0o700 });
  // What live writers keep beside the work, which the move leaves behind.
  writeFileSync(join(work, "service.log"), "said by the run\n");
  writeFileSync(join(work, "work.log"), "a note\n");
  writeFileSync(join(work, "route.json"), "{}\n");
  writeFileSync(join(work, "chromium", "Local State"), "{}\n");

  const asked: string[][] = [];
  const background = (dataDir: string, spelling: "fm" | "inf"): BackgroundContext => ({
    flavor: "release",
    dataDir,
    spelling,
    homeDir,
    uid: 502,
    launchctl: async (args) => {
      asked.push([...args]);
      const refused = args[0] === "bootstrap" && String(args[2]).includes(options.refuses ?? "\0");
      return { ok: !refused, output: refused ? "refused" : "" };
    },
  });
  const agentFile = (label: string) => join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  if (options.agent !== "none") {
    const label = options.agent === "own" ? OWN_LABEL : OLDER_LABEL;
    mkdirSync(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      agentFile(label),
      servicePlist({
        label,
        launcher: { executable: app, args: [] },
        dataDir: work,
        env: {},
        interactive: options.separateOverSsh === true,
      }),
    );
    writeInstalled(work, { service: { label, file: agentFile(label) }, app });
  }
  const place = helperPlace({
    packaged: true,
    flavor: "release",
    appData,
    env: {},
    spelling: "inf",
  });
  const notes: string[] = [];
  const run = () =>
    moveWork({
      place,
      background,
      launcher: { executable: "/opt/infinitary/infinitary", args: [] },
      env: {},
      deps: {
        platform: "linux",
        claudeConfigDir: scratchDir("infinitary-move-work-claude-"),
        hostname: "builder-mac",
      },
      log: (line) => notes.push(line),
    });
  return { older, own, work, app, place, asked, agentFile, notes, run };
}

describe("Infinitary's run that finds its work in Firstmate 3000's folder", () => {
  it("moves the folder into its own, then hands its background to Infinitary's label there", async () => {
    const at = computer();
    expect(at.place.dataDir).toBe(at.work);
    expect(await at.run()).toEqual({ kind: "handed-over" });

    const work = join(at.own, "work");
    expect(readFileSync(join(work, "tasks", "t1", "conversation.json"), "utf8")).toBe(
      "a conversation\n",
    );
    expect(isProfileRetired(at.older)).toBe(true);
    // The older folder stays as it was, the recovery copy.
    expect(existsSync(join(at.work, "home.json"))).toBe(true);
    // What live writers keep stayed behind with it.
    for (const left of ["service.log", "work.log", "route.json", "chromium"]) {
      expect(existsSync(join(work, left))).toBe(false);
      expect(existsSync(join(at.work, left))).toBe(true);
    }

    // Infinitary's agent starts the copy in the new folder while its grant is there.
    const app = join(work, "app", "infinitary.AppImage");
    const file = at.agentFile(OWN_LABEL);
    expect(readInstalled(work)).toEqual({ service: { label: OWN_LABEL, file }, app });
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(`<string>${app}</string>`);
    expect(plist).toContain(`<key>${join(work, "home.json")}</key>`);
    expect(plist).toContain(`<string>${join(work, "service.log")}</string>`);
    expect(plist).not.toContain(at.older);
    // It started first; Firstmate 3000's agent went last, which ends this run.
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${OWN_LABEL}`],
      ["bootstrap", "gui/502", file],
      ["bootout", `gui/502/${OLDER_LABEL}`],
    ]);
    expect(existsSync(at.agentFile(OLDER_LABEL))).toBe(false);
  });

  // INF-247: the Mac mini joined as `work` through the home's SSH connection,
  // and its grant keeps what the home said: that it is a separate Mac.
  it("keeps a separate Mac's agent starting its run as an app when the home reaches it over SSH", async () => {
    const at = computer({ separateOverSsh: true });
    expect(await at.run()).toEqual({ kind: "handed-over" });
    expect(readFileSync(at.agentFile(OWN_LABEL), "utf8")).toContain(
      "<key>ProcessType</key>\n\t<string>Interactive</string>",
    );
  });

  it("goes on from the new folder when the service manager refuses Infinitary's agent, and points the old one there for its next load", async () => {
    const at = computer({ refuses: OWN_LABEL });
    expect(await at.run()).toEqual({ kind: "here", dataDir: join(at.own, "work") });
    const work = join(at.own, "work");
    const app = join(work, "app", "infinitary.AppImage");
    const file = at.agentFile(OLDER_LABEL);
    expect(readInstalled(work)).toEqual({ service: { label: OLDER_LABEL, file }, app });
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(`<string>${app}</string>`);
    expect(plist).toContain(`<key>${join(work, "home.json")}</key>`);
    expect(plist).not.toContain(at.older);
    expect(existsSync(at.agentFile(OWN_LABEL))).toBe(false);
    // The old agent was never let go: it is this run's own.
    expect(at.asked).not.toContainEqual(["bootout", `gui/502/${OLDER_LABEL}`]);
  });

  it("ends while the older run still holds the folder, for its background to start it again", async () => {
    const at = computer();
    writeFileSync(join(at.work, "running.lock"), `${process.pid}\n`);
    expect(await at.run()).toEqual({ kind: "later" });
    expect(existsSync(at.own)).toBe(false);
    expect(isProfileRetired(at.older)).toBe(false);
    expect(at.asked).toEqual([]);
  });

  /**
   * INF-276 (INF-275): the Mac mini's run began the move as process 625, and a
   * restart cut it off with most of the copy made. After the restart 625 was
   * root's userfsd, so every start read the move as under way and ended, and
   * the computer stayed out of reach.
   */
  it("moves the work on its first start after a restart cut the move off", async () => {
    const at = computer();
    const beforeStart = new Date(Date.now() - uptime() * 1000 - 15 * 60 * 1000);
    // What the move left: both locks, written before this computer last
    // started and naming a process that is running now, and its half copy.
    for (const lock of [moveLockPathFor(at.older), moveLockPathFor(at.own)]) {
      expect(acquireMoveLock(lock, 1, () => beforeStart)).toBe(true);
      utimesSync(lock, beforeStart, beforeStart);
    }
    const half = stagedFolderFor(at.own, 625);
    mkdirSync(join(half, "work", "tasks"), { recursive: true });

    expect(await at.run()).toEqual({ kind: "handed-over" });
    expect(readFileSync(join(at.own, "work", "tasks", "t1", "conversation.json"), "utf8")).toBe(
      "a conversation\n",
    );
    expect(isProfileRetired(at.older)).toBe(true);
    expect(existsSync(half)).toBe(false);
    expect(existsSync(moveLockPathFor(at.older))).toBe(false);
    expect(existsSync(moveLockPathFor(at.own))).toBe(false);
  });

  it("runs from the older folder while Firstmate 3000's window has it open, and moves nothing", async () => {
    const at = computer();
    symlinkSync(`builder-mac-${process.pid}`, join(at.older, "SingletonLock"));
    expect(await at.run()).toEqual({ kind: "stayed", dataDir: at.work });
    expect(existsSync(at.own)).toBe(false);
    expect(isProfileRetired(at.older)).toBe(false);
    expect(at.asked).toEqual([]);
    expect(at.notes.join("\n")).toContain("old-app-open");
  });

  it("goes on from the new folder when nothing runs it in the background", async () => {
    const at = computer({ agent: "none" });
    expect(await at.run()).toEqual({ kind: "here", dataDir: join(at.own, "work") });
    expect(isProfileRetired(at.older)).toBe(true);
    expect(at.asked).toEqual([]);
  });

  it("leaves the work where it is when its agent is under Infinitary's label already", async () => {
    const at = computer({ agent: "own" });
    expect(await at.run()).toEqual({ kind: "stayed", dataDir: at.work });
    expect(existsSync(at.own)).toBe(false);
    expect(at.asked).toEqual([]);
  });
});
