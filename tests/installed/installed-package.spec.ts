import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { POLKIT_ACTION } from "../../src/main/host/linuxFreshAuthentication";
import { MOCK_COMPLETION_TEXT } from "../e2e/mockProvider";
import { taskBranch } from "../e2e/projects";
import { promptInput } from "../e2e/prompt";
import { reportLine, startedLine, taskKey } from "../e2e/rails";
import { withoutRunnerSession } from "../helpers/runnerSession";
import { scratchDir } from "../helpers/scratchDirs";
import { appProcesses, type InstalledApp, launchInstalled } from "./installedApp";

/**
 * An installed Linux package on a clean copy of its system
 * (docs/linux-packages.md, "The checks"): it opens with Chromium's sandbox
 * on, reports the version the package carries, and runs a crew turn on a
 * project with the system's own git, the way a person's first task does.
 */

let launched: InstalledApp;

test.beforeAll(async () => {
  launched = await launchInstalled();
});

test.afterAll(async () => {
  await launched?.close();
});

/** A project with one commit, made with the system's git. */
function project(): string {
  const dir = scratchDir("infinitary-installed-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@localhost");
  writeFileSync(join(dir, "README.md"), "# A project\n");
  git("add", "-A");
  git("commit", "-m", "init");
  return dir;
}

test("the installed package opens sandboxed, reports its version and runs a crew turn with the system's git", async () => {
  test.setTimeout(3 * 60_000);
  const { page } = launched;

  await test.step("it opens on Linux with Chromium's sandbox on", async () => {
    const health = await page.evaluate(() => window.infinitary.app.healthcheck());
    expect(health.ok).toBe(true);
    expect(health.platform).toBe("linux");
    const expected = process.env.INFINITARY_INSTALLED_VERSION?.trim();
    if (expected) expect(health.version).toBe(expected);
    const processes = appProcesses(launched.process.pid as number);
    const table = JSON.stringify(processes, null, 1);
    // Chromium's sandboxed processes run confined in a process namespace of
    // their own, and nothing of the app was told to drop the sandbox.
    expect(
      processes.some((child) => child.seccomp === 2 && child.ownPidNamespace),
      table,
    ).toBe(true);
    expect(
      processes.filter((child) => child.args.includes("--no-sandbox")),
      table,
    ).toEqual([]);
    await expect(promptInput(page)).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the package carries a fresh-confirmation policy, not a retained approval", async () => {
    // INF-1109: check the installed payload, not source text; this is not a live human-confirmation proof.
    const policy = process.env.INFINITARY_INSTALLED_SECRET_POLICY;
    if (!policy) {
      // An AppImage cannot install system policy or silently substitute another authorization method.
      expect(process.env.APPIMAGE_EXTRACT_AND_RUN).toBe("1");
      expect(existsSync(`/usr/share/polkit-1/actions/${POLKIT_ACTION}.policy`)).toBe(false);
      return;
    }
    const file = statSync(policy);
    expect(file.uid).toBe(0);
    expect(file.mode & 0o022).toBe(0);
    const parsed = await page.evaluate(
      (xml) => {
        const document = new DOMParser().parseFromString(xml, "application/xml");
        return {
          root: document.documentElement.tagName,
          error: document.querySelector("parsererror")?.textContent ?? null,
          actions: [...document.querySelectorAll("policyconfig > action")].map((action) => ({
            id: action.getAttribute("id"),
            any: action.querySelector("defaults > allow_any")?.textContent,
            inactive: action.querySelector("defaults > allow_inactive")?.textContent,
            active: action.querySelector("defaults > allow_active")?.textContent,
          })),
        };
      },
      readFileSync(policy, "utf8"),
    );
    expect(parsed).toEqual({
      root: "policyconfig",
      error: null,
      actions: [{ id: POLKIT_ACTION, any: "no", inactive: "no", active: "auth_self" }],
    });
    const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "secrets-policy.json"), JSON.stringify(parsed, null, 2));
    }
  });

  // INF-3042: Nix must resolve libsecret from the packaged native module,
  // not merely place the library in the executable's runpath. No service call.
  const nativeModule = process.env.INFINITARY_INSTALLED_SECRET_MODULE;
  if (nativeModule) {
    await test.step("the installed native module resolves the secret library", async () => {
      const environment = readFileSync(`/proc/${launched.process.pid}/environ`, "utf8");
      const libraryPath = environment
        .split("\0")
        .find((entry) => entry.startsWith("LD_LIBRARY_PATH="))
        ?.slice("LD_LIBRARY_PATH=".length);
      expect(libraryPath).toBeTruthy();
      // The installed Nix module needs its system's libc, not hosted Ubuntu Node's.
      // Read the actual app's mapping; the check must load that same library.
      const appLibc = readFileSync(`/proc/${launched.process.pid}/maps`, "utf8").match(
        /\/nix\/store\/[^\s]+\/libc\.so\.6(?=\n|$)/,
      )?.[0];
      expect(appLibc).toBeTruthy();
      const nativeNode = process.env.INFINITARY_INSTALLED_SECRET_NODE;
      if (!nativeNode)
        throw new Error("The installed native-module check needs its Nix Node runtime.");
      const loaded = execFileSync(
        nativeNode,
        [
          "-e",
          `
        const koffi = require(process.argv[1]);
        const secret = koffi.load('libsecret-1.so.0');
        secret.func('void *secret_service_get_sync(int, void *, void *)');
        secret.unload();
        const libc = require('node:fs').readFileSync('/proc/self/maps', 'utf8')
          .match(/\\/nix\\/store\\/[^\\s]+\\/libc\\.so\\.6(?=\\n|$)/)?.[0];
        process.stdout.write(JSON.stringify({library: 'libsecret-1.so.0', resolved: true, invoked: false, libc}));
      `,
          nativeModule,
        ],
        {
          env: {
            ...withoutRunnerSession(process.env),
            HOME: launched.homeDir,
            LD_LIBRARY_PATH: libraryPath,
          },
          encoding: "utf8",
        },
      );
      const result = JSON.parse(loaded);
      expect(result).toEqual({
        library: "libsecret-1.so.0",
        resolved: true,
        invoked: false,
        libc: appLibc,
      });
      const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
      if (evidence)
        writeFileSync(
          join(evidence, "native-secret-library.json"),
          JSON.stringify(result, null, 2),
        );
    });
  }

  await test.step("a crewmate takes a task on a project and reports", async () => {
    const repo = project();
    await page.evaluate((path) => window.infinitary.repos.setup({ kind: "adopt", path }), repo);
    const title = `tidy the readme in ${basename(repo)}`;
    const input = promptInput(page);
    await input.click();
    await input.fill(`commission a crewmate: ${title}`);
    await input.press("Enter");
    const key = await taskKey(page, title);
    await expect(startedLine(page, key)).toBeVisible({ timeout: 60_000 });
    // The task's working copy is a worktree the system's git made, on the
    // branch its record names.
    const id = await page.evaluate(
      async (wanted) =>
        (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted)?.id ??
        "",
      title,
    );
    const branch = await taskBranch(page, id);
    expect(branch).not.toBe("");
    const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"]).toString();
    expect(worktrees).toContain(`[${branch}]`);
    await expect(
      reportLine(page, key).filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) }),
    ).toBeVisible({ timeout: 60_000 });
    const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "crew-turn.png"), animations: "disabled" });
    }
  });
});
