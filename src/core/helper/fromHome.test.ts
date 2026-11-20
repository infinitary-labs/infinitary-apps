import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workOutcomeLine } from "@shared/remoteLogin";
import { afterEach, describe, expect, it } from "vitest";
import { claudeOnComputer } from "../../../tests/helpers/computerClaude";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import {
  type BackgroundContext,
  readInstalled,
  serviceLabel,
  startInBackground,
} from "./background";
import { cleanUp, LEFT_CLAUDE_LOGIN } from "./cleanUp";
import { removeFromHome, updateFromHome } from "./fromHome";
import { finishRemoval, helperStatus } from "./run";
import { helperWords } from "./words";

/**
 * What the work mode does when its home started it over Remote Login
 * (docs/helper.md, "Started by the home"): update to the copy the home sent,
 * or remove what Firstmate set up here, each answering one typed outcome.
 * On a joined data folder with its agent and kept copy; launchctl is a
 * stand-in that writes down what it was asked, so no agent is ever loaded.
 */

function bundleAt(dir: string, says: string): string {
  const app = join(dir, "Firstmate 3000.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Firstmate 3000"), `#!/bin/sh\n# ${says}\n`, {
    mode: 0o755,
  });
  return app;
}

/**
 * A computer joined to a home at 192.0.2.20, on another Mac as that home's
 * welcome said, running its work from a kept copy in the background.
 */
async function joined() {
  const dataDir = scratchDir("infinitary-from-home-");
  const asked: string[][] = [];
  const background: BackgroundContext = {
    flavor: "dev",
    dataDir,
    homeDir: scratchDir("infinitary-from-home-user-"),
    uid: 502,
    launchctl: async (args) => {
      asked.push([...args]);
      return { ok: true, output: "" };
    },
  };
  const identity = createKeyIdentity("Firstmate device");
  new JoinedHome(dataDir, () => {}).join(
    {
      at: "192.0.2.20:47623",
      homeKey: "K".repeat(43),
      deviceId: "mini",
      kind: "work",
      key: identity.key,
      cert: identity.cert,
      onHomeMac: false,
    },
    1_000,
  );
  new JoinedHome(dataDir, () => {}).name("MacBook Pro");
  const kept = bundleAt(join(dataDir, "app"), "the old version");
  await startInBackground(background, {
    launcher: { executable: join(kept, "Contents", "MacOS", "Firstmate 3000"), args: [] },
    env: {},
    app: kept,
  });
  asked.splice(0);
  return { dataDir, background, asked, kept };
}

const label = serviceLabel("dev");

/** The home and computer the home expects the folder to run work for: the one it joined. */
const EXPECTED = { homeKey: "K".repeat(43), deviceId: "mini" };

/** Folders a test made read-only, made writable again so their scratch folder can go. */
const readOnly: string[] = [];
afterEach(() => {
  for (const dir of readOnly.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o755);
});

describe("the work mode started by its home over Remote Login", () => {
  it("updates to the copy the home sent: stops the run, keeps the copy, starts it again", async () => {
    const at = await joined();
    const sent = bundleAt(scratchDir("infinitary-from-home-sent-"), "the home's version");
    const outcome = await updateFromHome(
      { dataDir: at.dataDir, background: at.background, backgroundEnv: {}, expected: EXPECTED },
      sent,
    );
    expect(outcome).toEqual({ firstmate: "updated", background: "running" });
    // The kept copy is the home's version now, and the background starts it.
    expect(readFileSync(join(at.kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toContain(
      "the home's version",
    );
    const file = join(at.background.homeDir, "Library", "LaunchAgents", `${label}.plist`);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
    ]);
    expect(readInstalled(at.dataDir)).toEqual({
      service: { label, file },
      app: at.kept,
    });
    // Still joined.
    expect(new JoinedHome(at.dataDir, () => {}).read()?.grant.deviceId).toBe("mini");
  });

  it("says the background failed when its agent cannot be written", async () => {
    const at = await joined();
    const agents = join(at.background.homeDir, "Library", "LaunchAgents");
    rmSync(agents, { recursive: true, force: true });
    writeFileSync(agents, "not a folder");
    const sent = bundleAt(scratchDir("infinitary-from-home-sent-"), "the home's version");
    expect(
      await updateFromHome(
        { dataDir: at.dataDir, background: at.background, backgroundEnv: {}, expected: EXPECTED },
        sent,
      ),
    ).toEqual({ firstmate: "updated", background: "failed" });
  });

  it("removes what Firstmate set up here, and keeps the note of which home removed it", async () => {
    const at = await joined();
    for (const folder of ["accounts", "forges", "tasks"])
      mkdirSync(join(at.dataDir, folder, "inside"), { recursive: true });
    const outcome = await removeFromHome({
      dataDir: at.dataDir,
      background: at.background,
      backgroundEnv: {},
      expected: EXPECTED,
    });
    expect(outcome).toEqual({ firstmate: "removed", kept: [] });
    for (const gone of ["accounts", "forges", "tasks", "app", "home.json", "installed.json"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    expect(
      existsSync(join(at.background.homeDir, "Library", "LaunchAgents", `${label}.plist`)),
    ).toBe(false);
    expect(at.asked[0]).toEqual(["bootout", `gui/502/${label}`]);
    expect(helperStatus(at.dataDir)).toEqual(helperWords.notJoined);
  });

  it("leaves the Claude login Firstmate made here to the work's own run, which it starts again to sign it out", async () => {
    const at = await joined();
    const claude = claudeOnComputer(at.dataDir, "made");
    await claude.signIn;
    const agent = join(at.background.homeDir, "Library", "LaunchAgents", `${label}.plist`);

    const outcome = await removeFromHome({
      dataDir: at.dataDir,
      background: at.background,
      backgroundEnv: {},
      expected: EXPECTED,
    });
    // The home reads the same outcome as ever.
    expect(outcome).toEqual({ firstmate: "removed", kept: [] });
    expect(() => workOutcomeLine(outcome)).not.toThrow();
    // Over Remote Login nothing is signed out: the agent stays, started again at once.
    expect(claude.seen.logouts).toBe(0);
    expect(claude.signedIn()).toBe(true);
    for (const gone of ["accounts", "home.json"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    expect(existsSync(agent)).toBe(true);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", agent],
    ]);
    expect(helperStatus(at.dataDir)).toEqual(helperWords.left("MacBook Pro", [], "removed", true));

    // The agent's run, in this user's login session, signs it out and finishes the removal.
    const said: string[] = [];
    at.asked.splice(0);
    expect(
      await finishRemoval({
        dataDir: at.dataDir,
        say: (lines) => said.push(...lines),
        cleanUp: () =>
          cleanUp({
            dataDir: at.dataDir,
            background: at.background,
            signOutClaude: claude.signOutClaude,
          }),
      }),
    ).toEqual({ kept: [], claude: "signed-out" });
    expect(said).toEqual(helperWords.cleanedUp([], [], [], { claude: "signed-out" }));
    expect(claude.signedIn()).toBe(false);
    for (const gone of [LEFT_CLAUDE_LOGIN, "installed.json", "app"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    expect(existsSync(agent)).toBe(false);
    expect(at.asked).toEqual([["bootout", `gui/502/${label}`]]);
    expect(helperStatus(at.dataDir)).toEqual(helperWords.notJoined);
  });

  it("finishes a removal that could not remove everything when asked again, instead of refusing it as not joined", async () => {
    const at = await joined();
    for (const folder of ["accounts", "forges", "tasks"])
      mkdirSync(join(at.dataDir, folder, "inside"), { recursive: true });
    const agents = join(at.background.homeDir, "Library", "LaunchAgents");
    const agent = join(agents, `${label}.plist`);
    // Nothing can leave that user's agents folder: the agent cannot go yet.
    chmodSync(agents, 0o555);
    readOnly.push(agents);
    const context = {
      dataDir: at.dataDir,
      background: at.background,
      backgroundEnv: {},
      expected: EXPECTED,
    };

    expect(await removeFromHome(context)).toEqual({
      firstmate: "removed",
      kept: [],
      unremoved: [agent],
    });
    // The home is let go, and its sign-ins and conversations are gone.
    for (const gone of ["home.json", "accounts", "forges", "tasks"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    // The agent and the copy it starts stay, so its next run finishes the removal.
    expect(existsSync(agent)).toBe(true);
    expect(existsSync(at.kept)).toBe(true);
    expect(helperStatus(at.dataDir)).toEqual(helperWords.left("MacBook Pro", [agent]));

    // Asked again while it still cannot: it tries, and says so again.
    expect(await removeFromHome(context)).toEqual({
      firstmate: "removed",
      kept: [],
      unremoved: [agent],
    });

    // Once it can, the agent and the copy go last.
    chmodSync(agents, 0o755);
    at.asked.splice(0);
    expect(await removeFromHome(context)).toEqual({ firstmate: "removed", kept: [] });
    for (const gone of ["app", "installed.json"])
      expect(existsSync(join(at.dataDir, gone)), gone).toBe(false);
    expect(existsSync(agent)).toBe(false);
    expect(at.asked.at(-1)).toEqual(["bootout", `gui/502/${label}`]);
    expect(helperStatus(at.dataDir)).toEqual(helperWords.notJoined);
    expect(await removeFromHome(context)).toEqual({ firstmate: "refused", reason: "not-joined" });
  });

  it("refuses a folder that runs work for another home or as another computer, and touches nothing there", async () => {
    const at = await joined();
    const sent = bundleAt(scratchDir("infinitary-from-home-sent-"), "the home's version");
    for (const expected of [
      { ...EXPECTED, homeKey: "L".repeat(43) },
      { ...EXPECTED, deviceId: "another" },
    ]) {
      const context = {
        dataDir: at.dataDir,
        background: at.background,
        backgroundEnv: {},
        expected,
      };
      expect(await updateFromHome(context, sent)).toEqual({
        firstmate: "refused",
        reason: "other-home",
      });
      expect(await removeFromHome(context)).toEqual({ firstmate: "refused", reason: "other-home" });
    }
    // Its run was never stopped, and everything there stays.
    expect(at.asked).toEqual([]);
    expect(new JoinedHome(at.dataDir, () => {}).read()?.grant.deviceId).toBe("mini");
    expect(readFileSync(join(at.kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toContain(
      "the old version",
    );
  });

  it("refuses a folder that joined nothing, and one someone runs work from by hand, starting its run again", async () => {
    const empty = scratchDir("infinitary-from-home-");
    const context = { dataDir: empty, background: null, backgroundEnv: {}, expected: EXPECTED };
    expect(await removeFromHome(context)).toEqual({ firstmate: "refused", reason: "not-joined" });
    expect(await updateFromHome(context, bundleAt(empty, "sent"))).toEqual({
      firstmate: "refused",
      reason: "not-joined",
    });

    const at = await joined();
    // The process that started this one works from the folder by hand.
    writeFileSync(join(at.dataDir, "running.lock"), `${process.ppid}\n`);
    const sent = bundleAt(scratchDir("infinitary-from-home-sent-"), "the home's version");
    expect(
      await updateFromHome(
        {
          dataDir: at.dataDir,
          background: at.background,
          backgroundEnv: {},
          expected: EXPECTED,
          lockWaitMs: 300,
        },
        sent,
      ),
    ).toEqual({ firstmate: "refused", reason: "busy" });
    const file = join(at.background.homeDir, "Library", "LaunchAgents", `${label}.plist`);
    expect(at.asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
    ]);
    // Nothing changed here.
    expect(readFileSync(join(at.kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toContain(
      "the old version",
    );
    expect(existsSync(join(at.dataDir, "home.json"))).toBe(true);
  });
});
