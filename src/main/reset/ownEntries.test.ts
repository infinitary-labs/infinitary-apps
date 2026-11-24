import { describe, expect, it } from "vitest";
import { bootEntryOff } from "./ownEntries";

// The review of a reset asked of a first mate with no window (docs/reset.md,
// "A first mate with no window"; the captain's answer command_home=finish):
// turning its own start-at-boot entry off through the service manager ended
// the run before its reset mark was written.

async function asked(inRun: boolean, platform: NodeJS.Platform): Promise<string[]> {
  const done: string[] = [];
  await bootEntryOff(
    { inRun, platform },
    {
      forget: () => {
        done.push("forget");
      },
      off: async () => {
        done.push("off");
      },
    },
  );
  return done;
}

describe("turning a reset's own start-at-boot entry off", () => {
  it("leaves a run on a Mac or Linux going, its entry's files taken away", async () => {
    expect(await asked(true, "darwin")).toEqual(["forget"]);
    expect(await asked(true, "linux")).toEqual(["forget"]);
  });

  it("turns the entry off through the system for a run on Windows and for any window", async () => {
    expect(await asked(true, "win32")).toEqual(["off"]);
    for (const platform of ["darwin", "linux", "win32"] as const)
      expect(await asked(false, platform)).toEqual(["off"]);
  });
});
