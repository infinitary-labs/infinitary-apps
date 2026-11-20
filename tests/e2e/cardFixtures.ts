import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";
import { verifyCardImages } from "../../src/core/pi/cardImages";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * INF-2394 measure 4: staged card media uses the same directory as its real publisher.
 * @journey-area src/core/pi/changePresentation.ts
 * @journey-area src/core/pi/cardImages.ts
 * @journey-area src/core/orchestrator/cardService.ts
 * @journey-area src/core/orchestrator/cardEmit.ts
 * @journey-area src/core/orchestrator/cardEvidence.ts
 */
export function seedCardMediaDirectory(userDataDir: string, taskId: string): string {
  const dir = crewmateCardPicturesDir(appPathsFor(userDataDir), taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A crewmate's card body naming its data file at `file` (docs/card-authoring.md,
 * "Data by reference"), kept as the host keeps it when the card goes up: the
 * host's own check copies `data` into the task's card folder and gives back the
 * body naming the kept copy's address.
 */
export async function keepCardData(
  userDataDir: string,
  taskId: string,
  body: string,
  file: string,
  data: string,
): Promise<string> {
  const worktree = scratchDir("infinitary-card-data-");
  writeFileSync(join(worktree, file), data);
  const dir = seedCardMediaDirectory(userDataDir, taskId);
  return (await verifyCardImages(body, { worktree, dir, taskId })).body;
}
