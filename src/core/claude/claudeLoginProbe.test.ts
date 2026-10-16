import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { claudeEnvFor, extractAuthUrl, resolveClaudeExecutable } from "./claudeCli";

/**
 * The phase-7 gate (plan section 08, "TTY-less Claude login"): before this
 * backend may ship, three things have to be true of Claude's own client, and
 * none of them were documented anywhere we could rely on.
 *
 * 1. A per-account config directory really isolates the credential. On macOS
 *    the credential lives in the login Keychain, not in the directory, so
 *    "one directory per account" is worth nothing unless the Keychain item
 *    is scoped too. It is: the client derives its Keychain service name from
 *    the config directory, so two directories are two items, and a fresh
 *    directory cannot see the machine's everyday sign-in.
 * 2. The login runs with no controlling terminal. Infinitary spawns from
 *    Electron's main process, where there is no PTY to hand it.
 * 3. The authorize URL is machine-readable, so the app can tell the user
 *    what is happening instead of leaving a silent process running.
 *
 * The probe costs nothing: it signs nobody in and sends no model request.
 *
 * Two guards keep it from ever reaching a person. The leg that starts a
 * sign-in is OPT-IN (INFINITARY_CLAUDE_LOGIN_PROBE=1), so an ordinary test run
 * never spawns it; and when it does run it puts a no-op opener first on PATH
 * and blanks BROWSER, so the client's browser hand-off lands in a log file
 * instead of somebody's screen. Nobody is ever asked to authorize anything.
 * Its current rules live in docs/claude-client.md.
 *
 * Legs are skipped where the client is not installed (a CI runner, or a Mac
 * without Claude Code - the app ships none since F14), because a probe that
 * cannot run must not read as a pass - but the assertions below are the
 * real thing wherever they run.
 */

const executable = resolveClaudeExecutable();
const describeWithClaude = executable ? describe : describe.skip;
/**
 * Starting a sign-in is opt-in. It opens nothing and asks nobody for
 * anything, but it does talk to Claude's authorize endpoint, so it stays off
 * by default and runs only when someone deliberately re-establishes the gate.
 */
const itWhenLoginProbeRequested =
  executable && process.env.INFINITARY_CLAUDE_LOGIN_PROBE === "1" ? it : it.skip;

/** Long enough for a cold start of a 300MB single-file client. */
const PROBE_TIMEOUT_MS = 90_000;

function freshConfigDir(): string {
  return scratchDir("infinitary-claude-probe-");
}

/**
 * The client opens the browser itself. A test suite must not, so the probe
 * puts a no-op opener first on PATH and reads what the client asked it to
 * open - which is also the strongest evidence available that the sign-in
 * really reached the browser-handoff step.
 */
function browserStub(): { dir: string; opened: () => string } {
  const dir = scratchDir("infinitary-claude-opener-");
  const log = join(dir, "opened.log");
  for (const name of ["open", "xdg-open", "sensible-browser", "www-browser"]) {
    const script = join(dir, name);
    writeFileSync(
      script,
      `#!/bin/sh
printf '%s\n' "$@" >> ${JSON.stringify(log)}
exit 0
`,
    );
    chmodSync(script, 0o755);
  }
  return {
    dir,
    opened: () => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    },
  };
}

type ProbeRun = { code: number | null; stdout: string; stderr: string };

/** Run the client with piped stdio and no PTY - the Electron-main shape. */
function runTtyLess(
  args: string[],
  configDir: string,
  options: { stopWhen?: () => boolean; timeoutMs?: number; pathPrefix?: string } = {},
): Promise<ProbeRun> {
  return new Promise<ProbeRun>((resolve, reject) => {
    const env = claudeEnvFor();
    // The probe still isolates from the machine login so it cannot spend
    // the captain's credential. Production Claude runs leave this unset.
    env.CLAUDE_CONFIG_DIR = configDir;
    if (options.pathPrefix) {
      // Every route to a real browser is closed: the stubs shadow the system
      // openers on PATH, and BROWSER names a stub outright.
      env.PATH = `${options.pathPrefix}:${env.PATH ?? ""}`;
      env.BROWSER = join(options.pathPrefix, "open");
    }
    const child = spawn(executable as string, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A login never returns on its own here: it waits for a browser that is
    // never coming. Stop it as soon as it has done everything under test.
    const poll = options.stopWhen
      ? setInterval(() => {
          if (options.stopWhen?.()) {
            clearInterval(poll);
            child.kill("SIGTERM");
          }
        }, 100)
      : undefined;
    child.on("close", () => poll && clearInterval(poll));
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
    if (options.timeoutMs !== undefined) {
      setTimeout(() => child.kill("SIGTERM"), options.timeoutMs).unref();
    }
  });
}

describeWithClaude("the TTY-less Claude login probe (phase 7 gate)", () => {
  it(
    "reports a fresh config directory as signed out, whatever the machine's own sign-in is",
    async () => {
      const configDir = freshConfigDir();
      try {
        const result = await runTtyLess(["auth", "status", "--json"], configDir);
        // The JSON is the contract, not the exit code: a signed-out status
        // read exits nonzero, which is exactly the state under test.
        const status = JSON.parse(result.stdout) as { loggedIn?: unknown };
        // The developer running this is almost certainly signed in to Claude
        // on this machine. The account store must not inherit that.
        expect(status.loggedIn).toBe(false);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS,
  );

  itWhenLoginProbeRequested(
    "starts a sign-in without a terminal and says where to send the user",
    async () => {
      const configDir = freshConfigDir();
      const stub = browserStub();
      try {
        const result = await runTtyLess(["auth", "login", "--claudeai"], configDir, {
          stopWhen: () => stub.opened().length > 0,
          timeoutMs: 60_000,
          pathPrefix: stub.dir,
        });
        const url = extractAuthUrl(result.stdout);
        expect(url, `no authorize URL in: ${result.stdout || result.stderr}`).toBeDefined();
        expect(url).toMatch(/^https:\/\//);
        // The failure this guards against is the client refusing to run
        // without a PTY, which would surface as a terminal complaint rather
        // than an authorize URL.
        expect(result.stderr).not.toMatch(/tty|terminal|raw mode/i);
        // It got as far as handing the user to a browser, and the sign-in it
        // starts completes over a loopback callback - so no terminal is
        // needed to finish it either.
        const opened = stub.opened();
        expect(opened).toMatch(/^https:\/\//m);
        expect(opened).toMatch(/redirect_uri=http%3A%2F%2Flocalhost%3A\d+/);
        // The hand-off went to the stub, so no browser was ever opened.
        expect(existsSync(join(stub.dir, "opened.log"))).toBe(true);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(stub.dir, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS,
  );
});
