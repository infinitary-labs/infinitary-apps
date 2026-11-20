import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { runLabelOf } from "@shared/codeNames";
import type { TaskDetail } from "@shared/tasks";
import type { UpdateChannel } from "@shared/update";
import {
  UPDATE_NOTICES,
  UPDATE_WORDS,
  updateResumedWords,
  WINDOWS_HAND_OVER_WORDS,
} from "@shared/updateWords";
import { publicBuildsUrl } from "../../src/core/update/releaseSource";
import { UPDATE_CHANNEL_MARKER } from "../../src/core/update/updateChannels";
import {
  WINDOWS_HAND_OVER_RESULT,
  WINDOWS_UPDATES_FOLDER,
  windowsHandOverScript,
} from "../../src/core/update/windowsInstall";
import { GIT_FOR_WINDOWS } from "../../src/core/windowsGit";
import { GIT_SETUP_WORDS } from "../../src/main/windowsGitSetup";
import {
  type MockProviderServer,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
} from "../e2e/mockProvider";
import { heroShotShowing } from "../e2e/pictures";
import { promptInput } from "../e2e/prompt";
import { providerMessages, providerToolCalls } from "../e2e/providerRequest";
import { taskKey } from "../e2e/rails";
import {
  MOCK_UPDATE_RESUME_REPORT,
  UPDATE_RESUME_MARKER,
  updateResume,
} from "../e2e/scenarios/updateResume";
import { scratchDir } from "../helpers/scratchDirs";
import { type InstalledApp, launchInstalled } from "../installed/installedApp";
import {
  makeFeedCertificate,
  readThroughTaskScheduler,
  removeFeedCertificate,
  startUpdateFeed,
  trustSystemStore,
  type UpdateFeed,
} from "./updateFeed";
import { UPDATE_VERSIONS } from "./updateVersions";
import {
  appProcessesOn,
  dialogWords,
  powershellPath,
  pressDialogButton,
  ps,
  psList,
  removalEntries,
  runProcesses,
  runTask,
  screenshot,
  stillRunning,
  topAppProcesses,
  uninstallerOf,
} from "./windowsMachine";

/**
 * Infinitary on Windows updates itself (docs/windows.md, "The update
 * check"; INF-4243's piece 7, as INF-5230's plan re-scoped it). windows.yml
 * built two unsigned test versions of one channel from this commit, whose
 * release source is this machine's own feed, and installed the older one
 * the way a person's double-click does. The journey gives the PC Git for
 * Windows on the person's yes, so the window starts the command through
 * Task Scheduler as it does every day, signs in, changes a setting and
 * starts a task whose crewmate's turn is still running. Then the feed
 * offers the newer version three ways, each pressed on Settings -> General's
 * Version row: with a checksum the download does not match, which installs
 * nothing; with a download that stops partway, which Try again installs
 * nothing from either; and as published, which Try again installs once the
 * turn is saved, the new copy opening with the same tasks, setting, sign-in
 * and Task Scheduler entry and carrying the turn on.
 */

const channel = process.env.INFINITARY_UPDATE_CHANNEL as UpdateChannel | undefined;
const installers = process.env.INFINITARY_UPDATE_INSTALLERS ?? "";
const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
const keep = (name: string, text: string) => {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, name), text);
};

test.skip(!channel, "windows.yml's update check names the channel it checks");

/** The installed copy's version, as its removal entry in Windows Settings names it. */
function installedVersion(): string | null {
  return ps<string | null>(`
    $entry = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Infinitary*' } | Select-Object -First 1
    if ($entry) { [string]$entry.DisplayVersion } else { $null }`);
}

/** Waits up to a minute until `done` answers true. */
const within = async (done: () => boolean) => {
  await expect.poll(done, { timeout: 60_000, intervals: [500] }).toBe(true);
};

/** The version the window's first mate says this copy is, with its update. */
const updateStatus = (page: Page) => page.evaluate(() => window.infinitary.update.status());

test("Infinitary on Windows updates itself from its channel, refusing a wrong checksum and a broken download", async () => {
  test.setTimeout(50 * 60_000);
  if (!channel) return;
  const [older, newer] = UPDATE_VERSIONS[channel];
  const appData = process.env.APPDATA as string;
  const localAppData = process.env.LOCALAPPDATA as string;
  const dataDir = join(appData, "infinitary");
  const gitRoot = join(localAppData, "Programs", "Git");
  const label = runLabelOf("release");
  let executable = "";
  let feed: UpdateFeed | undefined;
  let thumbprint = "";
  let restoreTrust: (() => void) | undefined;
  const nodeTrustBefore = process.env.NODE_USE_SYSTEM_CA;
  let launched: InstalledApp | undefined;
  // One stand-in for the older copy and the newer one, so the sign-in the
  // newer copy keeps still reaches it, until the turn it carries on is saved.
  let provider: MockProviderServer | undefined;
  // What the journey could not take back of its changes to this person's machine.
  const left: string[] = [];

  try {
    await test.step(`the older ${channel} test version installed for this person and opened`, async () => {
      const entries = removalEntries();
      keep("removal-entries-before.json", JSON.stringify(entries, null, 2));
      expect(entries.map((entry) => entry.hive)).toEqual(["HKCU"]);
      const [entry] = entries;
      if (!entry) throw new Error("no removal entry");
      executable = join(dirname(uninstallerOf(entry)), "Infinitary.exe");
      process.env.INFINITARY_INSTALLED_APP = executable;
      expect(installedVersion()).toBe(older);
      await expect.poll(() => topAppProcesses().length, { timeout: 60_000 }).toBeGreaterThan(0);
    });

    await test.step("with Git for Windows installed on the person's yes, the window starts the command through Task Scheduler", async () => {
      const [opened] = topAppProcesses();
      if (!opened) throw new Error("the app is not running");
      await expect
        .poll(() => pressDialogButton(opened.pid, GIT_SETUP_WORDS.ask.buttons[0]), {
          timeout: 60_000,
          intervals: [500],
        })
        .toBe(true);
      const gitVersion = (): string => {
        try {
          return execFileSync(join(gitRoot, "cmd", "git.exe"), ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return "";
        }
      };
      await expect
        .poll(gitVersion, { timeout: 10 * 60_000, intervals: [2_000] })
        .toBe(`git version ${GIT_FOR_WINDOWS.version}.windows.1`);
      await expect
        .poll(() => readdirSync(dataDir).some((entry) => entry.endsWith(".db")), {
          timeout: 120_000,
        })
        .toBe(true);
      // The first window ran its own first mate while it had no Git; the
      // journey's window, opened next, starts the command beside itself.
      for (const { pid } of topAppProcesses()) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      }
      await expect.poll(() => topAppProcesses().length, { timeout: 30_000 }).toBe(0);
    });

    await test.step("this person's feed of the newer version, trusted for them alone", async () => {
      const work = scratchDir("infinitary-update-feed-");
      const passphrase = randomUUID();
      const made = await makeFeedCertificate(
        join(work, "feed.pfx"),
        passphrase,
        within,
        evidence ? join(evidence, "root-warning-tree.json") : undefined,
      );
      thumbprint = made.thumbprint;
      // Before the window starts the command: Task Scheduler gives it this person's environment.
      restoreTrust = trustSystemStore();
      // A window a person opens after the change carries it too, as
      // Explorer takes in the changed environment; this check opens its
      // window from its own.
      process.env.NODE_USE_SYSTEM_CA = "1";
      feed = await startUpdateFeed({ channel, installers, pfx: made.pfx, passphrase });
      // Node, as the app's own runs it, reads the feed with only the person's
      // trust. The reader is its own process, read without blocking this
      // one, which serves the feed.
      const read = async (systemCa: boolean) =>
        (
          await promisify(execFile)(
            process.execPath,
            [
              "-e",
              "fetch(process.argv[1]).then((r) => console.log(String(r.status)), (e) => console.log(String(e.cause ?? e)))",
              publicBuildsUrl,
            ],
            {
              encoding: "utf8",
              env: { ...process.env, NODE_USE_SYSTEM_CA: systemCa ? "1" : "" },
            },
          )
        ).stdout.trim();
      const reading = await read(true);
      // The command reads the feed as Task Scheduler starts it, with the
      // environment Task Scheduler gives it.
      const scheduled = await readThroughTaskScheduler(publicBuildsUrl, work, within);
      keep(
        "feed-trusted.txt",
        `with the system store: ${reading}\nwithout: ${await read(false)}\nstarted by Task Scheduler: ${JSON.stringify(scheduled)}`,
      );
      expect(reading).toBe("200");
      expect(scheduled).toEqual({ NODE_USE_SYSTEM_CA: "1", reading: "200" });
    });

    const notifications = { before: false };
    const signIn = join(dataDir, "auth", "models.json");
    let signInBefore = "";
    let key = "";
    await test.step("the older copy's window starts the command, signs in, changes a setting and starts a task whose turn is still running", async () => {
      // Held through the update the installer does not finish, which the kept
      // copy carries on, and through the one that installs.
      provider = await startMockProvider({ scenarios: [updateResume(2)] });
      launched = await launchInstalled({
        ownDataDir: dataDir,
        signIn: true,
        reuseMockProvider: provider,
      });
      const { page } = launched;
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      await expect.poll(() => runProcesses().length, { timeout: 60_000 }).toBe(1);
      keep("run-task-before.json", JSON.stringify(runTask(label), null, 2));
      expect((await updateStatus(page)).currentVersion).toBe(older);
      signInBefore = readFileSync(signIn, "utf8");
      // A setting away from its default, which the new copy must keep.
      const was = await page.evaluate(() => window.infinitary.settings.getNotifications());
      await page.evaluate((enabled) => window.infinitary.settings.setNotifications(enabled), !was);
      notifications.before = !was;
      // A task, asked of the first mate as a person asks.
      const title = `${UPDATE_RESUME_MARKER} on ${channel}`;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      key = await taskKey(page, title);
      keep("task-before.txt", key);
      // Its crewmate's model is still working: the stand-in holds the turn open.
      await expect.poll(() => provider?.heldRequests(), { timeout: 120_000 }).toBe(1);
    });

    const page = () => (launched as InstalledApp).page;
    const offered = async () => {
      const status = await page().evaluate(() => window.infinitary.update.check());
      keep("status-offered.json", JSON.stringify(status, null, 2));
      expect(status).toMatchObject({
        currentVersion: older,
        channel,
        latestVersion: newer,
        updateAvailable: true,
        install: { asksPassword: false, restarts: true },
      });
      return status;
    };
    /**
     * Settings -> General's Version row, opened as a person opens it. The
     * window reads the offer when it opens, once an hour and as this row
     * opens, so a check asked of the command alone reaches the window here.
     */
    const versionRow = async () => {
      const row = page().locator('[data-setting="version"]').locator("..");
      if (!(await row.isVisible())) {
        await page().getByRole("button", { name: "Settings", exact: true }).click();
        await page().getByRole("tab", { name: "General", exact: true }).click();
      }
      await expect(row).toBeVisible();
      return row;
    };
    /** The older copy goes on as it was: its window and its command, at the older version, with no installer kept and its crewmate's turn still running. */
    const olderGoesOn = async () => {
      const windowPid = launched?.process.pid ?? 0;
      expect(stillRunning([windowPid])).toEqual([windowPid]);
      expect(runProcesses()).toHaveLength(1);
      expect((await updateStatus(page())).currentVersion).toBe(older);
      expect(installedVersion()).toBe(older);
      expect(existsSync(join(dataDir, WINDOWS_UPDATES_FOLDER))).toBe(false);
      expect(provider?.heldRequests()).toBe(1);
    };
    /** Presses the row's `button` while the feed serves `mode`, which installs nothing and says `problem`. */
    const installsNothing = async (
      mode: UpdateFeed["mode"],
      button: string,
      problem: string,
      picture: string,
    ) => {
      if (!feed) throw new Error("no feed");
      feed.mode = mode;
      const row = await versionRow();
      await row.getByRole("button", { name: button, exact: true }).click();
      await expect(row.locator("[data-update-line]")).toContainText(problem, {
        timeout: 5 * 60_000,
      });
      await expect(
        row.getByRole("button", { name: UPDATE_WORDS.retry, exact: true }),
      ).toBeEnabled();
      await olderGoesOn();
      if (evidence) await row.screenshot({ path: join(evidence, `${picture}.png`) });
    };

    await test.step("Settings -> General's Version row offers the newer version", async () => {
      if (!feed) throw new Error("no feed");
      feed.mode = "published";
      await offered();
      const row = await versionRow();
      await expect(
        row.getByRole("button", { name: UPDATE_WORDS.restart, exact: true }),
      ).toBeEnabled();
      if (evidence) {
        await row.screenshot({ path: join(evidence, "update-offered.png") });
        // The release note's picture pair: the row as a Windows copy now
        // draws it, in both themes, the saved theme back after.
        const saved = await page().evaluate(() => window.infinitary.settings.getAppearance());
        await heroShotShowing(
          page(),
          { region: row, name: "windows-updates-itself", dir: evidence },
          async (theme) => {
            const next = theme ?? saved.theme;
            await page().evaluate(
              (appearance) => window.infinitary.settings.setAppearance(appearance),
              { ...saved, theme: next },
            );
            await expect.poll(() => page().evaluate(() => document.body.dataset.theme)).toBe(next);
          },
        );
      }
    });

    await test.step("a download that does not match its published checksum installs nothing, and the older copy goes on", async () => {
      await installsNothing(
        "wrong-checksum",
        UPDATE_WORDS.restart,
        "The download did not match its published checksum, so nothing was installed.",
        "wrong-checksum",
      );
    });

    await test.step("Try again, with a download that stops partway, installs nothing, and the older copy goes on", async () => {
      await installsNothing(
        "interrupted",
        UPDATE_WORDS.retry,
        "The download stopped before it finished. Try again.",
        "interrupted-download",
      );
    });

    // The provider requests that carry on the turn an update stopped, each
    // opening with the words of a turn an update saved; a turn a quit or a
    // crash cut opens with other words.
    const lastWords = (body: string) => providerMessages(body).at(-1);
    const resumed = () =>
      (provider?.requestBodies() ?? []).filter((body) => {
        const last = lastWords(body);
        return last?.role === "user" && last.text.includes(updateResumedWords());
      });

    await test.step("Try again, with an installer that stops, keeps the older copy, which opens again, carries the turn on and says the installer stopped", async () => {
      if (!feed) throw new Error("no feed");
      feed.mode = "failing";
      const row = await versionRow();
      const windowPid = launched?.process.pid ?? 0;
      const commandBefore = runProcesses().map((process) => process.pid);
      await row.getByRole("button", { name: UPDATE_WORDS.retry, exact: true }).click();
      // The command saves the turn and ends; the hand-over's installer
      // exits with an error, so the hand-over ends the window and opens the
      // kept copy, which starts its command again.
      await expect
        .poll(() => stillRunning([windowPid]), { timeout: 10 * 60_000, intervals: [2_000] })
        .toEqual([]);
      const newCommand = () =>
        runProcesses().filter((process) => !commandBefore.includes(process.pid));
      await expect.poll(() => newCommand().length, { timeout: 180_000 }).toBe(1);
      expect(runProcesses()).toHaveLength(1);
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      expect(installedVersion()).toBe(older);
      // The kept copy carries the turn on, and the stand-in holds it again.
      await expect.poll(() => resumed().length, { timeout: 180_000 }).toBe(1);
      await expect.poll(() => provider?.heldRequests(), { timeout: 60_000 }).toBe(1);
      keep("kept-copy-resumed-turn.txt", lastWords(resumed()[0] ?? "")?.text ?? "");
      const opened = topAppProcesses().filter(
        (process) => !runProcesses().some((run) => run.pid === process.pid),
      );
      keep("kept-copy-window.json", JSON.stringify(opened, null, 2));
      expect(opened).toHaveLength(1);
      if (evidence) screenshot(join(evidence, "kept-copy-window.png"));
      // The journey's own window, on the same command, reads what the kept copy says.
      await launched?.close().catch(() => undefined);
      for (const { pid } of opened) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      }
      launched = await launchInstalled({ ownDataDir: dataDir, reuseMockProvider: provider });
      const kept = await versionRow();
      await expect(kept.locator("[data-update-line]")).toContainText(
        `${WINDOWS_HAND_OVER_WORDS.installFailed} ${UPDATE_NOTICES.stillAvailable(newer)}`,
        { timeout: 120_000 },
      );
      await expect(
        kept.getByRole("button", { name: UPDATE_WORDS.retry, exact: true }),
      ).toBeEnabled();
      expect(runProcesses()).toHaveLength(1);
      expect(existsSync(join(dataDir, WINDOWS_HAND_OVER_RESULT))).toBe(false);
      expect(existsSync(join(dataDir, WINDOWS_UPDATES_FOLDER))).toBe(false);
      if (evidence) await kept.screenshot({ path: join(evidence, "installer-stopped.png") });
    });

    await test.step("Try again, with the published download, saves the running turn, installs the newer version, and the new copy carries the turn on", async () => {
      if (!feed) throw new Error("no feed");
      feed.mode = "published";
      const row = await versionRow();
      const windowPid = launched?.process.pid;
      await row.getByRole("button", { name: UPDATE_WORDS.retry, exact: true }).click();
      // The command saves its crew's work and ends, the installer replaces
      // the copy and opens the new window through the Start menu entry.
      // Every process of the hand-over seen while the copy is replaced, kept
      // whatever the wait answers: which ran, from which parent, and when it ended.
      const seen = new Map<
        number,
        { name: string; parent: number; command: string; first: number; last: number }
      >();
      const started = Date.now();
      const watchHandOver = () => {
        const now = Date.now() - started;
        for (const p of psList<{
          ProcessId: number;
          ParentProcessId: number;
          Name: string;
          CommandLine: string | null;
        }>(
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Infinitary|powershell|taskkill|Un_A|Un_B)' -or $_.Name -match 'setup' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine",
        )) {
          const was = seen.get(p.ProcessId);
          if (was) was.last = now;
          else
            seen.set(p.ProcessId, {
              name: p.Name,
              parent: p.ParentProcessId,
              command: p.CommandLine ?? "",
              first: now,
              last: now,
            });
        }
      };
      try {
        await expect
          .poll(
            () => {
              watchHandOver();
              return installedVersion();
            },
            { timeout: 10 * 60_000, intervals: [2_000] },
          )
          .toBe(newer);
      } finally {
        keep(
          "hand-over-processes.json",
          JSON.stringify(
            [...seen].map(([pid, p]) => ({ pid, ...p })),
            null,
            2,
          ),
        );
        keep("run-task-after.json", JSON.stringify(runTask(label) ?? null, null, 2));
      }
      if (windowPid) {
        await expect.poll(() => stillRunning([windowPid]), { timeout: 120_000 }).toEqual([]);
      }
      await expect
        .poll(
          () =>
            topAppProcesses().filter((process) => process.parent.toLowerCase() === "explorer.exe")
              .length,
          { timeout: 120_000 },
        )
        .toBe(1);
      // The new window starts the command again through the same entry.
      await expect.poll(() => runTask(label)?.state, { timeout: 120_000 }).toBe("Running");
      if (evidence) screenshot(join(evidence, "new-window.png"));
      // The new copy's command carries on the turn the update stopped, in its
      // own conversation, once more.
      await expect.poll(() => resumed().length, { timeout: 180_000 }).toBe(2);
      const delivery = resumed()[1] ?? "";
      keep("resumed-turn.txt", lastWords(delivery)?.text ?? "");
      expect(delivery).toContain(UPDATE_RESUME_MARKER);
      // Its report ran in the new copy before anything ends it: the stand-in
      // was asked again with the report's result.
      const reported = () =>
        (provider?.requestBodies() ?? []).some(
          (body) =>
            body.includes(updateResumedWords()) &&
            providerMessages(body).at(-1)?.role === "tool" &&
            providerToolCalls(body).some(
              (call) => call.name === "report" && call.args.text === MOCK_UPDATE_RESUME_REPORT,
            ),
        );
      await expect.poll(reported, { timeout: 120_000 }).toBe(true);
    });

    await test.step("the new copy keeps the tasks, the setting, the sign-in and the Task Scheduler entry", async () => {
      await launched?.close().catch(() => undefined);
      for (const { pid } of topAppProcesses().filter(
        (process) => process.parent.toLowerCase() === "explorer.exe",
      )) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      }
      launched = await launchInstalled({ ownDataDir: dataDir, reuseMockProvider: provider });
      const after = launched.page;
      const status = await updateStatus(after);
      keep("status-after.json", JSON.stringify(status, null, 2));
      expect(status.currentVersion).toBe(newer);
      expect(status.updateAvailable).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, UPDATE_CHANNEL_MARKER), "utf8"))).toMatchObject({
        channel,
        version: newer,
      });
      expect(await after.evaluate(() => window.infinitary.settings.getNotifications())).toBe(
        notifications.before,
      );
      expect(readFileSync(signIn, "utf8")).toBe(signInBefore);
      const board = await after.evaluate(() => window.infinitary.tasks.board());
      const id = board.tasks.find((task) => task.key === key)?.id ?? "";
      expect(id).not.toBe("");
      // The turn the update stopped finished in the new copy.
      const outcome = async () =>
        (
          (await after.evaluate(
            (task) => window.infinitary.tasks.detail(task),
            id,
          )) as TaskDetail | null
        )?.outcome ?? "";
      await expect.poll(outcome, { timeout: 60_000 }).toContain(MOCK_UPDATE_RESUME_REPORT);
      const task = runTask(label);
      keep("run-task-after.json", JSON.stringify(task, null, 2));
      expect(task?.execute.toLowerCase()).toBe(executable.toLowerCase());
      expect(task?.arguments).toBe("run");
      expect(removalEntries().map((entry) => entry.hive)).toEqual(["HKCU"]);
      // The installer the update ran is gone once the new copy started.
      await expect
        .poll(() => existsSync(join(dataDir, WINDOWS_UPDATES_FOLDER)), { timeout: 60_000 })
        .toBe(false);
      if (evidence) await after.screenshot({ path: join(evidence, "after-update.png") });
    });
  } finally {
    if (feed) keep("feed-requests.json", JSON.stringify(feed.asked, null, 2));
    await launched?.close().catch(() => undefined);
    await provider?.close().catch(() => undefined);
    // Each change to this person's machine is taken back, and one that
    // could not be is said: kept beside a failure's own error, and failing
    // a journey that passed, below.
    const undo = async (what: string, step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        left.push(`${what}: ${String(error)}`);
      }
    };
    await undo("closing the feed", () => feed?.close());
    if (thumbprint)
      await undo("taking the feed's certificate away", () =>
        removeFeedCertificate(thumbprint, within),
      );
    if (restoreTrust) await undo("putting NODE_USE_SYSTEM_CA back", restoreTrust);
    if (nodeTrustBefore === undefined) delete process.env.NODE_USE_SYSTEM_CA;
    else process.env.NODE_USE_SYSTEM_CA = nodeTrustBefore;
    if (left.length > 0) {
      keep("cleanup-failures.txt", left.join("\n"));
      console.error(`the update check could not undo what it changed: ${left.join("; ")}`);
    }
  }
  expect(left, "every change the journey made to this person's machine was taken back").toEqual([]);
});

/**
 * The hand-over's ways back (docs/alpha.md, "When installing cannot
 * finish"), each run directly with stand-ins the journey above cannot
 * reach. A program the test compiles stands in for the installer, exiting
 * as it is told and recording its arguments, and for a copy that starts
 * but never shows a window; a disposable process that outlives the wait,
 * shortened to seconds, stands in for an app still saving; the installed
 * copy opens on a data folder of its own (`--user-data-dir`, with a space
 * and an apostrophe in it) beside a window of its own on another folder,
 * which must keep running; and a copy without its app cannot open. The
 * download page is a batch file that records it opened.
 */
test("the Windows hand-over keeps a copy still saving, reopens a copy on its own data folder and says how to recover one that cannot open", async () => {
  test.setTimeout(15 * 60_000);
  const [entry] = removalEntries();
  if (!entry) throw new Error("no removal entry");
  const executable = join(dirname(uninstallerOf(entry)), "Infinitary.exe");
  const root = scratchDir("inf-windows-hand-over-");
  const profile = join(root, "a person's other folder");
  const sibling = join(root, "a sibling folder");
  mkdirSync(profile, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const marker = join(profile, UPDATE_CHANNEL_MARKER);
  const resultFile = join(profile, WINDOWS_HAND_OVER_RESULT);
  const opened = join(root, "page-opened.txt");
  const page = join(root, "download page.cmd");
  writeFileSync(page, `@echo off\r\necho opened>"${opened}"\r\n`);

  // Every process the test starts, stopped when it ends however it ends,
  // and what each hand-over wrote to its error output.
  const owned: number[] = [];
  const errors: string[] = [];
  const end = (pid: number) => {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  };
  const start = (args: string[]) => {
    const child = spawn(powershellPath, ["-NoProfile", "-NonInteractive", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const pid = child.pid ?? 0;
    owned.push(pid);
    child.stderr?.on("data", (chunk: Buffer) => errors.push(`${pid}: ${chunk.toString()}`));
    // An ended process's number may be reused, so it is no longer stopped.
    const ended = new Promise<number | null>((done) =>
      child.on("exit", (code) => {
        if (owned.includes(pid)) owned.splice(owned.indexOf(pid), 1);
        done(code);
      }),
    );
    return { pid, ended };
  };
  const handOver = (values: Parameters<typeof windowsHandOverScript>[0]) =>
    start([
      "-EncodedCommand",
      Buffer.from(windowsHandOverScript(values), "utf16le").toString("base64"),
    ]);
  // The app the hand-over waits for, already ended.
  const endedApp = async () => {
    const gone = start(["-Command", "exit"]);
    await gone.ended;
    return gone.pid;
  };

  // The stand-in program: it records its arguments in ran.txt beside it,
  // stays running without a window while stay.txt is there, and otherwise
  // exits with the code in code.txt, or 0.
  const compiled = join(root, "stand-in", "stand-in.exe");
  mkdirSync(dirname(compiled), { recursive: true });
  ps<boolean>(
    "Add-Type -TypeDefinition $env:STAND_IN_SOURCE -Language CSharp -OutputAssembly $env:STAND_IN_EXE -OutputType WindowsApplication; Test-Path -LiteralPath $env:STAND_IN_EXE",
    {
      STAND_IN_EXE: compiled,
      STAND_IN_SOURCE: [
        "using System; using System.IO; using System.Threading;",
        "static class StandIn { static int Main(string[] args) {",
        "  string here = AppDomain.CurrentDomain.BaseDirectory;",
        '  File.WriteAllText(Path.Combine(here, "ran.txt"), string.Join(" ", args));',
        '  if (File.Exists(Path.Combine(here, "stay.txt"))) Thread.Sleep(Timeout.Infinite);',
        '  string code = Path.Combine(here, "code.txt");',
        "  return File.Exists(code) ? int.Parse(File.ReadAllText(code).Trim()) : 0;",
        "} }",
      ].join("\n"),
    },
  );
  const standIn = (
    folder: string,
    name: string,
    how: { code?: number; stay?: boolean; app?: boolean } = {},
  ) => {
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true });
    copyFileSync(compiled, join(dir, name));
    if (how.code !== undefined) writeFileSync(join(dir, "code.txt"), String(how.code));
    if (how.stay) writeFileSync(join(dir, "stay.txt"), "");
    if (how.app) {
      mkdirSync(join(dir, "resources"), { recursive: true });
      writeFileSync(join(dir, "resources", "app.asar"), "");
    }
    const ran = join(dir, "ran.txt");
    return {
      file: join(dir, name),
      ran: () => (existsSync(ran) ? readFileSync(ran, "utf8") : null),
    };
  };
  const finishes = standIn("installer that finishes", "setup.exe");
  const stops = standIn("installer that stops", "setup.exe", { code: 3 });

  const windowShown = (pid: number) =>
    ps<boolean>(
      "$p = Get-Process -Id ([int]$env:APP_PID) -ErrorAction SilentlyContinue; [bool]($p -and $p.MainWindowHandle -ne [IntPtr]::Zero)",
      { APP_PID: String(pid) },
    );
  const windowOn = async (folder: string) => {
    await expect
      .poll(() => appProcessesOn(executable, folder).length, { timeout: 120_000 })
      .toBe(1);
    const [pid = 0] = appProcessesOn(executable, folder);
    await expect.poll(() => windowShown(pid), { timeout: 120_000 }).toBe(true);
    return pid;
  };
  const said = () => JSON.parse(readFileSync(resultFile, "utf8").replace(/^﻿/, ""));
  const result = { from: "0.0.1", to: "0.0.2" };
  const recovery = WINDOWS_HAND_OVER_WORDS.noCopy(page);
  let others: number[] = [];

  try {
    await test.step("a window of the installed copy opens on a sibling folder, which the hand-over must leave running", async () => {
      ps<boolean>(
        "Start-Process -FilePath $env:APP_EXE -ArgumentList ('\"--user-data-dir=' + $env:APP_DATA + '\"'); $true",
        { APP_EXE: executable, APP_DATA: sibling },
      );
      const pid = await windowOn(sibling);
      others = [...new Set([pid, ...topAppProcesses().map((p) => p.pid)])];
      expect(others).toContain(pid);
    });

    await test.step("an app still running after the wait gets nothing installed, its channel back and its copy opened once it ends", async () => {
      writeFileSync(marker, "the channel this update chose");
      const saving = start(["-Command", "Start-Sleep -Seconds 900"]);
      const run = handOver({
        pid: saving.pid,
        installer: finishes.file,
        executable,
        dataDir: profile,
        resultFile,
        result,
        marker: { file: marker, earlier: "the channel it followed" },
        page,
        waitSeconds: 5,
      });
      await expect.poll(() => existsSync(resultFile), { timeout: 60_000 }).toBe(true);
      expect(said()).toEqual({ outcome: "shutdown-timeout", ...result, channelKept: true });
      expect(readFileSync(marker, "utf8")).toBe("the channel it followed");
      // Nothing opens while the app it waits for still runs.
      expect(appProcessesOn(executable, profile)).toEqual([]);
      end(saving.pid);
      await windowOn(profile);
      expect(await run.ended).toBe(0);
      expect(finishes.ran()).toBeNull();
      expect(existsSync(opened)).toBe(false);
      expect(stillRunning(others)).toEqual(others);
      if (evidence) screenshot(join(evidence, "hand-over-timeout-reopened.png"));
    });

    await test.step("a finished update of a copy on its own data folder ends that folder's window and opens the copy there again", async () => {
      const before = appProcessesOn(executable, profile);
      expect(before).toHaveLength(1);
      rmSync(resultFile, { force: true });
      const run = handOver({
        pid: await endedApp(),
        installer: finishes.file,
        executable,
        dataDir: profile,
        resultFile,
        result,
        marker: { file: marker, earlier: null },
        page,
      });
      expect(await run.ended).toBe(0);
      // The installer ran, as an update and without opening the person's own folder.
      expect(finishes.ran()?.trim()).toBe("--updated /S");
      const after = await windowOn(profile);
      expect(after).not.toBe(before[0]);
      expect(stillRunning(before)).toEqual([]);
      expect(existsSync(resultFile)).toBe(false);
      expect(existsSync(opened)).toBe(false);
      expect(stillRunning(others)).toEqual(others);
    });

    const recovered = async (copy: ReturnType<typeof standIn>, readySeconds?: number) => {
      for (const pid of appProcessesOn(executable, profile)) end(pid);
      rmSync(opened, { force: true });
      rmSync(join(dirname(stops.file), "ran.txt"), { force: true });
      const run = handOver({
        pid: await endedApp(),
        installer: stops.file,
        executable: copy.file,
        dataDir: profile,
        resultFile,
        result,
        marker: { file: marker, earlier: "the channel it followed" },
        page,
        ...(readySeconds ? { readySeconds } : {}),
      });
      await expect
        .poll(() => dialogWords(run.pid).join(" "), { timeout: 120_000 })
        .toContain(recovery);
      // The installer ran and stopped with its error before the message.
      expect(stops.ran()?.trim()).toBe("--updated /S");
      expect(said()).toEqual({ outcome: "install-failed", ...result, channelKept: true });
      expect(existsSync(opened)).toBe(false);
      return run;
    };

    await test.step("a copy that starts but never shows a window is said in a message, and its download page opens next", async () => {
      const copy = standIn("a copy that never shows a window", "Infinitary.exe", {
        stay: true,
        app: true,
      });
      const run = await recovered(copy, 10);
      // The hand-over did open it, on the same data folder.
      expect(copy.ran()).toBe(`--user-data-dir=${profile}`);
      expect(pressDialogButton(run.pid, "OK")).toBe(true);
      expect(await run.ended).toBe(0);
      await expect.poll(() => existsSync(opened), { timeout: 60_000 }).toBe(true);
      expect(stillRunning(others)).toEqual(others);
    });

    await test.step("a copy without its app is said in a message without being started, and its download page opens next", async () => {
      const copy = standIn("a copy without its app", "Infinitary.exe");
      const run = await recovered(copy);
      keep("hand-over-recovery-message.json", JSON.stringify(dialogWords(run.pid), null, 2));
      if (evidence) screenshot(join(evidence, "hand-over-recovery-message.png"));
      expect(copy.ran()).toBeNull();
      expect(pressDialogButton(run.pid, "OK")).toBe(true);
      expect(await run.ended).toBe(0);
      await expect.poll(() => existsSync(opened), { timeout: 60_000 }).toBe(true);
      expect(stillRunning(others)).toEqual(others);
    });
  } finally {
    for (const pid of owned) end(pid);
    for (const folder of [profile, sibling])
      for (const pid of appProcessesOn(executable, folder)) end(pid);
    // Stand-ins a hand-over opened, which outlive it.
    ps<boolean>(
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:STAND_IN_ROOT, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $true",
      { STAND_IN_ROOT: `${root}\\` },
    );
    if (errors.length > 0) keep("hand-over-errors.txt", errors.join("\n"));
  }
});
