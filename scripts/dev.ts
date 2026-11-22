#!/usr/bin/env node
/**
 * `pnpm dev`: runs the app from this copy through its starter
 * (`scripts/dev-starter.ts`; docs/alpha.md, "Updates from source"), which
 * stays as electron-vite's parent so the app's Update and restart can move
 * the copy forward and start it again. Words after `pnpm dev` go to
 * electron-vite, as they did when `pnpm dev` ran it directly.
 *
 * The programs it starts take this terminal's own environment, as
 * electron-vite did when `pnpm dev` started it: a person starts this from a
 * shell, so there is no login environment to read in its place.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEV_STARTER_VARIABLE } from "../src/core/update/devStarter.ts";
import { runDevStarter } from "./dev-starter.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const session = mkdtempSync(join(tmpdir(), "infinitary-dev-"));
const extra = process.argv.slice(2);

/**
 * pnpm itself, as the running pnpm named it: its script through Node, or a
 * standalone pnpm directly. Without that name, the pnpm on the search path,
 * through the shell on Windows, where it is a .cmd file.
 */
const execPath = process.env.npm_execpath;
const pnpm: [string, string[]] = !execPath
  ? ["pnpm", []]
  : /\.[cm]?js$/.test(execPath)
    ? [process.execPath, [execPath]]
    : [execPath, []];
const viaShell = !execPath && process.platform === "win32";

let stopping = false;
let child: ReturnType<typeof spawn> | undefined;

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((done) => {
    const started = spawn(file, args, { cwd: root, env, stdio: "inherit", shell: viaShell && file === "pnpm" });
    child = started;
    started.once("error", (error) => {
      console.error(String(error));
      done(1);
    });
    started.once("exit", (code, signal) => {
      if (child === started) child = undefined;
      done(code ?? (signal ? 1 : 0));
    });
  });
}

// Ctrl-C reaches every program in the terminal's group, the app included, so
// the starter only stops starting it again; a stop sent to the starter
// alone is passed on to what it runs.
process.on("SIGINT", () => {
  stopping = true;
});
for (const signal of ["SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });

let code = 1;
try {
  code = await runDevStarter({
    root,
    session,
    git: async (args) =>
      (
        await promisify(execFile)("git", ["-C", root, ...args], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout,
    install: () => run(pnpm[0], [...pnpm[1], "install", "--frozen-lockfile"]),
    prepare: () => run(pnpm[0], [...pnpm[1], "run", "predev"]),
    start: (updates) =>
      run(
        process.execPath,
        [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "dev", ...extra],
        updates ? { ...process.env, [DEV_STARTER_VARIABLE]: session } : process.env,
      ),
    say: (line) => console.log(`[pnpm dev] ${line}`),
    stopping: () => stopping,
  });
} finally {
  rmSync(session, { recursive: true, force: true });
}
process.exit(code);
