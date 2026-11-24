import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { clearStartAttempts, earlierStartAttempts, noteStartAttempt } from "./startAttempts";

/**
 * Infinitary could not start (docs/reset.md): starts that never got through
 * are counted beside the folder, never in it, so a folder Infinitary refuses
 * to open is never written.
 */
describe("counting starts that did not get through", () => {
  it("counts each start beside the folder and forgets them once one gets through", () => {
    const dataDir = join(scratchDir("inf-start-attempts-"), "Infinitary");
    mkdirSync(dataDir);
    expect(earlierStartAttempts(dataDir)).toBe(0);
    noteStartAttempt(dataDir, earlierStartAttempts(dataDir));
    noteStartAttempt(dataDir, earlierStartAttempts(dataDir));
    expect(earlierStartAttempts(dataDir)).toBe(2);
    expect(readdirSync(dataDir)).toEqual([]);
    clearStartAttempts(dataDir);
    expect(earlierStartAttempts(dataDir)).toBe(0);
    expect(existsSync(`${dataDir}.start-attempts`)).toBe(false);
  });
});
