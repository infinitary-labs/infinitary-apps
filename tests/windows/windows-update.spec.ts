import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { runLabelOf } from "@shared/codeNames";
import type { UpdateChannel } from "@shared/update";
import { UPDATE_WORDS } from "@shared/updateWords";
import { publicBuildsUrl } from "../../src/core/update/releaseSource";
import { UPDATE_CHANNEL_MARKER } from "../../src/core/update/updateChannels";
import { WINDOWS_UPDATES_FOLDER } from "../../src/core/update/windowsInstall";
import { GIT_FOR_WINDOWS } from "../../src/core/windowsGit";
import { GIT_SETUP_WORDS } from "../../src/main/windowsGitSetup";
import { SPAWN_PROMPT_MARKER } from "../e2e/mockProvider";
import { promptInput } from "../e2e/prompt";
import { taskKey } from "../e2e/rails";
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
 * Task Scheduler as it does every day, signs in, starts a task and changes
 * a setting. Then the feed offers the newer version three ways: with a
 * checksum the download does not match, which installs nothing; with a
 * download that stops partway, which installs nothing; and as published,
 * which the window's Update and restart installs, the new copy opening
 * with the same tasks, setting, sign-in and Task Scheduler entry.
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

/** Electron for this checkout's version, unpacked from the job's Electron cache; "" when it holds none. */
function electronFromCache(): string {
  const cache = process.env.electron_config_cache ?? "";
  const version = (
    JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    }
  ).devDependencies.electron;
  const name = `electron-v${version}-win32-x64.zip`;
  const zip =
    cache && existsSync(cache)
      ? readdirSync(cache, { recursive: true, encoding: "utf8" }).find((entry) =>
          entry.endsWith(name),
        )
      : undefined;
  if (!zip) return "";
  const into = scratchDir("infinitary-update-electron-");
  ps(`Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:INTO -Force; $true`, {
    ZIP: join(cache, zip),
    INTO: into,
  });
  return join(into, "electron.exe");
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
  let launched: InstalledApp | undefined;

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
      trustSystemStore(true);
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
      // The Node inside Electron, the app's own, with the same setting: what
      // it reads of this person's store and what it answers. Kept, not
      // asserted: the installed app's own check below is the assertion.
      // Electron's own zip for this version, from the cache this job's
      // install reads, unpacked here: the same Node the app runs.
      const electron = electronFromCache();
      const electronReading = existsSync(electron)
        ? (
            await promisify(execFile)(
              electron,
              [
                "-e",
                `const tls = require("node:tls"); const { X509Certificate } = require("node:crypto");
const system = tls.getCACertificates("system");
const feed = system.filter((pem) => new X509Certificate(pem).subject.includes("localhost")).length;
fetch(process.argv[1]).then((r) => String(r.status), (e) => String(e.cause?.code ?? "") + " " + String(e.cause ?? e))
  .then((answer) => console.log(JSON.stringify({ system: system.length, feed, answer })));`,
                publicBuildsUrl,
              ],
              {
                encoding: "utf8",
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_USE_SYSTEM_CA: "1" },
              },
            )
          ).stdout.trim()
        : "no Electron in the job's Electron cache";
      keep("feed-electron.txt", electronReading);
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
    await test.step("the older copy's window starts the command, signs in, starts a task and changes a setting", async () => {
      launched = await launchInstalled({ ownDataDir: dataDir, signIn: true });
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
      const title = `Update check task ${channel}`;
      const input = promptInput(page);
      await input.click();
      await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await input.press("Enter");
      key = await taskKey(page, title);
      keep("task-before.txt", key);
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
    const installNothing = async (mode: UpdateFeed["mode"], problem: string, picture: string) => {
      if (!feed) throw new Error("no feed");
      feed.mode = mode;
      await offered();
      const answer = await page().evaluate(() => window.infinitary.update.install());
      keep(`${picture}.json`, JSON.stringify(answer, null, 2));
      expect(answer).toMatchObject({ ok: false, problem });
      // Nothing was handed over: the older copy still answers, and keeps no installer.
      expect((await updateStatus(page())).currentVersion).toBe(older);
      expect(installedVersion()).toBe(older);
      expect(existsSync(join(dataDir, WINDOWS_UPDATES_FOLDER))).toBe(false);
      await showPanel(picture);
    };
    const showPanel = async (picture: string) => {
      const indicator = page().getByRole("button", { name: `Update available: ${newer}` });
      if (!(await page().locator("[data-update-channel]").isVisible())) await indicator.click();
      const panel = page().locator("[data-update-channel]");
      await expect(panel).toBeVisible();
      if (evidence) await panel.screenshot({ path: join(evidence, `${picture}.png`) });
      return panel;
    };

    await test.step("a download that does not match its published checksum installs nothing", async () => {
      await installNothing(
        "wrong-checksum",
        "The download did not match its published checksum, so nothing was installed.",
        "wrong-checksum",
      );
    });

    await test.step("a download that stops partway installs nothing", async () => {
      await installNothing(
        "interrupted",
        "The download stopped before it finished. Try again.",
        "interrupted-download",
      );
    });

    await test.step("Update and restart installs the newer version, and its window opens again", async () => {
      if (!feed) throw new Error("no feed");
      feed.mode = "published";
      await offered();
      const panel = await showPanel("update-offered");
      const windowPid = launched?.process.pid;
      await panel.getByRole("button", { name: UPDATE_WORDS.restart }).click();
      // The command saves its crew's work and ends, the installer replaces
      // the copy and opens the new window through the Start menu entry.
      await expect.poll(installedVersion, { timeout: 10 * 60_000, intervals: [2_000] }).toBe(newer);
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
      launched = await launchInstalled({ ownDataDir: dataDir });
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
      expect(board.tasks.map((task) => task.key)).toContain(key);
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
    await feed?.close().catch(() => undefined);
    if (thumbprint) await removeFeedCertificate(thumbprint, within).catch(() => undefined);
    trustSystemStore(false);
    delete process.env.NODE_USE_SYSTEM_CA;
  }
});
