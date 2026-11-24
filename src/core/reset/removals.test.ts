import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { loadOrCreateHomeIdentity } from "../devices/identity";
import {
  addResetRemoval,
  type ResetRemoval,
  readResetRemovals,
  resetRemovalsPath,
} from "./removals";

/**
 * The removal record a reset leaves beside the data folder (docs/reset.md,
 * "Computers out of reach"), with real keys made in scratch folders: what a
 * second reset keeps of the first's, that only this account can read it, and
 * that a reset that reached every computer, or a file nothing can read,
 * leaves no key behind.
 */

function dataDir(): string {
  const dir = join(scratchDir("infinitary-reset-removals-"), "Infinitary");
  mkdirSync(dir);
  return dir;
}

function reset(at: number, names: string[]): ResetRemoval {
  const home = loadOrCreateHomeIdentity(scratchDir("infinitary-reset-home-"));
  return {
    at,
    home: { key: home.key, cert: home.cert, pin: home.pin },
    computers: names.map((name) => ({
      id: `${name.toLowerCase().replace(/ /g, "-")}-id`,
      name,
      keyPin: loadOrCreateHomeIdentity(scratchDir("infinitary-reset-computer-")).pin,
      told: 0,
    })),
  };
}

describe("a reset's removal record", () => {
  it("sits beside the data folder, readable by this account alone", () => {
    const dir = dataDir();
    const first = reset(1_700_000_000_000, ["Mac Studio"]);
    addResetRemoval(dir, first);
    expect(resetRemovalsPath(dir)).toBe(`${dir}.reset-removals.json`);
    expect(statSync(resetRemovalsPath(dir)).mode & 0o777).toBe(0o600);
    expect(readResetRemovals(dir)).toEqual([first]);
  });

  it("keeps an earlier reset's computers, under that reset's own key and date", () => {
    const dir = dataDir();
    const first = reset(1_700_000_000_000, ["Mac Studio"]);
    const second = reset(1_700_100_000_000, ["Linux box", "MacBook Air"]);
    addResetRemoval(dir, first);
    addResetRemoval(dir, second);
    expect(readResetRemovals(dir)).toEqual([first, second]);
  });

  it("writes nothing for a reset that reached every computer", () => {
    const dir = dataDir();
    addResetRemoval(dir, null);
    addResetRemoval(dir, reset(1_700_000_000_000, []));
    expect(existsSync(resetRemovalsPath(dir))).toBe(false);
  });

  it("deletes a record it cannot read, with whatever key it held", () => {
    const dir = dataDir();
    writeFileSync(resetRemovalsPath(dir), '{"version":1,"resets":[{"at":"soon"}]}\n');
    expect(readResetRemovals(dir)).toEqual([]);
    expect(existsSync(resetRemovalsPath(dir))).toBe(false);
  });
});
