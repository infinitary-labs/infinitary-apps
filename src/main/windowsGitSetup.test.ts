import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { GIT_FOR_WINDOWS, type WindowsGit } from "../core/windowsGit";
import { ensureWindowsGit, GIT_SETUP_WORDS, type GitSetupDeps } from "./windowsGitSetup";

/**
 * INF-4243 piece 1: an installed Windows app with no suitable Git offers
 * Git for Windows before it opens, and runs its installer only once the
 * download is the pinned release signed by its publisher
 * (docs/windows.md, "Git for Windows").
 */

const installed: WindowsGit = {
  root: "C:\\Users\\Ada\\AppData\\Local\\Programs\\Git",
  git: "C:\\Users\\Ada\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
  bash: "C:\\Users\\Ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
  version: `git version ${GIT_FOR_WINDOWS.version}.windows.1`,
};

const signed = { status: "Valid", subject: "CN=Johannes Schindelin, O=Johannes Schindelin, C=DE" };

/** A PC with no Git whose person answers each dialog in turn; what happened is recorded. */
function pcWithoutGit(answers: number[], overrides: Partial<GitSetupDeps> = {}) {
  const seen = {
    asked: [] as string[],
    installs: 0,
    gitAfterInstall: installed as WindowsGit | undefined,
  };
  let ranInstaller = false;
  const deps: GitSetupDeps = {
    env: {},
    find: async () => (ranInstaller ? seen.gitAfterInstall : undefined),
    ask: async (words) => {
      seen.asked.push(words.message);
      // The download's dialog stays up until the download closes it.
      if (words.signal) {
        const signal = words.signal;
        return new Promise((done) => signal.addEventListener("abort", () => done(0)));
      }
      return answers.shift() ?? 1;
    },
    tempDir: scratchDir("infinitary-git-setup-"),
    download: async () => GIT_FOR_WINDOWS.sha256,
    signature: async () => signed,
    install: async () => {
      seen.installs += 1;
      ranInstaller = true;
      return 0;
    },
    ...overrides,
  };
  return { deps, seen };
}

describe("Git for Windows on first launch", () => {
  it("uses a suitable Git already on the PC without asking", async () => {
    const { deps, seen } = pcWithoutGit([]);
    expect(await ensureWindowsGit({ ...deps, find: async () => installed })).toEqual({
      git: installed,
    });
    expect(seen.asked).toEqual([]);
  });

  it("installs nothing when the person chooses Quit", async () => {
    const { deps, seen } = pcWithoutGit([1]);
    expect(await ensureWindowsGit(deps)).toEqual({ quit: true });
    expect(seen.asked).toEqual([GIT_SETUP_WORDS.ask.message]);
    expect(seen.installs).toBe(0);
  });

  it("downloads, checks and installs Git for Windows, then opens with it", async () => {
    const { deps, seen } = pcWithoutGit([0]);
    expect(await ensureWindowsGit(deps)).toEqual({ git: installed });
    expect(seen.asked).toEqual([GIT_SETUP_WORDS.ask.message, GIT_SETUP_WORDS.downloading.message]);
    expect(seen.installs).toBe(1);
  });

  it("never runs an altered download, and says so", async () => {
    const { deps, seen } = pcWithoutGit([0, 1], { download: async () => "0".repeat(64) });
    expect(await ensureWindowsGit(deps)).toEqual({ quit: true });
    expect(seen.installs).toBe(0);
    expect(seen.asked.at(-1)).toBe(GIT_SETUP_WORDS.failed.message);
  });

  it("never runs a download signed by someone else", async () => {
    const { deps, seen } = pcWithoutGit([0, 1], {
      signature: async () => ({ status: "Valid", subject: "CN=Mallory" }),
    });
    expect(await ensureWindowsGit(deps)).toEqual({ quit: true });
    expect(seen.installs).toBe(0);
  });

  it("refuses an installed Git that answers another version, and tries again on request", async () => {
    const { deps, seen } = pcWithoutGit([0, 0, 1]);
    seen.gitAfterInstall = { ...installed, version: "git version 2.40.0.windows.1" };
    expect(await ensureWindowsGit(deps)).toEqual({ quit: true });
    expect(seen.installs).toBe(2);
  });
});
