import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import {
  RUN_MARKER,
  RUN_UPDATED_EXIT,
  RUN_WORDS,
  RUNNING_BY_COMMAND,
} from "../../src/main/runCommand";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, defaultClaudeStubDir, hermeticEnv, launchApp } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { readSavedData } from "./savedData";

/**
 * Infinitary started by a command (docs/run.md; INF-1228's approved plan,
 * piece 1, "infinitary run"): the built app started as `<app> run`, as a
 * boot entry, a login or a terminal would start it, runs the whole app with
 * no window until a stop signal stops it, and ends with its reason when it
 * cannot go on. Data: a throwaway data folder and HOME through the hermetic
 * environment `launchApp` uses. On Linux each run has no display of the
 * person's, so it draws on its own (Xvfb, which every Linux package
 * requires), as a computer nobody is logged in to does.
 */

const children: ChildProcessWithoutNullStreams[] = [];
test.afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

/** The environment with no display of the person's, as a start at boot has. */
function noScreen(env: Record<string, string>): Record<string, string> {
  const { DISPLAY: _x, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

async function runEnv(userDataDir: string, extra: Record<string, string> = {}) {
  const homeDir = scratchDir("infinitary-run-command-home-");
  return noScreen({
    ...hermeticEnv({ userDataDir, homeDir, loopbackPort: String(await claimedPort()) }),
    INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(userDataDir)),
    ...extra,
  });
}

/** `<app> run <args>` as its starter runs it: what it says, and its end. */
function run(env: Record<string, string>, args: string[] = []) {
  const child = spawn(electronPath as unknown as string, [builtAppDir(), "run", ...args], {
    env,
    cwd: scratchDir("infinitary-run-command-cwd-"),
  });
  children.push(child);
  let out = "";
  let error = "";
  const waiters: (() => void)[] = [];
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  /** The command's own lines, apart from the notes the app's parts leave on its output. */
  const lines = () => out.split("\n").filter((line) => line && !line.startsWith("["));
  return {
    child,
    lines,
    error: () => error,
    exited,
    /** Resolves once the run says it runs; rejects when it ends first. */
    started: () =>
      new Promise<void>((resolve, reject) => {
        const look = () => {
          if (lines().includes(RUN_WORDS.started)) resolve();
          else waiters.push(look);
        };
        void exited.then((code) =>
          reject(new Error(`The run ended with ${code} before it started: ${error}`)),
        );
        look();
      }),
  };
}

/** The lines a run that cannot go on says, apart from Chromium's own notes on stderr. */
const said = (error: string) => error.split("\n").filter((line) => line && !line.startsWith("["));

test("a command starts the whole app with no window, and a stop signal stops it cleanly", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const ran = run(await runEnv(userDataDir));
  await ran.started();
  // The record is the app's own, open while it runs, with a note that a command runs it.
  expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(true);
  ran.child.kill("SIGTERM");
  expect(await ran.exited, ran.error()).toBe(0);
  expect(ran.lines()).toEqual([RUN_WORDS.started, RUN_WORDS.stopped]);
  expect(existsSync(join(userDataDir, RUN_MARKER))).toBe(false);
  // The core opened the app's own record and closed it cleanly.
  expect(
    readSavedData(userDataDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM tasks").get()),
  ).toEqual({ n: 0 });
});

/**
 * The captain's pick on INF-1228's question 6: "It says a command started
 * Infinitary here, and quits".
 */
test("Infinitary's window opened while a command runs says a command started it here", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const ran = run(await runEnv(userDataDir));
  await ran.started();
  const window = await launchApp({ userDataDir, shell: false });
  try {
    const page = window.page.getByRole("main", { name: "Saved work protection" });
    await expect(page.getByRole("heading")).toHaveText(RUNNING_BY_COMMAND.title);
    await expect(page).toContainText(RUNNING_BY_COMMAND.message);
  } finally {
    await window.close();
  }
  // The run goes on, untouched by the window.
  expect(ran.child.exitCode).toBeNull();
  ran.child.kill("SIGTERM");
  expect(await ran.exited, ran.error()).toBe(0);
});

test("a second command while one runs says Infinitary is already open and exits 1", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const first = run(await runEnv(userDataDir));
  await first.started();
  const second = run(await runEnv(userDataDir));
  expect(await second.exited).toBe(1);
  expect(said(second.error())).toEqual(RUN_WORDS.alreadyOpen);
  expect(first.child.exitCode).toBeNull();
  first.child.kill("SIGTERM");
  expect(await first.exited, first.error()).toBe(0);
});

/**
 * INF-1228's plan: "Both accounts run the one app in Applications. After you
 * update it, the command must exit so its starter runs the new version".
 * The installed program is a stand-in file the test replaces, as an update
 * replaces the app's.
 */
test("once the installed app is replaced, the run stops and ends for its starter to start the new version", async () => {
  const userDataDir = scratchDir("infinitary-run-command-");
  const program = join(scratchDir("infinitary-run-command-program-"), "Infinitary");
  writeFileSync(program, "this version\n");
  const ran = run(
    await runEnv(userDataDir, {
      INFINITARY_RUN_PROGRAM: program,
      INFINITARY_RUN_PROGRAM_EVERY_MS: "200",
    }),
  );
  await ran.started();
  writeFileSync(`${program}.new`, "the new version\n");
  renameSync(`${program}.new`, program);
  expect(await ran.exited, ran.error()).toBe(RUN_UPDATED_EXIT);
  expect(ran.lines()).toEqual([RUN_WORDS.started, ...RUN_WORDS.updated, RUN_WORDS.stopped]);
});

test("words after run say how to use it and exit 2", async () => {
  const ran = run(await runEnv(scratchDir("infinitary-run-command-")), ["--anything"]);
  expect(await ran.exited).toBe(2);
  expect(said(ran.error())).toEqual(RUN_WORDS.usage);
});
