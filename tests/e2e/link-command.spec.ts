import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { claimLink } from "@core/devices/dial";
import { expect, test } from "@playwright/test";
import { PAIRING_LINK_TTL_MS, parsePairingLink } from "@shared/devices";
import { phoneCodeModules } from "@shared/phoneCode";
import electronPath from "electron";
import { LINK_WORDS, linkOutput, terminalCode } from "../../src/main/linkCommand";
import { RUN_WORDS } from "../../src/main/runCommand";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, defaultClaudeStubDir, hermeticEnv } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";

/**
 * INF-1228's approved plan, piece 3: "`infinitary link` prints a link for
 * another computer or a code for a phone", from the Infinitary a command
 * started in this account. Promised result: a link another computer's
 * Infinitary joins with, a code and link a phone joins with, one JSON object
 * for a script, and plain words with no running app. Data: the real built
 * app in a disposable HOME and data folder, a mock Claude client, the
 * pairing listener on a loopback port of this test's own; no credentials or
 * real Keychain. Completion: each command's exit and output, and the
 * pairing listener's grant. Linux needs Xvfb for the run, not for link. No
 * shared listener, screen, account or service.
 */
const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }[] = [];
test.afterEach(async () => {
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

/** Another app at its first launch, as in devices-links.spec.ts: it says its window and its user. */
const AT_FIRST_LAUNCH = {
  kind: "mac",
  window: true,
  user: { name: userInfo().username, uid: process.getuid?.() ?? userInfo().uid },
} as const;

async function environment(data: string) {
  const {
    DISPLAY: _display,
    WAYLAND_DISPLAY: _wayland,
    ...env
  } = hermeticEnv({
    userDataDir: data,
    homeDir: scratchDir("link-command-home-"),
    loopbackPort: String(await claimedPort()),
  });
  return { ...env, INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(data)) };
}

function command(env: Record<string, string>, args: string[]) {
  const child = spawn(electronPath as unknown as string, [builtAppDir(), ...args], {
    env,
    cwd: scratchDir("link-command-cwd-"),
  });
  let out = "";
  let error = "";
  let ready: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // Only the run awaits this promise; a link's exit must not reject it unobserved.
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
async function link(env: Record<string, string>, args: string[], code: number) {
  const asked = command(env, ["link", ...args]);
  expect(await asked.exited, asked.error()).toBe(code);
  evidence.push(`$ infinitary ${["link", ...args].join(" ")}\n${asked.out()}${asked.error()}`);
  return { out: asked.out(), error: asked.error() };
}

/** The link a successful `link` printed: its one line that is a pairing link. */
function printedLink(out: string): string {
  const found = out.split("\n").filter((line) => {
    try {
      parsePairingLink(line);
      return true;
    } catch {
      return false;
    }
  });
  expect(found).toHaveLength(1);
  return found[0] as string;
}

test("link prints a computer's link and a phone's code from a running command, each joining once", async () => {
  const data = scratchDir("link-command-data-");
  const env = await environment(data);
  const notRunning = linkOutput({ for: "computer", json: false }, { kind: "not-running" }, 0);

  // With nothing running it says so, starts nothing and makes no data.
  expect((await link(env, [], 1)).error).toBe(notRunning.error);
  expect(existsSync(join(data, "firstmate.db"))).toBe(false);
  expect((await link(env, ["--qr"], 2)).error).toBe(`${LINK_WORDS.usage.join("\n")}\n`);

  const running = command(env, ["run"]);
  await running.started;

  // Another computer's Infinitary joins with the printed link, once.
  const computer = await link(env, [], 0);
  const forComputer = printedLink(computer.out);
  expect(computer.out).toContain(LINK_WORDS.lasts(PAIRING_LINK_TTL_MS));
  const air = await claimLink(forComputer, { ...AT_FIRST_LAUNCH, name: "MacBook Air" });
  expect(air.kind).toBe("view");
  await expect(claimLink(forComputer, { ...AT_FIRST_LAUNCH, name: "Again" })).rejects.toThrow();

  // A phone scans the printed code, which holds the printed link, and joins.
  const phone = await link(env, ["--phone"], 0);
  const forPhone = printedLink(phone.out);
  for (const line of terminalCode(phoneCodeModules(forPhone))) expect(phone.out).toContain(line);
  const iphone = await claimLink(forPhone, { kind: "mac", name: "Test iPhone", system: "ios" });
  expect(iphone.kind).toBe("view");

  // A script reads one object, whose link is a new one.
  const json = JSON.parse((await link(env, ["--json"], 0)).out) as Record<string, unknown>;
  expect(json).toMatchObject({ schemaVersion: 1, for: "computer" });
  const forScript = String(json.link);
  expect(parsePairingLink(forScript).code).not.toBe(parsePairingLink(forComputer).code);
  expect(Date.parse(String(json.expiresAt))).toBeGreaterThan(Date.now());

  // Once the run stops, nothing answers and the command says so.
  running.child.kill("SIGTERM");
  expect(await running.exited).toBe(0);
  expect((await link(env, [], 1)).error).toBe(notRunning.error);
  const path = process.env.INFINITARY_LINK_EVIDENCE;
  if (path) writeFileSync(path, evidence.join("\n"));
});
