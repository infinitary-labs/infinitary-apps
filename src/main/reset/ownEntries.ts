import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { forgetRunAgentFiles, sessionAgentFile, userUnitsDir } from "@core/helper/runAgent";
import { runLabelOf } from "@shared/codeNames";
import type { BuildFlavor } from "@shared/userDataFolders";

/**
 * Takes away what would start a run on this folder again - the start-at-boot
 * entry and the agent a window beside it set up - and leaves the run going,
 * which a stop through them would end (`forgetRunAgentFiles`). The entries in
 * the home folder start the person's own folder of the flavor, so a run on a
 * chosen or isolated folder takes away only the agent file inside its folder.
 */
export function forgetOwnRunEntries(
  flavor: BuildFlavor,
  dataDir: string,
  ownFolder: boolean,
): void {
  if (!ownFolder) {
    rmSync(sessionAgentFile({ dataDir }), { force: true });
    return;
  }
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
 * it started, which would end a run's own reset partway; so a run takes the
 * entry's files away instead and goes on, ends with 0, which nothing starts
 * again, and the next start turns the entry off (docs/reset.md, "A first
 * mate with no window"). On Windows the task is removed through Task
 * Scheduler, after the mark that lets the next start finish the reset.
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
