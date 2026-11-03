import { mkdirSync } from "node:fs";
import { appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";

/**
 * INF-2394 measure 4: staged card media uses the same directory as its real publisher.
 * @journey-area src/core/pi/changePresentation.ts
 * @journey-area src/core/orchestrator/cardService.ts
 */
export function seedCardMediaDirectory(userDataDir: string, taskId: string): string {
  const dir = crewmateCardPicturesDir(appPathsFor(userDataDir), taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
