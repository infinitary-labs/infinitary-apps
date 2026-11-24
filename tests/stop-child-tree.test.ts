import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shellWord } from "../src/core/devices/joinCommand";
import { hostEnv } from "../src/core/hostEnv";
import { type ProcessReading, readProcesses } from "../src/core/placed/processResources";
import { scratchDir } from "./helpers/scratchDirs";
import { stopChildTree } from "./helpers/stopChildTree";

// The approved cleanup repair: a shell-launched work app must not leave its
// app or display keeper running. Real children reproduce the shell, app,
// detached keeper and display tree without Electron's build prerequisite.
// The adopted keeper is the work app's update watcher, left by a run that
// ended on its own (INF-6534): only the folder the child started in owns it.
it.each(["detached-keeper", "exited-shell", "adopted-keeper"])(
  "ends a %s tree, not just the direct child",
  async (mode) => {
    const folder = scratchDir("infinitary-child-tree-");
    const keeper = join(folder, "keeper.cjs");
    writeFileSync(
      keeper,
      `
    const {spawn} = require('node:child_process');
    const display = spawn('sleep', ['300'], {stdio: 'ignore'});
    process.send(display.pid);
    setInterval(() => {}, 1000);
  `,
    );
    const app = join(folder, "app.cjs");
    writeFileSync(
      app,
      `
    const {spawn} = require('node:child_process');
    const keeper = spawn(process.execPath, [${JSON.stringify(keeper)}], {
      detached: ${mode !== "exited-shell"}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    keeper.once('message', pid => {
      process.stdout.write(JSON.stringify([process.pid, keeper.pid, pid]) + '\\n');
      keeper.disconnect(); keeper.unref();
      ${mode === "detached-keeper" ? "setInterval(() => {}, 1000);" : "process.exit(0);"}
    });
  `,
    );
    const child = spawn(
      "/bin/sh",
      ["-c", `${shellWord(process.execPath)} ${shellWord(app)} & wait`],
      {
        cwd: folder,
        env: hostEnv(),
        detached: true,
      },
    );
    const closed = once(child, "close");
    let pids: number[] = [];
    try {
      pids = await new Promise<number[]>((resolve, reject) => {
        let said = "";
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
          said += String(chunk);
          if (said.includes("\n")) resolve(JSON.parse(said.trim()) as number[]);
        });
      });
      if (mode !== "detached-keeper") await closed;
      await stopChildTree(child, mode === "adopted-keeper" ? { folder } : {});
      await closed;
      const rows = await readProcesses();
      expect(rows).not.toBeNull();
      expect(rows?.filter((row) => pids.includes(row.pid) && !row.exited)).toEqual([]);
    } finally {
      for (const pid of [...pids, -(child.pid ?? 0)]) {
        if (pid === 0) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already ended. */
        }
      }
      await closed;
    }
  },
  30_000,
);

// The repaired cleanup flake: on a loaded Linux runner a killed work app,
// waiting on a disk flush its quit had started, stayed listed past the kill
// window endHolder allows, and cleanup failed on a child that was still
// finishing its end. The app here keeps running after the end request, as
// the work app does while it quits, and the reading keeps listing it, as it
// last read, for its next 30 readings after its kill: more than the
// two-second window holds at its 100 ms poll.
it("waits for a killed child the system still lists after the kill window", async () => {
  const folder = scratchDir("infinitary-child-tree-");
  const app = join(folder, "app.cjs");
  writeFileSync(
    app,
    `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `,
  );
  const child = spawn(process.execPath, [app], { cwd: folder, env: hostEnv(), detached: true });
  const closed = once(child, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    let listed: ProcessReading | undefined;
    let held = 0;
    let released = false;
    const processes = async () => {
      const rows = await readProcesses();
      if (!rows) return rows;
      const row = rows.find((candidate) => candidate.pid === child.pid);
      if (row && !row.exited) {
        listed = row;
        return rows;
      }
      if (listed && held < 30) {
        held += 1;
        return [...rows.filter((candidate) => candidate.pid !== child.pid), listed];
      }
      released = true;
      return rows;
    };
    await stopChildTree(child, { processes });
    expect(released).toBe(true);
    const rows = await readProcesses();
    expect(rows).not.toBeNull();
    expect(rows?.filter((row) => row.pid === child.pid && !row.exited)).toEqual([]);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already ended. */
    }
    await closed;
  }
}, 30_000);

// The update watcher starts a sleep each second, so one started after the
// stop's first reading outlived a single pass (INF-6534). A real tree's
// second sleep stands in for it: the first reading leaves it out, as one
// that had not started yet.
it("ends a program of the tree that only a later reading lists", async () => {
  const folder = scratchDir("infinitary-child-tree-");
  const sleep = "/bin/sleep 300 >/dev/null 2>&1 &";
  const child = spawn("/bin/sh", ["-c", `${sleep} echo $!; ${sleep} wait`], {
    cwd: folder,
    env: hostEnv(),
    detached: true,
  });
  const closed = once(child, "close");
  let late = 0;
  try {
    late = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    });
    let readings = 0;
    const processes = async () => {
      const rows = await readProcesses();
      readings += 1;
      return readings === 1 ? (rows?.filter((row) => row.pid !== late) ?? null) : rows;
    };
    await stopChildTree(child, { processes });
    await closed;
    const rows = await readProcesses();
    expect(rows).not.toBeNull();
    expect(rows?.filter((row) => row.pid === late && !row.exited)).toEqual([]);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already ended. */
    }
    await closed;
  }
}, 30_000);
