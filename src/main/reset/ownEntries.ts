import { homedir } from "node:os";
import { forgetRunAgentFiles, userUnitsDir } from "@core/helper/runAgent";
import { runLabelOf } from "@shared/codeNames";
import type { BuildFlavor } from "@shared/userDataFolders";

/**
 * Takes away what would start a run on this folder again - the start-at-boot
 * entry and the agent a window beside it set up - and leaves the run going,
 * which a stop through them would end (`forgetRunAgentFiles`).
 */
export function forgetOwnRunEntries(flavor: BuildFlavor, dataDir: string): void {
  forgetRunAgentFiles({
    label: runLabelOf(flavor),
    dataDir,
    homeDir: homedir(),
    unitsDir: userUnitsDir(process.env, homedir()),
  });
}

/**
 * Turns this folder's start-at-boot entry off during a reset. On a Mac or
 * Linux a stop through it (launchctl bootout, systemctl stop) also ends a run
 * it started, which would end a run's own reset before its mark is written;
 * so a run takes the entry's files away instead and goes on, ends with 0,
 * which nothing starts again, and the next start turns the entry off
 * (docs/reset.md, "A first mate with no window"). Removing a Windows task
 * leaves its run going.
 */
export async function bootEntryOff(
  input: { inRun: boolean; platform: NodeJS.Platform },
  ways: { forget: () => void; off: () => Promise<void> },
): Promise<void> {
  if (input.inRun && input.platform !== "win32") {
    ways.forget();
    return;
  }
  await ways.off();
}
