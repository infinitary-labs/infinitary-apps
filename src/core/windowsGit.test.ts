import { describe, expect, it } from "vitest";
import {
  findWindowsGit,
  GIT_FOR_WINDOWS,
  refuseDownloadedGit,
  type WindowsGitProbe,
} from "./windowsGit";

/**
 * INF-4243 piece 1: an installed Windows app reuses a suitable Git for
 * Windows wherever it lives, and runs the Git for Windows installer it
 * offers only when the download is the pinned release, signed by its
 * publisher (docs/windows.md, "Git for Windows").
 */

/** A Windows 11 person's environment, as a Start menu launch gives it. */
const env: NodeJS.ProcessEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramW6432: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Local",
};

/** A PC whose disk holds these files, each git answering as Git for Windows 2.56.1 does. */
function pc(files: readonly string[], onPath: readonly string[] = []): WindowsGitProbe {
  const held = new Set(files.map((file) => file.toLowerCase()));
  return {
    exists: (path) => held.has(path.toLowerCase()),
    version: async (git) =>
      held.has(git.toLowerCase()) ? "git version 2.56.1.windows.1" : undefined,
    onPath: async () => onPath,
  };
}

const perUser = "C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Git";

describe("finding Git for Windows", () => {
  it("reuses the install the app's offer makes, in the person's own folder", async () => {
    const found = await findWindowsGit(
      env,
      pc([`${perUser}\\cmd\\git.exe`, `${perUser}\\bin\\bash.exe`]),
    );
    expect(found).toEqual({
      root: perUser,
      git: `${perUser}\\cmd\\git.exe`,
      bash: `${perUser}\\bin\\bash.exe`,
      version: "git version 2.56.1.windows.1",
    });
  });

  it("reuses a Git installed for everyone, before one on the search path", async () => {
    const scoop = "C:\\Users\\Ada Lovelace\\scoop\\apps\\git\\current";
    const found = await findWindowsGit(
      env,
      pc(
        [
          `${scoop}\\cmd\\git.exe`,
          `${scoop}\\bin\\bash.exe`,
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\bash.exe",
        ],
        [`${scoop}\\cmd\\git.exe`],
      ),
    );
    expect(found?.root).toBe("C:\\Program Files\\Git");
  });

  it("finds an install anywhere else through the git on the search path", async () => {
    const elsewhere = "D:\\Tools\\Git";
    const found = await findWindowsGit(
      env,
      pc(
        [`${elsewhere}\\cmd\\git.exe`, `${elsewhere}\\bin\\bash.exe`],
        [`${elsewhere}\\mingw64\\bin\\git.exe`],
      ),
    );
    expect(found?.bash).toBe(`${elsewhere}\\bin\\bash.exe`);
  });

  it("passes over a git with no Git Bash beside it, such as MinGit", async () => {
    const minGit = "C:\\Tools\\MinGit";
    expect(
      await findWindowsGit(env, pc([`${minGit}\\cmd\\git.exe`], [`${minGit}\\cmd\\git.exe`])),
    ).toBe(undefined);
  });

  it("passes over an install whose git does not run", async () => {
    const probe = pc([`${perUser}\\cmd\\git.exe`, `${perUser}\\bin\\bash.exe`]);
    expect(await findWindowsGit(env, { ...probe, version: async () => undefined })).toBe(undefined);
  });
});

describe("checking the downloaded installer", () => {
  // The subject Git for Windows' releases are signed with.
  const signed = {
    status: "Valid",
    subject: "CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE",
  };

  it("lets the pinned release, validly signed by its publisher, run", () => {
    expect(refuseDownloadedGit(GIT_FOR_WINDOWS.sha256, signed)).toBe(undefined);
  });

  it("refuses a download whose bytes differ from the pinned release", () => {
    const altered = `${GIT_FOR_WINDOWS.sha256.slice(0, -1)}0`;
    expect(refuseDownloadedGit(altered, signed)).toMatch(/not the Git for Windows release/);
  });

  it("refuses a signature Windows does not trust", () => {
    expect(
      refuseDownloadedGit(GIT_FOR_WINDOWS.sha256, { ...signed, status: "HashMismatch" }),
    ).toMatch(/could not confirm/);
    expect(refuseDownloadedGit(GIT_FOR_WINDOWS.sha256, undefined)).toMatch(/could not confirm/);
  });

  it("refuses a valid signature by anyone but Git for Windows' publisher", () => {
    expect(
      refuseDownloadedGit(GIT_FOR_WINDOWS.sha256, {
        status: "Valid",
        subject: "CN=Someone Else, O=Johannes Schindelin",
      }),
    ).toMatch(/not signed by Git for Windows' publisher/);
  });
});
