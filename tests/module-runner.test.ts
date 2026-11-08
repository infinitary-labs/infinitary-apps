import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hostEnv } from "@core/hostEnv";
import { describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../scripts/moduleRunner.ts";
import { scratchDir } from "./helpers/scratchDirs";

// Two real CLI launches: fastest measured case ~3 s, fivefold rounded
// budget 15 s (docs/test-cohorts.md). Each child ends with that limit, through
// the test's signal, so a runner that leaks a handle and never exits still
// fails and is killed. The limit counts only the time the run got to run
// ("Budgets" there); a wall-clock deadline of the child's own killed healthy
// children on a loaded Linux check machine.
vi.setConfig({ testTimeout: 15_000 });
const run = promisify(execFile);

function offlineEnv(home: string): NodeJS.ProcessEnv {
  return hostEnv({
    HOME: home,
    CFFIXED_USER_HOME: home,
    PI_OFFLINE: "1",
    INFINITARY_LOCAL_CODESIGN_DIR: join(home, "codesign"),
  });
}

/** Occupy Vite's default WebSocket port, or leave its existing owner alone. */
async function occupyWebSocketPort(): Promise<() => Promise<void>> {
  const blocker = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(24678, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return async () => {};
  }
  return () => new Promise<void>((resolve) => blocker.close(() => resolve()));
}

describe("offline core module loading", () => {
  it("imports aliases and lazy core dependencies in concurrent runners without any listener", async ({
    signal,
  }) => {
    const home = scratchDir("infinitary-module-runner-");
    const fixture = join(home, "lazy-core.ts");
    writeFileSync(
      fixture,
      `import { CLAUDE_PROVIDER_ID } from "@shared/providers";
export const provider: string = CLAUDE_PROVIDER_ID;
export async function taskCount(userData: string): Promise<number> {
  const { openDatabase } = await import("@core/storage/db");
  const db = openDatabase(userData);
  try {
    return (db.prepare("SELECT count(*) AS count FROM tasks").get() as { count: number }).count;
  } finally {
    db.close();
  }
}
`,
    );
    // Observe the socket boundary in a plain Node process, not a mocked Vite
    // config. Refuse ALL listeners so changing ports cannot mask the defect.
    const probe = `
import assert from "node:assert/strict";
import { Server } from "node:net";
Server.prototype.listen = function () { throw new Error("offline runner tried to listen"); };
const { openModuleRunner } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "scripts/moduleRunner.ts")).href)});
const runners = await Promise.all([openModuleRunner(), openModuleRunner()]);
try {
  for (const [index, runner] of runners.entries()) {
    const module = await runner.import(${JSON.stringify(fixture)});
    assert.equal(module.provider, "anthropic-claude");
    assert.equal(await module.taskCount(${JSON.stringify(home)} + "/data-" + index), 0);
    await assert.rejects(runner.import(${JSON.stringify(join(home, "missing.ts"))}));
  }
} finally {
  await Promise.all(runners.map(runner => runner.close()));
}
for (const runner of runners) {
  await assert.rejects(runner.import(${JSON.stringify(fixture)}));
}
console.log(JSON.stringify({ runners: runners.length, tasks: 0, listeners: 0, closed: true }));
`;
    const result = await run(process.execPath, ["--input-type=module", "--eval", probe], {
      env: offlineEnv(home),
      signal,
    });
    expect(JSON.parse(result.stdout)).toEqual({ runners: 2, tasks: 0, listeners: 0, closed: true });
    expect(result.stderr).toBe("");
  });

  it("exports and imports task records through the real command while the shared port is occupied", async ({
    signal,
  }) => {
    const home = scratchDir("infinitary-module-command-");
    const releasePort = await occupyWebSocketPort();
    const script = join(REPO_ROOT, "scripts/export-tasks.ts");
    const out = join(home, "tasks.jsonl");
    try {
      const exported = await run(
        process.execPath,
        [script, "--user-data", join(home, "source"), "--out", out],
        { env: offlineEnv(home), signal },
      );
      expect(exported.stdout).toMatch(/^wrote \d+ lines to /);
      expect(exported.stderr).toBe("");
      const lines = readFileSync(out, "utf8").trim().split("\n");
      expect(JSON.parse(lines[0] as string)).toMatchObject({ format: "infinitary-tasks/1" });
      const imported = await run(
        process.execPath,
        [script, "--user-data", join(home, "target"), "--import", out],
        { env: offlineEnv(home), signal },
      );
      expect(imported.stdout).toMatch(/^imported 0 tasks/);
      expect(imported.stderr).toBe("");
    } finally {
      await releasePort();
    }
  });
});
