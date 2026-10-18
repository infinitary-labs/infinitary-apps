import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { BROWSER_COMMAND } from "../browser/commandWords";
import { buildCrewmateSystemPrompt } from "../pi/piResources";
import { instructionsForContract, instructionsThere } from "./placedSessions";

/**
 * The Infinitary rename (step 8 of FI3-1780's plan): a computer that runs
 * work keeps its own name for the browser command, so its crewmate is told
 * the name that computer's shell has.
 */
describe("a placed crewmate's instructions across the rename", () => {
  const base = buildCrewmateSystemPrompt("pi", undefined, undefined, undefined, true);

  it("name the browser command as the computer that runs the crewmate has it", () => {
    expect(base).toContain(`run \`${BROWSER_COMMAND}\``);
    expect(instructionsThere(base, PROTOCOL_VERSION)).toBe(base);
    const older = instructionsThere(base, "8.3.0");
    expect(older).toContain("run `fm-browser-axi`");
    expect(older).not.toContain(BROWSER_COMMAND);
    expect(older.replace("fm-browser-axi", BROWSER_COMMAND)).toBe(base);
  });

  it("retargets a stored prompt when that computer restarts onto another contract (INF-398)", () => {
    const older = instructionsThere(base, "8.3.0");
    expect(instructionsForContract(older, "8.3.0", PROTOCOL_VERSION)).toBe(base);
    expect(instructionsForContract(base, PROTOCOL_VERSION, "8.3.0")).toBe(older);
    expect(instructionsForContract(base, PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(base);
  });
});
