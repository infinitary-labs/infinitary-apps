import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shellWord } from "../src/core/devices/joinCommand";
import { hostEnv } from "../src/core/hostEnv";
import { readProcesses } from "../src/core/placed/processResources";
import { scratchDir } from "./helpers/scratchDirs";
import { stopChildTree } from "./helpers/stopChildTree";

// The approved cleanup repair: a shell-launched work app must not leave its
// app or display keeper running. Real children reproduce the shell, app,
// detached keeper and display tree without Electron's build prerequisite.
it.each(["detached-keeper", "exited-shell"])(
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
      detached: ${mode === "detached-keeper"}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    keeper.once('message', pid => {
      process.stdout.write(JSON.stringify([process.pid, keeper.pid, pid]) + '\\n');
      keeper.disconnect(); keeper.unref();
      ${mode === "exited-shell" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
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
      if (mode === "exited-shell") await closed;
      await stopChildTree(child);
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
