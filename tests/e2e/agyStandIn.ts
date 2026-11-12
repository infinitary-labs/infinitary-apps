/**
 * INF-2394: fixture ownership follows the product reader. A stand-in `agy`
 * where the program installs itself (`agyExecutable.ts` looks in the home's
 * `~/.local/bin` first), playing `tests/helpers/agyCommandStandIn.ts`.
 * @journey-area src/core/antigravity/
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgyCommandScenario } from "../helpers/agyCommandStandIn";
import { scratchDir } from "../helpers/scratchDirs";

/** A stand-in `agy` where the program installs itself, and the log of what it was asked. */
export function standInAgy(scenario: AgyCommandScenario) {
  const dir = scratchDir("infinitary-agy-stand-in-");
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "agy-log.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(logPath, "");
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args?: string[]; code?: string });
  return { scenarioPath, logPath, log };
}

/** The home fixture that puts the stand-in where the program installs itself. */
export function agyHome(agy: { scenarioPath: string; logPath: string }) {
  const standIn = join(import.meta.dirname, "../helpers/agyCommandStandIn.ts");
  return (homeDir: string) => {
    const bin = join(homeDir, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const agyPath = join(bin, "agy");
    writeFileSync(
      agyPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} ${JSON.stringify(agy.scenarioPath)} ${JSON.stringify(agy.logPath)} "$@"\n`,
    );
    chmodSync(agyPath, 0o755);
  };
}
