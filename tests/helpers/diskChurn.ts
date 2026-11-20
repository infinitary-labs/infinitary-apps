import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { scratchDir } from "./scratchDirs";

/**
 * What the churning process runs: it makes a folder of small files and
 * removes it again, over and over, in its own scratch folder, and says
 * `churning` once its first folder is gone.
 */
const CHURN = `
const { mkdirSync, rmSync, writeFileSync, writeSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
for (let round = 0; ; round += 1) {
  const folder = join(root, String(round % 50));
  mkdirSync(folder, { recursive: true });
  for (let file = 0; file < 200; file += 1) writeFileSync(join(folder, "f" + file), "x");
  rmSync(folder, { recursive: true, force: true });
  if (round === 0) writeSync(1, "churning\\n");
}
`;

/**
 * Other work churning the disk beside a test, as other unit rounds do on the
 * same computer (INF-2578): one child making and removing small files as fast
 * as it can, which on macOS was enough to keep a folder's watch from seeing a
 * new file within 15 s, every time. Resolves once it has churned a whole
 * folder; `stop` ends it and resolves once it has exited, so nothing writes
 * into a scratch folder after its test.
 */
export async function churnDisk(): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", CHURN, scratchDir("infinitary-disk-churn-")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  };
  const churning = new Promise<void>((resolve) =>
    createInterface({ input: child.stdout }).once("line", () => resolve()),
  );
  const first = await Promise.race([churning.then(() => "churning" as const), exited]);
  if (first !== "churning") throw new Error(`The churning process exited (${first}).`);
  return { stop };
}
