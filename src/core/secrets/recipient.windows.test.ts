import { describe, expect, it } from "vitest";
import { SECRET_CHECKED_WORDS } from "../../shared/secrets";
import { checkedFacts } from "./approvalCard";
import {
  gitBashSearchPath,
  keepsHostVariable,
  RECIPIENT_VARIABLES,
  type RecipientFacts,
  recipientBase,
  recipientVariables,
  windowsInterpreter,
  windowsProgram,
  windowsProgramNames,
} from "./recipient";

// Intent: the captain's answer on INF-4260, "Add Secrets on Windows first, as
// a new piece before piece 11": an approved use runs on a Windows PC as it
// does on a Mac or Linux computer, a script written for Git Bash included,
// and its card never claims more than Windows gives (docs/secrets.md, "The
// recipient").
const GIT = "C:\\Program Files\\Git";

describe("a recipient on Windows", () => {
  it("finds a command as a program Windows starts directly, never a batch file", () => {
    expect(windowsProgramNames("node")).toEqual(["node.exe", "node.com"]);
    expect(windowsProgramNames("curl.exe")).toEqual(["curl.exe"]);
    expect(windowsProgramNames("pnpm.cmd")).toEqual([]);
    expect(windowsProgramNames("deploy.ps1")).toEqual([]);
    expect(
      windowsProgram("C:\\Users\\sam\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.EXE"),
    ).toBe(true);
    expect(windowsProgram("C:\\Users\\sam\\website\\check.sh")).toBe(false);
  });

  it("reads a Git Bash script's #! line as Git Bash does", () => {
    expect(windowsInterpreter("/bin/sh", GIT)).toBe(`${GIT}\\usr\\bin\\sh.exe`);
    expect(windowsInterpreter("/usr/bin/bash", GIT)).toBe(`${GIT}\\usr\\bin\\bash.exe`);
    expect(windowsInterpreter("/mingw64/bin/python3.exe", GIT)).toBe(
      `${GIT}\\mingw64\\bin\\python3.exe`,
    );
    expect(windowsInterpreter("/bin/sh", undefined)).toBe(undefined);
    expect(windowsInterpreter("C:\\Tools\\sh.exe", GIT)).toBe(undefined);
  });

  it("looks a name up in Git Bash's folders before Windows' own, so bash is never WSL's", () => {
    // The captain's answer on the review: look in Git Bash's folders first, for scripts and typed names.
    const windowsPath = "C:\\Windows\\System32;C:\\Windows";
    expect(gitBashSearchPath(windowsPath, GIT).split(";")).toEqual([
      `${GIT}\\mingw64\\bin`,
      `${GIT}\\usr\\bin`,
      "C:\\Windows\\System32",
      "C:\\Windows",
    ]);
    expect(gitBashSearchPath(windowsPath, undefined)).toBe(windowsPath);
  });

  it("starts the program with Git Bash's order as its PATH, so a script finds cat and grep", () => {
    // Review INF-4677: Git's usr\bin\sh.exe adds no folders, so the host's PATH alone misses them.
    const host = {
      Path: `${GIT}\\cmd;C:\\Windows\\System32`,
      SystemRoot: "C:\\Windows",
      NODE_OPTIONS: "x",
    };
    const env = recipientBase(host, "win32", GIT);
    expect(env.PATH?.split(";")).toEqual([
      `${GIT}\\mingw64\\bin`,
      `${GIT}\\usr\\bin`,
      `${GIT}\\cmd`,
      "C:\\Windows\\System32",
    ]);
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.NODE_OPTIONS).toBe(undefined);
    expect(recipientBase(host, "win32", undefined).PATH).toBe(host.Path);
    expect(recipientBase({ PATH: "/usr/bin:/bin" }, "darwin", GIT).PATH).toBe("/usr/bin:/bin");
  });

  it("keeps the variables a Windows program needs, and refuses a mapping onto one in any case", () => {
    expect(recipientVariables("darwin")).toEqual(RECIPIENT_VARIABLES);
    expect(recipientVariables("win32")).toEqual(
      expect.arrayContaining(["PATH", "SystemRoot", "PATHEXT", "USERPROFILE", "TEMP"]),
    );
    expect(keepsHostVariable("Path", "win32")).toBe(true);
    expect(keepsHostVariable("systemroot", "win32")).toBe(true);
    expect(keepsHostVariable("Path", "darwin")).toBe(false);
    expect(keepsHostVariable("SystemRoot", "linux")).toBe(false);
    expect(keepsHostVariable("DEPLOY_TOKEN", "win32")).toBe(false);
  });

  it("says a Windows program runs where it is, never that nothing the person runs can change it", () => {
    const facts: RecipientFacts = {
      executable: {
        path: "C:\\Users\\sam\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
        sha256: "a".repeat(64),
        copied: false,
      },
      argv: ["./check.sh"],
      inputs: [],
      cwd: "C:\\Users\\sam\\website",
      env: { DEPLOY_TOKEN: "website" },
      delivery: "environment",
    };
    const program = checkedFacts(facts, [{ ref: "website", label: "Website deployment" }]).find(
      (fact) => fact.name === SECRET_CHECKED_WORDS.program,
    );
    expect(program?.value).toContain(SECRET_CHECKED_WORDS.inPlaceWindows);
    expect(program?.value).not.toContain(SECRET_CHECKED_WORDS.inPlace);

    const onShare = checkedFacts(
      { ...facts, executable: { ...facts.executable, path: "\\\\files\\tools\\deploy.exe" } },
      [{ ref: "website", label: "Website deployment" }],
    ).find((fact) => fact.name === SECRET_CHECKED_WORDS.program);
    expect(onShare?.value).toContain(SECRET_CHECKED_WORDS.inPlaceWindows);

    const onMac = checkedFacts(
      { ...facts, executable: { ...facts.executable, path: "/bin/sh" }, cwd: "/workspace" },
      [{ ref: "website", label: "Website deployment" }],
    ).find((fact) => fact.name === SECRET_CHECKED_WORDS.program);
    expect(onMac?.value).toContain(SECRET_CHECKED_WORDS.inPlace);
  });
});
