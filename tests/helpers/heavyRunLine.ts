import { spawn } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeAll, vi } from "vitest";
import { HEAVY_RUN_NEEDS, type HeavyRunKind } from "../../scripts/heavy-run-place";
import { AxiChannel } from "../../src/core/axi/channel";
import { hostEnv } from "../../src/core/hostEnv";
import { LoadLine, loadGroupExists } from "../../src/core/placed/loadLine";
import { forkChildProcess } from "../../src/core/sql/forkChildProcess";
import { bundleAxiProcess } from "./axiProcessBundle";
import { withoutLoadLine } from "./noLoadLine";
import { scratchDir } from "./scratchDirs";

/**
 * The fixture of a local heavy run's place in its computer's load line
 * (scripts/heavy-run-place.ts): the real task channel and command processes
 * over a disposable line. `tests/heavy-run-place.test.ts` drives the runs
 * Linux can, and `tests/heavy-run-place-phone.test.ts` the phone gate, which
 * only a Mac runs (scripts/mac-unit-tests.ts).
 */

export const repoRoot = resolve(__dirname, "../..");
/** The task commands the app puts first on a task shell's PATH. */
export const axiBin = join(repoRoot, "resources", "axi-bin");

/** What a kind's declaration holds in the line. */
export const declared = (kind: HeavyRunKind) => ({
  cpu: HEAVY_RUN_NEEDS[kind].processors,
  memoryBytes: HEAVY_RUN_NEEDS[kind].memoryMib * 1024 ** 2,
});

/**
 * Opens a computer's line and its task channel, as the app opens them. Call
 * it at a test file's top level: it builds the command process once for the
 * file, and closes each test's lines and channels after that test.
 */
export function computerLines() {
  let entry: string;
  const closing: (() => void)[] = [];
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);
  afterEach(() => {
    for (const close of closing.splice(0)) close();
  });
  return async function computerLine() {
    const dir = scratchDir("infinitary-heavy-run-");
    const groupExists = vi.fn(loadGroupExists);
    const line = new LoadLine({ stateFile: join(dir, "load.json"), groupExists });
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: axiBin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    closing.push(
      () => channel.close(),
      () => line.dispose(),
    );
    /** A local task shell: the task's commands first on its PATH, out of CI. */
    const shell = (task: string, load = true): NodeJS.ProcessEnv => {
      const granted = channel.grant(task, load ? { load: line.forTask(task) } : {});
      const env = withoutLoadLine(hostEnv(granted.env));
      env.PATH = [...granted.path, env.PATH].join(delimiter);
      delete env.CI;
      return env;
    };
    const runs = () =>
      line.snapshot().runs.map(({ taskId, state, demand }) => ({ taskId, state, demand }));
    return { line, shell, runs, groupExists };
  };
}

/** A process started from the repository root, its output and error output kept together. */
export function start(command: string, args: string[], env: NodeJS.ProcessEnv, detached = false) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });
  const exited = new Promise<number | null>((done) => child.once("close", done));
  return { child, output: () => output, exited };
}
