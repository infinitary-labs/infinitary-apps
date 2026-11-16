import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect, type Page } from "@playwright/test";
import { mockModelsJson } from "../e2e/mockModels";
import { type MockProviderServer, type Scenario, startMockProvider } from "../e2e/mockProvider";
import { withoutRunnerSession } from "../helpers/runnerSession";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * An installed Linux package, opened the way its desktop entry opens it
 * (docs/linux-packages.md, "The checks"), or the app a Windows installer
 * put in place (docs/windows.md, "The checks"): its own executable, its own
 * sandbox, no development entry. The release's fuses turn off the Node
 * inspector Playwright's Electron launcher needs, so the journey reaches
 * the window through Chromium's own debugging port and acts only as a
 * person and the window's own bridge can. HOME, userData and the model
 * provider are throwaway, as every journey's are (tests/e2e/launch.ts).
 */
export type InstalledApp = {
  readonly page: Page;
  readonly process: ChildProcess;
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly mockProvider: MockProviderServer;
  readonly close: () => Promise<void>;
};

/** The installed executable this run checks, named by the package check. */
export function installedExecutable(): string {
  const executable = process.env.INFINITARY_INSTALLED_APP?.trim();
  if (!executable) {
    throw new Error(
      "INFINITARY_INSTALLED_APP names the installed package's executable (docs/linux-packages.md, docs/windows.md).",
    );
  }
  return executable;
}

/** Chromium writes its debugging port into the profile once it listens. */
async function debuggingPort(userDataDir: string, app: ChildProcess): Promise<number> {
  const file = join(userDataDir, "DevToolsActivePort");
  let port = 0;
  await expect
    .poll(
      () => {
        if (app.exitCode !== null) throw new Error(`the app exited with ${app.exitCode}`);
        if (!existsSync(file)) return 0;
        port = Number(readFileSync(file, "utf8").split("\n")[0]);
        return port;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return port;
}

/** The app's own window: the page whose bridge answers. */
async function appWindow(browser: Browser): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of browser.contexts().flatMap((context) => context.pages())) {
          const bridged = await page
            .evaluate(() => typeof window.infinitary?.app?.healthcheck === "function")
            .catch(() => false);
          if (bridged) {
            found = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return found as Page;
}

/** The home folder a run gives the app: its own on Linux; on Windows the profile's too. */
function homeEnv(homeDir: string): Record<string, string> {
  if (process.platform === "win32") {
    // %APPDATA% and %LOCALAPPDATA% stay the person's: the per-user Git for
    // Windows the app found or installed lives under the latter. Windows
    // still expands its own folders (Electron's appData among them) from
    // %USERPROFILE%, and answers none that is missing, so the throwaway
    // profile carries them.
    for (const folder of [["Roaming"], ["Local"], ["Local", "Temp"]])
      mkdirSync(join(homeDir, "AppData", ...folder), { recursive: true });
    return { HOME: homeDir, USERPROFILE: homeDir };
  }
  return {
    HOME: homeDir,
    TMPDIR: scratchDir("infinitary-installed-tmp-"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
  };
}

export async function launchInstalled(
  options: { scenarios?: readonly Scenario[] } = {},
): Promise<InstalledApp> {
  const userDataDir = scratchDir("infinitary-installed-data-");
  const homeDir = scratchDir("infinitary-installed-home-");
  const mockProvider = await startMockProvider({ scenarios: options.scenarios });
  mkdirSync(join(userDataDir, "auth"), { recursive: true });
  writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mockProvider.port));
  const log: string[] = [];
  const app = spawn(
    installedExecutable(),
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    {
      env: {
        ...(withoutRunnerSession(process.env) as Record<string, string>),
        ...homeEnv(homeDir),
        // Pi's own switch for startup network operations (tests/e2e/launch.ts).
        PI_OFFLINE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout?.on("data", (chunk) => log.push(String(chunk)));
  app.stderr?.on("data", (chunk) => log.push(String(chunk)));
  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close().catch(() => undefined);
    if (app.exitCode === null) {
      app.kill("SIGTERM");
      const exited = new Promise((done) => app.once("exit", done));
      const killed = setTimeout(() => app.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(killed);
    }
    await mockProvider.close();
    const evidence = process.env.INFINITARY_INSTALLED_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "app-output.txt"), log.join(""));
    }
  };
  try {
    const port = await debuggingPort(userDataDir, app);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await appWindow(browser);
    return { page, process: app, homeDir, userDataDir, mockProvider, close };
  } catch (error) {
    await close();
    throw new Error(`${String(error)}\nThe app's output:\n${log.join("")}`);
  }
}

/** One process of the installed app, as the system's process table reads it. */
export type AppProcess = {
  readonly pid: number;
  readonly name: string;
  /** Its switches; empty where the sandbox hides them from other processes. */
  readonly args: readonly string[];
  /** 2 when a seccomp filter confines it: Chromium's sandbox. */
  readonly seccomp: number;
  /** Its own process namespace sits inside another: Chromium's sandbox. */
  readonly ownPidNamespace: boolean;
};

/**
 * The process the check started and every process beneath it - the app's
 * main process and each of Chromium's - read from /proc. A sandboxed
 * process hides its switches, but its status says what confines it.
 */
export function appProcesses(root: number): AppProcess[] {
  const statuses = new Map<number, Map<string, string>>();
  for (const name of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const fields = new Map<string, string>();
      for (const line of readFileSync(join("/proc", name, "status"), "utf8").split("\n")) {
        const at = line.indexOf(":");
        if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
      }
      statuses.set(Number(name), fields);
    } catch {
      // Gone between the listing and the read.
    }
  }
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, fields] of statuses) {
      if (!family.has(pid) && family.has(Number(fields.get("PPid")))) {
        family.add(pid);
        grew = true;
      }
    }
  }
  return [...family].flatMap((pid) => {
    const fields = statuses.get(pid);
    if (!fields) return [];
    let args: string[] = [];
    try {
      args = readFileSync(join("/proc", String(pid), "cmdline"), "utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      // Hidden by the sandbox.
    }
    return [
      {
        pid,
        name: fields.get("Name") ?? "",
        args,
        seccomp: Number(fields.get("Seccomp") ?? 0),
        ownPidNamespace: (fields.get("NSpid") ?? "").split(/\s+/).length > 1,
      },
    ];
  });
}
