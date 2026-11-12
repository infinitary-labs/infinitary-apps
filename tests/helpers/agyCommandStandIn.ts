/**
 * A scripted stand-in for the Antigravity program's two one-off commands the
 * app runs (INF-3776's approved plan: "test against a scripted stand-in",
 * never a real Google sign-in): its own sign-in (`agy acp --login`) and its
 * print-mode usage report (`agy -p /usage --output-format json`). It plays
 * one scenario - what it prints, whether it waits for a pasted code on its
 * stdin, whether it hangs, and how it exits - and logs what it was started
 * with, one JSON line: its arguments, the environment switches it was given
 * and any code it read.
 *
 *   node tests/helpers/agyCommandStandIn.ts <scenario.json> <log.jsonl> <agy arguments...>
 *
 * A computer's `agy` can be a two-line shell script that runs it, so the
 * app finds it where the program installs itself (`agyHome` in `tests/e2e/agyStandIn.ts`).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** What one command does. */
export type AgyCommandPlay = {
  /** What it prints on stdout, as it runs. */
  stdout?: string;
  /** What it prints on stderr. */
  stderr?: string;
  /** Waits for one line on stdin (a pasted code) before it exits. */
  readCode?: boolean;
  /** Never exits on its own; only a stop ends it. */
  hang?: boolean;
  exit?: number;
};

/** The sign-in (`acp --login`) and the print-mode report (`-p ...`), each its own play. */
export type AgyCommandScenario = { login?: AgyCommandPlay; print?: AgyCommandPlay };

const [scenarioPath, logPath, ...args] = process.argv.slice(2);
if (!scenarioPath || !logPath) throw new Error("usage: agyCommandStandIn <scenario> <log> ...");
const scenarios = JSON.parse(readFileSync(scenarioPath, "utf8")) as AgyCommandScenario;
const scenario: AgyCommandPlay = (args[0] === "acp" && args.includes("--login")
  ? scenarios.login
  : undefined) ??
  (args[0] === "-p" || args[0] === "--print" ? scenarios.print : undefined) ?? {
    stderr: `unknown command: ${args.join(" ")}\n`,
    exit: 2,
  };

const log = (entry: Record<string, unknown>) =>
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

// The stop is heard before the first line is logged, so that line is the
// signal a test waits for before it stops the program.
process.on("SIGTERM", () => {
  log({ stopped: true });
  process.exit(143);
});
log({
  args,
  env: {
    AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
    AGY_CLI_HIDE_ACCOUNT_INFO: process.env.AGY_CLI_HIDE_ACCOUNT_INFO ?? null,
  },
});

if (scenario.stdout) process.stdout.write(scenario.stdout);
if (scenario.stderr) process.stderr.write(scenario.stderr);

if (scenario.readCode) {
  const lines = createInterface({ input: process.stdin });
  lines.once("line", (code) => {
    log({ code });
    lines.close();
    process.exit(scenario.exit ?? 0);
  });
} else if (scenario.hang) {
  setInterval(() => {}, 60_000);
} else {
  process.exit(scenario.exit ?? 0);
}
