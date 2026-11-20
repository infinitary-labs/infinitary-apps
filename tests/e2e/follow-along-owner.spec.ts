import { cpSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { joinHome } from "../../src/core/helper/join";
import { RUN_MARKER, RunMarkerSchema } from "../../src/main/runCommand";
import { runLabelOf } from "../../src/shared/codeNames";
import { scratchDir } from "../helpers/scratchDirs";
import { endCommands, run, runEnv } from "./commandRun";
import { GITHUB_STUB_KEY, seedGitHubSignIn } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { type ServiceManagerStandIn, serviceManagerStandIn } from "./serviceManagerStandIn";

/**
 * Following along beside a command (docs/view.md, "Following along"; the review of INF-5409):
 * when the computer where the first mate lives adds this one by its address, it leaves a grant in
 * this computer's work folder, and a window beside an empty command's first mate follows along,
 * stopping that command, only when the command is the one its own starter owns, and offers no join
 * beside one started by hand. Data: a home app
 * on this computer, each window's throwaway data folder and HOME, and a stand-in for this
 * account's service manager that really runs the command the window's agent starts
 * (tests/e2e/serviceManagerStandIn.ts); a command started by hand is the built app's `run`, as a
 * terminal starts it. The grant is the one an address add leaves, written by the same join the
 * work's own setup runs. Completion: the process each command runs as, whether it still runs,
 * the shell's own answer on following along, and whether the window became that home's view.
 * A grant written before either process starts is taken by the window alone: its command, run
 * with no window, never takes one, so a fresh home follows along once with no restart, and a home
 * where a sign-in was saved stays home, its command running on after the window quits.
 */

const LABEL = runLabelOf("dev");
const user = { name: userInfo().username, uid: userInfo().uid };

let standIn: ServiceManagerStandIn | null = null;
test.afterEach(() => {
  const testInfo = test.info();
  standIn?.stopAll();
  endCommands();
  // A failed run keeps the service manager's records and each command's output with its results.
  if (standIn && testInfo.status !== testInfo.expectedStatus)
    cpSync(standIn.dir, testInfo.outputPath("service-manager"), { recursive: true });
  standIn = null;
});

/** The command that holds the data folder now, by the note it keeps there. */
function commandPid(userDataDir: string): number {
  return RunMarkerSchema.parse(JSON.parse(readFileSync(join(userDataDir, RUN_MARKER), "utf8"))).pid;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until the window beside a command is welcomed by it, which takes seconds on a busy runner. */
async function welcomed(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.infinitary.devices.list().then(
            () => true,
            () => false,
          ),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** What the window's role is now, or null while it starts over. */
function roleOf(page: Page): Promise<string | null> {
  return page
    .evaluate(() => window.infinitary.devices.thisMac().then((mac) => mac.role))
    .catch(() => null);
}

test("a window follows along beside the command its agent started, and never stops one started by hand", async () => {
  test.skip(
    process.platform === "win32",
    "the service manager stand-in runs a Mac's launchd or Linux's systemd",
  );
  test.setTimeout(300_000);
  const pro = await launchApp({
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  /** What the home leaves in `workDir` once it adds this computer by its address. */
  const addedByAddress = async (workDir: string) => {
    const link = (await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" })))
      .link;
    const joined = await joinHome({
      text: link,
      dataDir: workDir,
      io: { say: () => {}, ask: async () => "yes" },
      device: { name: "Mac mini", user },
      timeoutMs: 10_000,
    });
    if (!joined.ok) throw new Error(joined.reason);
    return joined.grant.deviceId;
  };
  let air: LaunchedApp | undefined;
  try {
    await test.step("reopened beside a command started by hand with a grant waiting, the window stays and the command keeps running", async () => {
      const userDataDir = scratchDir("infinitary-follow-hand-");
      const homeDir = scratchDir("infinitary-follow-hand-home-");
      standIn = serviceManagerStandIn(homeDir);
      const byHand = run(await runEnv(userDataDir));
      await byHand.started();
      const pid = commandPid(userDataDir);
      expect(pid).toBe(byHand.child.pid);
      await addedByAddress(join(userDataDir, "work"));
      air = await launchApp({
        userDataDir,
        homeDir,
        env: {
          ...standIn.env,
          INFINITARY_WINDOW_STARTS_RUN: "1",
          INFINITARY_DEVICE_NAME: "Mac mini",
        },
      });
      await welcomed(air.page);
      // Beside a command it did not start, the window keeps no starter: it neither follows nor joins.
      expect(await air.page.evaluate(() => window.infinitary.devices.followAdded())).toEqual({
        followed: false,
        follows: false,
        joins: false,
      });
      expect(await roleOf(air.page)).toBe("home");
      expect(alive(pid)).toBe(true);
      expect(byHand.child.exitCode).toBeNull();
      expect(standIn.runs(LABEL)).toEqual([]);
      await air.close();
      air = undefined;
      standIn.stopAll();
      endCommands();
    });

    await test.step("its window started the command, which ended, and one started by hand took its place: the window stays beside it", async () => {
      const userDataDir = scratchDir("infinitary-follow-replaced-");
      const homeDir = scratchDir("infinitary-follow-replaced-home-");
      standIn = serviceManagerStandIn(homeDir);
      air = await launchApp({
        userDataDir,
        homeDir,
        env: {
          ...standIn.env,
          INFINITARY_WINDOW_STARTS_RUN: "1",
          INFINITARY_DEVICE_NAME: "Mac mini",
        },
      });
      const { page } = air;
      await welcomed(page);
      const owned = commandPid(userDataDir);
      expect(standIn.runs(LABEL)).toEqual([owned]);
      // The command the window started ends cleanly, as Stop ends it, so its agent starts no other.
      process.kill(owned, "SIGTERM");
      await expect.poll(() => alive(owned), { timeout: 30_000 }).toBe(false);
      const byHand = run(await runEnv(userDataDir));
      await byHand.started();
      const replaced = commandPid(userDataDir);
      expect(replaced).toBe(byHand.child.pid);
      await welcomed(page);
      await addedByAddress(join(userDataDir, "work"));
      // The window still holds its starter, but this run is not the one it owns: it neither
      // follows along nor offers a join, either of which would stop the run started by hand.
      expect(await page.evaluate(() => window.infinitary.devices.followAdded())).toEqual({
        followed: false,
        follows: false,
        joins: false,
      });
      expect(await roleOf(page)).toBe("home");
      expect(alive(replaced)).toBe(true);
      expect(byHand.child.exitCode).toBeNull();
      expect(standIn.runs(LABEL)).toEqual([owned]);
      await air.close();
      air = undefined;
      standIn.stopAll();
      endCommands();
    });

    await test.step("reopened beside the command its agent started with a grant waiting, the window follows along and stops that command", async () => {
      const userDataDir = scratchDir("infinitary-follow-agent-");
      const homeDir = scratchDir("infinitary-follow-agent-home-");
      standIn = serviceManagerStandIn(homeDir);
      const env = {
        ...standIn.env,
        INFINITARY_WINDOW_STARTS_RUN: "1",
        INFINITARY_DEVICE_NAME: "Mac mini",
      };
      air = await launchApp({ userDataDir, homeDir, env });
      await welcomed(air.page);
      const owned = commandPid(userDataDir);
      expect(standIn.runs(LABEL)).toEqual([owned]);
      // The window quits alone; its command keeps running.
      await air.close();
      air = undefined;
      expect(alive(owned)).toBe(true);
      const deviceId = await addedByAddress(join(userDataDir, "work"));
      air = await launchApp({ userDataDir, homeDir, env });
      const { page } = air;
      // The window's own first launch asks the shell every few seconds; nothing was done here.
      await expect.poll(() => roleOf(page), { timeout: 60_000 }).toBe("view");
      await expect.poll(() => alive(owned), { timeout: 30_000 }).toBe(false);
      // Its agent let go, so nothing starts that command again.
      await expect.poll(() => standIn?.running(LABEL)).toBe(false);
      expect(standIn.runs(LABEL)).toEqual([owned]);
      // The window is that home's view, under the grant the add left.
      await expect
        .poll(async () =>
          (await pro.page.evaluate(() => window.infinitary.devices.list())).some(
            (device) => device.id === deviceId && device.inReach,
          ),
        )
        .toBe(true);
      await air.close();
      air = undefined;
      standIn.stopAll();
      endCommands();
    });

    await test.step("a grant waiting before either starts: the window's own command never takes it, the window follows along once, and nothing starts the command again", async () => {
      const userDataDir = scratchDir("infinitary-follow-cold-");
      const homeDir = scratchDir("infinitary-follow-cold-home-");
      standIn = serviceManagerStandIn(homeDir);
      const deviceId = await addedByAddress(join(userDataDir, "work"));
      air = await launchApp({
        userDataDir,
        homeDir,
        env: {
          ...standIn.env,
          INFINITARY_WINDOW_STARTS_RUN: "1",
          INFINITARY_DEVICE_NAME: "Mac mini",
        },
      });
      const { page } = air;
      await expect.poll(() => roleOf(page), { timeout: 90_000 }).toBe("view");
      // The window's agent started one command, which the window stopped as it followed along.
      await expect.poll(() => standIn?.runs(LABEL).length, { timeout: 30_000 }).toBe(1);
      const [owned] = standIn.runs(LABEL);
      await expect.poll(() => alive(owned as number), { timeout: 30_000 }).toBe(false);
      await expect.poll(() => standIn?.running(LABEL)).toBe(false);
      expect(standIn.runs(LABEL)).toHaveLength(1);
      await expect
        .poll(async () =>
          (await pro.page.evaluate(() => window.infinitary.devices.list())).some(
            (device) => device.id === deviceId && device.inReach,
          ),
        )
        .toBe(true);
      await air.close();
      air = undefined;
      standIn.stopAll();
      endCommands();
    });

    await test.step("a grant waiting before either starts, beside a sign-in saved here: the window stays home and its command keeps running after it quits", async () => {
      const userDataDir = scratchDir("infinitary-follow-kept-");
      const homeDir = scratchDir("infinitary-follow-kept-home-");
      standIn = serviceManagerStandIn(homeDir);
      // A GitHub Enterprise sign-in saved here before any database, which only its file's presence answers.
      seedGitHubSignIn(userDataDir, GITHUB_STUB_KEY, "git.example.com");
      await addedByAddress(join(userDataDir, "work"));
      air = await launchApp({
        userDataDir,
        homeDir,
        env: {
          ...standIn.env,
          INFINITARY_WINDOW_STARTS_RUN: "1",
          INFINITARY_DEVICE_NAME: "Mac mini",
        },
      });
      const { page } = air;
      await welcomed(page);
      const owned = commandPid(userDataDir);
      expect(standIn.runs(LABEL)).toEqual([owned]);
      // Something was set up here, so the window does not take the computer over in place.
      expect(await page.evaluate(() => window.infinitary.devices.followAdded())).toMatchObject({
        followed: false,
      });
      expect(await roleOf(page)).toBe("home");
      await air.close();
      air = undefined;
      // The window quit; the command its agent started keeps running, and its agent keeps it.
      expect(alive(owned)).toBe(true);
      expect(standIn.running(LABEL)).toBe(true);
      expect(standIn.runs(LABEL)).toEqual([owned]);
    });
  } finally {
    await air?.close();
    await pro.close();
  }
});
