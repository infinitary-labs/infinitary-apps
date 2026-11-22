import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The Git a Windows PC's app uses (docs/windows.md, "Git for Windows"): one
 * Git for Windows install, with its `git` and the Git Bash a crewmate's
 * commands run in (`pi/windowsBash.ts`). Windows ships neither, so the
 * installed app looks for a suitable one before its window opens and, when
 * there is none, offers to install Git for Windows for this person alone
 * (`src/main/windowsGitSetup.ts`).
 *
 * A suitable Git is a folder that holds both `cmd\git.exe` and
 * `bin\bash.exe`, whose git answers `--version`: Git for Windows' own
 * layout, wherever it was installed. The choice stays the app's: its
 * children find that `git` on their search path (`hostEnv.ts`), and
 * nothing changes the PC's own search path or Git settings.
 */
export type WindowsGit = {
  /** The install's folder, such as `C:\Program Files\Git`. */
  readonly root: string;
  readonly git: string;
  readonly bash: string;
  /** What its git answered, such as `git version 2.56.1.windows.1`. */
  readonly version: string;
};

/**
 * The Git for Windows the app offers to install: its makers' own release
 * for x64 PCs, checked before it runs by its SHA-256 (the one GitHub and
 * the release's notes both list), its publisher's signature and, once
 * installed, the version its git answers.
 */
export const GIT_FOR_WINDOWS = {
  version: "2.56.1",
  file: "Git-2.56.1-64-bit.exe",
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe",
  sha256: "c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559",
  bytes: 66_870_448,
  /** The name Git for Windows' releases are signed with. */
  publisher: "Johannes Schindelin",
} as const;

export type WindowsGitProbe = {
  readonly exists: (path: string) => boolean;
  /** `git --version`'s answer, or nothing when it does not run. */
  readonly version: (git: string) => Promise<string | undefined>;
  /** Every `git.exe` the search path holds, in its order (`where git`). */
  readonly onPath: () => Promise<readonly string[]>;
};

/**
 * Where to look, in order: Git for Windows' two Program Files folders,
 * which Pi's own lookup tries too, then its install for one person
 * (`%LOCALAPPDATA%\Programs\Git`, where the app's offer installs it), then
 * the install each `git.exe` on the search path belongs to.
 */
export function windowsGitRoots(env: NodeJS.ProcessEnv, onPath: readonly string[]): string[] {
  const roots: string[] = [];
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]) {
    if (base) roots.push(win32.join(base, "Git"));
  }
  if (env.LOCALAPPDATA) roots.push(win32.join(env.LOCALAPPDATA, "Programs", "Git"));
  for (const git of onPath) {
    // cmd\git.exe, bin\git.exe and mingw64\bin\git.exe all sit inside the install.
    const dir = win32.dirname(git);
    const parent = win32.dirname(dir);
    roots.push(win32.basename(parent).toLowerCase() === "mingw64" ? win32.dirname(parent) : parent);
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = win32.normalize(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function findWindowsGit(
  env: NodeJS.ProcessEnv,
  probe: WindowsGitProbe = realProbe(env),
): Promise<WindowsGit | undefined> {
  for (const root of windowsGitRoots(env, await probe.onPath())) {
    const git = win32.join(root, "cmd", "git.exe");
    const bash = win32.join(root, "bin", "bash.exe");
    if (!probe.exists(git) || !probe.exists(bash)) continue;
    const version = await probe.version(git);
    if (version) return { root, git, bash, version };
  }
  return undefined;
}

export function isOfferedVersion(answer: string): boolean {
  return answer.trim() === `git version ${GIT_FOR_WINDOWS.version}.windows.1`;
}

function realProbe(env: NodeJS.ProcessEnv): WindowsGitProbe {
  // Asynchronous, so the lookup never holds the app's main thread.
  const run = (file: string, args: string[]) =>
    new Promise<string | undefined>((resolve) => {
      execFile(
        file,
        args,
        { env, encoding: "utf8", timeout: 10_000, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
  return {
    exists: existsSync,
    version: async (git) => (await run(git, ["--version"]))?.trim() || undefined,
    onPath: async () =>
      ((await run("where", ["git"])) ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
  };
}

let chosen: WindowsGit | undefined;

/**
 * The Git this run uses, set once before the window opens. Its `cmd` folder
 * joins the children's search path (`hostEnv.ts`) and its Git Bash runs
 * the crew's commands (`pi/windowsBash.ts`).
 */
export function configureWindowsGit(git: WindowsGit | undefined): void {
  chosen = git;
}

export function windowsGit(): WindowsGit | undefined {
  return chosen;
}

/** What PowerShell's `Get-AuthenticodeSignature` read of a downloaded installer. */
export type InstallerSignature = {
  /** `Valid` when Windows trusts the signature and the file is unchanged. */
  readonly status: string;
  /** The signing certificate's subject, such as `CN=Johannes Schindelin, O=...`. */
  readonly subject: string;
};

/**
 * Why a downloaded installer must not run, or nothing when it may: its
 * SHA-256 is the pinned one, and Windows found a valid signature by Git for
 * Windows' publisher on it.
 */
export function refuseDownloadedGit(
  sha256: string,
  signature: InstallerSignature | undefined,
): string | undefined {
  if (sha256.toLowerCase() !== GIT_FOR_WINDOWS.sha256)
    return "The download is not the Git for Windows release Infinitary expects.";
  if (!signature || signature.status !== "Valid")
    return "Windows could not confirm the download's signature.";
  const commonName = /(?:^|,\s*)CN=([^,]+)/.exec(signature.subject)?.[1]?.trim();
  if (commonName !== GIT_FOR_WINDOWS.publisher)
    return "The download is not signed by Git for Windows' publisher.";
  return undefined;
}
