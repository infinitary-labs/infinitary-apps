import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// The Linux journeys run on a fresh virtual screen with the pointer parked on
// its last pixel, and stop before any journey unless it is there
// (docs/testing.md, "The Linux source desktop"). The park itself is
// tests/park-pointer.test.ts's.

describe("scripts/on-screen.sh", () => {
  /**
   * Runs on-screen.sh with stand-ins: xvfb-run records the server's
   * arguments and runs the rest, and node records the park and answers with
   * `park` as its status.
   */
  function onScreen(park: number) {
    const dir = scratchDir("infinitary-on-screen-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "xvfb-run"),
      '#!/bin/sh\nprintf "xvfb-run %s %s %s\\n" "$1" "$2" "$3" >> "$LOG"\nshift 3\nexec "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\nprintf "node %s\\n" "$*" >> "$LOG"\nexit ${park}\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      "scripts/on-screen.sh",
      ["sh", "-c", 'printf "command %s\\n" "$*" >> "$LOG"', "command", "one", "two words"],
      {
        env: { ...hostEnv(), PATH: `${bin}:${hostEnv().PATH}`, LOG: log, SCREEN: "2560x1600x24" },
        encoding: "utf8",
      },
    );
    return { ...result, lines: readFileSync(log, "utf8").trim().split("\n") };
  }

  it("parks the pointer on the screen's last pixel, then runs the command with its arguments", () => {
    const result = onScreen(0);
    expect(result.status, result.stderr).toBe(0);
    expect(result.lines).toEqual([
      "xvfb-run -a -s -screen 0 2560x1600x24 -noreset",
      "node scripts/park-pointer.ts 2559 1599",
      "command one two words",
    ]);
  });

  it("stops before the command when the pointer is not parked", () => {
    const result = onScreen(1);
    expect(result.status).toBe(1);
    expect(result.lines).toEqual([
      "xvfb-run -a -s -screen 0 2560x1600x24 -noreset",
      "node scripts/park-pointer.ts 2559 1599",
    ]);
  });
});
