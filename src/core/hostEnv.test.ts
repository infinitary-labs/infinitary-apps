import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  captureLoginPath,
  hostEnv,
  loginPathCapture,
  mergeSearchPath,
  resetLoginPathForTests,
  withTaskShell,
} from "./hostEnv";
import { plantProgram, writeLoginShellStub } from "./loginShellStub";
import {
  installerDirs,
  parseMarkedPath,
  readLoginShellPath,
  SHELL_LOOKUP_TIMEOUT_MS,
} from "./userBin";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function scratch(): string {
  return scratchDir("infinitary-hostenv-");
}

/** Run `command` through /bin/sh with the environment a child of the core gets. */
function runAsChild(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", command], { env: hostEnv() }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim());
    });
  });
}

describe("withTaskShell (a session's own shell over the host's)", () => {
  it("adds its variables and puts its folders first on the search path, once each", () => {
    const env = withTaskShell(
      { PATH: "/app/axi-bin:/usr/bin:/bin", HOME: "/Users/sam" },
      { env: { INFINITARY_AXI_KEY: "/channel/t1.key" }, path: ["/app/axi-bin"] },
    );
    expect(env).toEqual({
      PATH: "/app/axi-bin:/usr/bin:/bin",
      HOME: "/Users/sam",
      INFINITARY_AXI_KEY: "/channel/t1.key",
    });
    expect(withTaskShell({ PATH: "/usr/bin" }, undefined)).toEqual({ PATH: "/usr/bin" });
  });
});

describe("mergeSearchPath (one search path for every child)", () => {
  const installers = ["/opt/homebrew/bin", "/usr/local/bin"];

  it("gives a Dock launch the person's own order: the shell's path, then missing installer dirs", () => {
    const login = [
      "/Users/p/.nvm/versions/node/v24/bin",
      "/opt/homebrew/bin",
      ...SYSTEM_PATH.split(":"),
    ];
    expect(mergeSearchPath(login, SYSTEM_PATH, installers).split(":")).toEqual([
      "/Users/p/.nvm/versions/node/v24/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/usr/local/bin",
    ]);
  });

  it("keeps what the launcher added on purpose ahead of the shell's path", () => {
    const merged = mergeSearchPath(
      ["/opt/homebrew/bin", "/usr/bin", "/bin"],
      `/tmp/stand-in:${SYSTEM_PATH}`,
      installers,
    ).split(":");
    expect(merged[0]).toBe("/tmp/stand-in");
    expect(merged.indexOf("/opt/homebrew/bin")).toBeLessThan(merged.indexOf("/usr/bin"));
  });

  it("lists every entry once and drops empty ones", () => {
    expect(mergeSearchPath(["/a", "/b", "/a"], "/b::/c:/c", ["/a", "/d", "/d"]).split(":")).toEqual(
      ["/c", "/a", "/b", "/d"],
    );
  });

  it("with no shell answer, is the process path and then the installer dirs", () => {
    expect(mergeSearchPath([], SYSTEM_PATH, installers)).toBe(
      `${SYSTEM_PATH}:/opt/homebrew/bin:/usr/local/bin`,
    );
  });
});

describe("parseMarkedPath", () => {
  it("reads only between the marks, whatever the startup files printed around them", () => {
    const mark = "__INFINITARY_LOGIN_PATH__";
    const output = `\u001b]0;zsh\u0007Welcome back!\n${mark}/a/bin:/b/bin${mark}\nbye\n`;
    expect(parseMarkedPath(output)).toEqual(["/a/bin", "/b/bin"]);
  });

  it("is nothing without both marks or without an absolute entry", () => {
    expect(parseMarkedPath("/usr/bin:/bin")).toBeUndefined();
    expect(
      parseMarkedPath("__INFINITARY_LOGIN_PATH__relative__INFINITARY_LOGIN_PATH__"),
    ).toBeUndefined();
  });
});

describe("captureLoginPath (ask the person's shell once)", () => {
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

  beforeEach(() => {
    resetLoginPathForTests();
    process.env.PATH = SYSTEM_PATH;
  });

  afterEach(() => {
    resetLoginPathForTests();
    process.env.PATH = saved.PATH;
    process.env.SHELL = saved.SHELL;
  });

  it("finds what only the interactive startup file puts on the path (nvm in .zshrc)", async () => {
    const dir = scratch();
    const nvm = join(dir, "nvm", "bin");
    plantProgram(nvm, "node", "v99.0.0-planted");
    const stub = writeLoginShellStub(join(dir, "shell"), {
      interactive: `PATH='${nvm}':"$PATH"`,
    });
    process.env.SHELL = stub.shell;

    // A login-only shell never reads that file.
    const loginOnly = await readLoginShellPath(process.env, "login");
    expect("entries" in loginOnly && loginOnly.entries.includes(nvm)).toBe(false);

    const capture = await captureLoginPath();
    expect(capture.source).toBe("interactive");
    expect(capture.entries[0]).toBe(nvm);
    expect(await runAsChild("node --version")).toBe("v99.0.0-planted");
  });

  it("reads through a noisy startup file: greetings, a title sequence, output after the command", async () => {
    const dir = scratch();
    const bin = join(dir, "tools");
    plantProgram(bin, "pnpm", "11.0.0-planted");
    const stub = writeLoginShellStub(join(dir, "shell"), {
      interactive: `printf '\\033]0;zsh\\007Last login: today\\nWelcome, captain\\n'
PATH='${bin}':"$PATH"`,
      afterInteractive: "echo goodbye",
    });
    process.env.SHELL = stub.shell;

    const capture = await captureLoginPath();
    expect(capture).toMatchObject({ source: "interactive" });
    expect(capture.entries).toEqual([bin, ...SYSTEM_PATH.split(":")]);
    expect(await runAsChild("pnpm --version")).toBe("11.0.0-planted");
  });

  it("falls back to the login-only answer when the interactive startup file hangs", async () => {
    const dir = scratch();
    const brew = join(dir, "brew", "bin");
    const stub = writeLoginShellStub(join(dir, "shell"), {
      // A question nobody will answer, and a child that would hold the pipe open.
      interactive: "sleep 30 & read answer; sleep 30",
      login: `PATH='${brew}':"$PATH"`,
    });
    process.env.SHELL = stub.shell;

    const started = Date.now();
    const capture = await captureLoginPath();
    const elapsed = Date.now() - started;
    expect(capture).toMatchObject({ source: "login", interactiveMiss: "timeout" });
    expect(capture.entries[0]).toBe(brew);
    expect(elapsed).toBeLessThan(SHELL_LOOKUP_TIMEOUT_MS + 1_500);
  }, 10_000);

  it("falls back to the login-only answer when the interactive shell fails", async () => {
    const dir = scratch();
    const stub = writeLoginShellStub(join(dir, "shell"), {
      interactive: "exit 7",
      login: `PATH='/opt/from-login':"$PATH"`,
    });
    process.env.SHELL = stub.shell;
    expect(await captureLoginPath()).toMatchObject({
      source: "login",
      interactiveMiss: "exit",
      entries: expect.arrayContaining(["/opt/from-login"]),
    });
  });

  it("leaves the process path in charge when neither shell answers", async () => {
    const dir = scratch();
    const stub = writeLoginShellStub(join(dir, "shell"), {
      interactive: "exec true",
      login: "exit 1",
    });
    process.env.SHELL = stub.shell;
    expect(await captureLoginPath()).toEqual({
      source: "process",
      entries: [],
      interactiveMiss: "unparsable",
      loginMiss: "exit",
    });
    expect(hostEnv().PATH).toBe(mergeSearchPath([], SYSTEM_PATH, installerDirs(process.env)));
  });

  it("asks once per process, and records what it found", async () => {
    const dir = scratch();
    const stub = writeLoginShellStub(join(dir, "shell"), {});
    process.env.SHELL = stub.shell;
    expect(loginPathCapture()).toBeUndefined();
    const [first, second] = await Promise.all([captureLoginPath(), captureLoginPath()]);
    await captureLoginPath();
    hostEnv();
    hostEnv();
    expect(second).toBe(first);
    expect(loginPathCapture()).toBe(first);
    // One interactive ask and the one fallback beside it; wait for the
    // fallback's line, which lands after the interactive answer won.
    await expect
      .poll(() => (existsSync(stub.log) ? readFileSync(stub.log, "utf8").trim().split("\n") : []))
      .toEqual(expect.arrayContaining(["-ilc", "-lc"]));
    expect(readFileSync(stub.log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("lays extra variables over the process environment and never lets them replace the path", async () => {
    process.env.SHELL = writeLoginShellStub(join(scratch(), "shell"), {}).shell;
    await captureLoginPath();
    const env = hostEnv({ CI: "true", PATH: "/nowhere" });
    expect(env.CI).toBe("true");
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PATH?.split(":")).toEqual(expect.arrayContaining(SYSTEM_PATH.split(":")));
    expect(env.PATH).not.toContain("/nowhere");
  });
});
