import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Card } from "@shared/cards";
import { appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";
import { cardPictureRoot, verifyCardImages } from "../../src/core/pi/cardImages";
import { CardStore } from "../../src/core/storage/cardStore";
import type { AppDatabase } from "../../src/core/storage/db";
import { encodePng } from "../e2e/pictureFixtures";

/**
 * Card pictures in a seeded home, as a crewmate's card puts them there: the
 * crewmate writes real files into its working copy and names each in its
 * body, and the core verifies them, keeps its own copies under the task and
 * rewrites each `<img>` to name its copy with the size it read
 * (`verifyCardImages`). The seeds of the browser tests that read a card's
 * pictures share it (./browserHomes/).
 */

/** A picture a test's card shows: where the crewmate writes it, its words and its size. */
export type SeedPicture = { path: string; alt: string; width: number; height: number };

/** The leading band is red and the trailing band blue, so a crop shows in a picture of it. */
const BAND = 24;

/** A real PNG of `picture`'s size, banded along its longer side. */
export function bandedPng({ width, height }: SeedPicture, shade = 40): Buffer {
  const along = Math.max(width, height);
  return encodePng(width, height, (x, y) => {
    const at = width >= height ? x : y;
    if (at < BAND) return [220, 40, 40];
    if (at >= along - BAND) return [40, 60, 220];
    return [shade, shade + 20, shade + 40];
  });
}

/**
 * Writes `files` into a working copy under the home, then stores `card` with
 * its body as the core verified it: each picture copied under the task and
 * named at the shell's scheme with the size the core read.
 */
export async function storeCardWithPictures(
  db: AppDatabase,
  userDataDir: string,
  card: Card,
  files: Array<{ path: string; bytes: Buffer }>,
): Promise<void> {
  const worktree = join(userDataDir, "working-copy");
  for (const file of files) {
    const at = join(worktree, file.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.bytes);
  }
  const picturesDir = crewmateCardPicturesDir(appPathsFor(userDataDir), card.taskId ?? "");
  mkdirSync(picturesDir, { recursive: true });
  const root = cardPictureRoot({ taskId: card.taskId, cwd: worktree, picturesDir });
  const verified = await verifyCardImages(card.body, root);
  new CardStore(db).upsert({ ...card, body: verified.body, pictures: verified.pictures });
}
