import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetTimer } from "./budgets";
import { scratchDir } from "./scratchDirs";

/** The second computer's name, which the phone's bar and computer sheet show beside the test home's. */
export const SECOND_HOME_NAME = "Test MacBook Pro";

/**
 * INF-5265's phone part (`homes` in scripts/phone-test-plan.ts): a second computer beside the test home, as a person
 * keeps one at home and one at work. It is the same disposable real home (`phoneSecondHomeProcess.ts`) in a process
 * of its own, so it has its own HOME, key, port and stand-in relay, and the phone joins it with its own link. Its
 * control answers the same commands as the test home's.
 */
export function phoneSecondHome() {
  let child: ChildProcess | undefined;
  let control: string | undefined;
  const start = async (): Promise<{ control: string; name: string }> => {
    if (control) return { control, name: SECOND_HOME_NAME };
    const output = join(scratchDir("infinitary-phone-second-"), "control.json");
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    // The second home sets its own HOME, port and relay; it inherits none of the test home's.
    const env = { ...process.env };
    for (const name of [
      "INFINITARY_CONNECTION_LOOPBACK_PORT",
      "INFINITARY_DNS_SD",
      "INFINITARY_PUSH_RELAY_URL",
    ])
      delete env[name];
    const started = spawn(
      process.execPath,
      [join(repo, "tests/helpers/phoneSecondHomeProcess.ts"), output, SECOND_HOME_NAME],
      { cwd: repo, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child = started;
    const exited = new Promise<never>((_, reject) =>
      started.once("exit", (code) =>
        reject(new Error(`The second test home exited before it was ready (${code})`)),
      ),
    );
    exited.catch(() => {});
    const ready = new Promise<string>((done, fail) => {
      const timer = budgetTimer(() => {
        clearInterval(poll);
        fail(new Error("The second test home was not ready within two minutes"));
      }, 120_000);
      const poll = setInterval(() => {
        if (!existsSync(output)) return;
        const text = readFileSync(output, "utf8");
        if (!text.endsWith("\n")) return;
        clearInterval(poll);
        timer.cancel();
        done((JSON.parse(text) as { url: string }).url);
      }, 250);
    });
    control = await Promise.race([ready, exited]);
    return { control, name: SECOND_HOME_NAME };
  };
  const stop = async () => {
    const running = child;
    child = undefined;
    control = undefined;
    if (!running || running.exitCode !== null) return;
    const gone = new Promise<void>((done) => running.once("exit", () => done()));
    running.kill("SIGTERM");
    await gone;
  };
  return { start, stop };
}
