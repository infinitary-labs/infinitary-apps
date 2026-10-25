import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { RUN_UPDATED_EXIT, RUN_WORDS } from "../../src/main/runCommand";
import { type RunStatus, STATUS_WORDS } from "../../src/main/runStatus";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, defaultClaudeStubDir, hermeticEnv } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";

/**
 * INF-1228 piece 2: a person asks status before, during and after a command.
 * Real built app, disposable HOME/data, mock Claude only, no credentials or
 * real Keychain. Completion is one JSON response and exit, plus a real run's
 * signal/update/forced end. Linux requires Xvfb for the run, not for status.
 * No shared listener, screen, account or service: ports belong to this test.
 */
const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }[] = [];
test.afterEach(async () => {
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

async function environment(data: string) {
  const {
    DISPLAY: _display,
    WAYLAND_DISPLAY: _wayland,
    ...env
  } = hermeticEnv({
    userDataDir: data,
    homeDir: scratchDir("status-command-home-"),
    loopbackPort: String(await claimedPort()),
  });
  return { ...env, INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(data)) };
}

function command(env: Record<string, string>, args: string[]) {
  const child = spawn(electronPath as unknown as string, [builtAppDir(), ...args], {
    env,
    cwd: scratchDir("status-command-cwd-"),
  });
  let out = "";
  let error = "";
  let ready: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // Only runs await this promise, but early status exits must not reject it unobserved.
  void started.catch(() => {});
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    if (out.split("\n").includes(RUN_WORDS.started)) ready();
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      failed(new Error(`Ended before starting: ${code}: ${error}`));
      resolve(code);
    });
  });
  children.push({ child, exited });
  return { child, exited, started, out: () => out, error: () => error };
}

const evidence: string[] = [];
async function status(env: Record<string, string>, label: string) {
  const read = command(env, ["status", "--json"]);
  expect(await read.exited, read.error()).toBe(0);
  evidence.push(`${label}\n$ infinitary status --json\n${read.out()}`);
  return JSON.parse(read.out()) as RunStatus;
}

test("status observes a live command, its clean stop and its forced stop without starting another app", async () => {
  const data = scratchDir("status-command-data-");
  const env = await environment(data);
  expect(await status(env, "Before starting")).toMatchObject({ running: false, lastStop: null });
  expect(existsSync(join(data, "firstmate.db"))).toBe(false);
  const running = command(env, ["run"]);
  await running.started;
  const before = readFileSync(join(data, "run.json"), "utf8");
  const live = await status(env, "While running");
  expect(live).toMatchObject({
    running: true,
    run: { pid: running.child.pid },
    environment: {
      voice: "unavailable",
      notifications: "unknown",
      keychain: process.platform === "darwin" ? "unknown" : "not-applicable",
    },
  });
  if (process.platform === "linux") expect(live.environment?.display).toBe("own");
  expect(readFileSync(join(data, "run.json"), "utf8")).toBe(before);
  const text = command(env, ["status"]);
  expect(await text.exited, text.error()).toBe(0);
  expect(text.out()).toContain(STATUS_WORDS.running);
  evidence.push(`$ infinitary status\n${text.out()}`);
  // A refused second run must not overwrite the live run's evidence.
  const second = command(env, ["run"]);
  expect(await second.exited).toBe(1);
  expect((await status(env, "After a refused second start")).run?.pid).toBe(running.child.pid);
  running.child.kill("SIGTERM");
  expect(await running.exited).toBe(0);
  const stopped = await status(env, "After SIGTERM");
  expect(stopped).toMatchObject({ running: false, lastStop: { exitCode: 0 } });
  // Electron can take SIGTERM through its native quit path before Node observes it.
  // Both are clean stops; never invent a signal the process did not observe.
  expect(["quit", "signal"]).toContain(stopped.lastStop?.reason);
  expect(stopped.lastStop?.stoppedAt).not.toBeNull();
  const restarted = command(env, ["run"]);
  await restarted.started;
  restarted.child.kill("SIGKILL");
  await restarted.exited;
  expect(await status(env, "After SIGKILL")).toMatchObject({
    running: false,
    lastStop: { reason: "unrecorded", stoppedAt: null, exitCode: null },
  });
  const path = process.env.INFINITARY_STATUS_EVIDENCE;
  if (path) writeFileSync(path, evidence.join("\n"));
});

test("status keeps the update reason and startup refusal, and refuses bad arguments or an unreadable record", async () => {
  const data = scratchDir("status-command-data-");
  const program = join(scratchDir("status-command-program-"), "Infinitary");
  writeFileSync(program, "old program");
  const env = {
    ...(await environment(data)),
    INFINITARY_RUN_PROGRAM: program,
    INFINITARY_RUN_PROGRAM_EVERY_MS: "200",
  };
  const running = command(env, ["run"]);
  await running.started;
  writeFileSync(`${program}.new`, "new program");
  renameSync(`${program}.new`, program);
  expect(await running.exited).toBe(RUN_UPDATED_EXIT);
  expect(await status(env, "After update")).toMatchObject({
    running: false,
    lastStop: { reason: "updated", exitCode: RUN_UPDATED_EXIT },
  });
  writeFileSync(
    join(data, "saved-data-format.json"),
    JSON.stringify({ schemaVersion: 1, revision: 999 }),
  );
  const refused = command(env, ["run"]);
  expect(await refused.exited).toBe(1);
  expect(await status(env, "After newer saved data refused startup")).toMatchObject({
    running: false,
    lastStop: { reason: "start-failed", exitCode: 1 },
  });
  const badArgs = command(env, ["status", "--anything"]);
  expect(await badArgs.exited).toBe(2);
  expect(badArgs.error()).toContain(STATUS_WORDS.usage[0]);
  writeFileSync(join(data, "run.json"), "{");
  const corrupt = command(env, ["status", "--json"]);
  expect(await corrupt.exited).toBe(1);
  expect(JSON.parse(corrupt.out())).toMatchObject({
    running: null,
    problems: [STATUS_WORDS.unreadable],
  });
  const path = process.env.INFINITARY_STATUS_EVIDENCE;
  if (path) writeFileSync(`${path}.refusals`, evidence.join("\n"));
});
