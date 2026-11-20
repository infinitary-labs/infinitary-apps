import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { runLabelOf } from "@shared/codeNames";
import type { TaskDetail } from "@shared/tasks";
import type { UpdateChannel } from "@shared/update";
import { UPDATE_WORDS, updateResumedWords } from "@shared/updateWords";
import { publicBuildsUrl } from "../../src/core/update/releaseSource";
import { UPDATE_CHANNEL_MARKER } from "../../src/core/update/updateChannels";
import { WINDOWS_UPDATES_FOLDER } from "../../src/core/update/windowsInstall";
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
      provider = await startMockProvider({ scenarios: [updateResume] });
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
      // own conversation, opening with the words of a turn an update saved;
      // a turn a quit or a crash cut opens with other words.
      const lastWords = (body: string) => providerMessages(body).at(-1);
      const resumed = () =>
        (provider?.requestBodies() ?? []).filter((body) => {
          const last = lastWords(body);
          return last?.role === "user" && last.text.includes(updateResumedWords());
        });
      await expect.poll(() => resumed().length, { timeout: 180_000 }).toBe(1);
      const delivery = resumed()[0] ?? "";
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
