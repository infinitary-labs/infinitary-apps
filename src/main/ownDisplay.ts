import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { findOnPath } from "@core/userBin";

/**
 * A display of the work mode's own on Linux (docs/helper.md, "No screen
 * needed"). Chromium draws the work mode's hidden windows - a card's demo
 * recording played before the card goes home, a task's own browser - only
 * on a display, and Electron ends the work mode when there is none to open:
 * its windowless platform runs the work but crashes at the first window. A
 * computer that runs work in the background has no display: systemd starts
 * it at login, a desktop session or none.
 *
 * So the work mode, given no display of the person's own, starts Xvfb - a
 * display in memory that nobody sees - before Chromium opens one, and draws
 * there. It holds a key of its own that only this user may read, so no other
 * user's program can look at the windows drawn there, and it goes when the
 * work mode does.
 */

/** How long Xvfb may take to say which display it took. */
const XVFB_START_MS = 10_000;

/** Where the display's key lives, inside the work folder. */
const AUTH_FILE = "display.auth";

export type OwnDisplay = { display: string; stop: () => void };

/**
 * Starts the display and points this process at it (`DISPLAY`,
 * `XAUTHORITY`); null with no Xvfb on the search path, or one that would not
 * start. Never on a system other than Linux, or in a Wayland session, where
 * Chromium chose Wayland at its start and would never open an X display.
 */
export async function startOwnDisplay(options: {
  platform: string;
  env: NodeJS.ProcessEnv;
  /** The work folder, which keeps the display's key. */
  dataDir: string;
  /** The Xvfb to run; the search path's by default. */
  xvfb?: string;
}): Promise<OwnDisplay | null> {
  const { env } = options;
  if (options.platform !== "linux" || env.WAYLAND_DISPLAY) return null;
  const xvfb = options.xvfb ?? findOnPath("Xvfb", hostEnv());
  if (!xvfb) return null;
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const auth = join(options.dataDir, AUTH_FILE);
  // A fresh key each start, only this user's to read.
  rmSync(auth, { force: true });
  writeFileSync(auth, xauthority(randomBytes(16)), { mode: 0o600, flag: "wx" });
  // Xvfb runs under a small keeper in a session of its own, which ends it
  // once this process is gone - its end of the keeper's input closes then -
  // so the display outlives every window Chromium closes on the way out, and
  // Ctrl-C in a terminal reaches the work mode alone.
  let keeper: ChildProcess;
  try {
    keeper = spawn(
      "/bin/sh",
      [
        "-c",
        '"$0" "$@" & x=$!; read -r _; kill "$x" 2>/dev/null; wait "$x"',
        xvfb,
        "-displayfd",
        "3",
        "-auth",
        auth,
        "-nolisten",
        "tcp",
        "-screen",
        "0",
        "1920x1080x24",
      ],
      { env: hostEnv(), stdio: ["pipe", "ignore", "ignore", "pipe"], detached: true },
    );
  } catch {
    return null;
  }
  const number = await new Promise<string | null>((resolve) => {
    let said = "";
    const timer = setTimeout(() => resolve(null), XVFB_START_MS);
    keeper.stdio[3]?.on("data", (chunk: Buffer) => {
      said += String(chunk);
      const line = said.split("\n")[0]?.trim();
      if (said.includes("\n") && line && /^\d+$/.test(line)) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    keeper.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    keeper.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const stop = () => keeper.stdin?.end();
  keeper.stdio[3]?.destroy();
  if (number === null) {
    stop();
    return null;
  }
  keeper.unref();
  const display = `:${number}`;
  env.DISPLAY = display;
  env.XAUTHORITY = auth;
  return { display, stop };
}

/**
 * One X authority entry that matches any display on this computer
 * (FamilyWild, no address, no display number), holding a fresh
 * MIT-MAGIC-COOKIE-1: the format Xvfb's `-auth` and every X client read.
 */
export function xauthority(cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(cookie),
  ]);
}
