import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostEnv } from "../../../src/core/hostEnv";
import { socketScratchDir } from "../../helpers/scratchDirs";

/** A real daemon holding test scratch, deliberately leaked for the approved run guard regression. */
export async function leaveProgram(home: string): Promise<void> {
  const mode = process.env.INFINITARY_FIXTURE_PROGRAM;
  if (!mode) return;
  const pidFile = process.env.INFINITARY_FIXTURE_PID;
  if (!pidFile) throw new Error("A program fixture needs its pid file");
  const folder =
    mode === "socket"
      ? socketScratchDir("infinitary-fixture-socket-")
      : mode === "browser"
        ? mkdtempSync(join(tmpdir(), "playwright_chromiumdev_profile-"))
        : home;
  for (let i = 0; i < (mode === "multiple" ? 2 : 1); i++) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      ${mode === "cwd" || mode === "socket" ? "" : "fs.openSync('held-file', 'w');"}
      ${mode === "file" ? "process.chdir('/');" : ""}
      ${mode === "kill" ? "process.on('SIGTERM', () => {});" : ""}
      process.send(process.pid);
      setInterval(() => {}, 1000);
    `,
      ],
      {
        cwd: folder,
        env: hostEnv(),
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", (pid) => {
        appendFileSync(pidFile, `${pid}\n`);
        child.disconnect();
        child.unref();
        resolve();
      });
    });
  }
}
