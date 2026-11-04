import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { ChangePresentation } from "@shared/changePresentation";
import { presentationCardBody } from "../../../src/core/forge/presentation";
import { appPathsFor, crewmateCardPicturesDir } from "../../../src/core/paths";
import { stageChangePresentation } from "../../../src/core/pi/changePresentation";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

const TASK_ID = "story-layout";

/** One view of the story: its caption and the release-note pictures of each state. */
type View = { caption: string; before: string[]; after: string[]; fresh?: boolean };

/** What the story-layout test's story reads back: each card's title, and the views. */
type Words = { legacy: string; table: string; views: View[] };

/** The card drawn by each version of the story's drawing. */
const CARDS = [
  { id: "story-layout-legacy", version: 1, words: "legacy" },
  { id: "story-layout-table", version: 2, words: "table" },
] as const;

/** The cards' threads, which the window reads as each card shows. */
export const asked: HomeRead[] = CARDS.map(({ id }) => ["inf:cards:thread", [id]]);

/**
 * A saved story with two views of real release-note pictures, two per state
 * (one per theme): the core stages it as a crewmate's `prepare_change` does,
 * keeping a copy of each picture under the task, and each card shows it in
 * one version of the drawing - the legacy one, and the table INF-706 approved.
 */
export default async function seed(userDataDir: string, words: Words): Promise<void> {
  const { views } = words;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const shown = (name: string) => ({
    path: `release-notes/pictures/${name}.webp`,
    alt: name.replaceAll("-", " "),
    inspected: true as const,
    captureHead: head,
  });
  const dir = crewmateCardPicturesDir(appPathsFor(userDataDir), TASK_ID);
  mkdirSync(dir, { recursive: true });
  const staged = await stageChangePresentation(
    {
      title: words.table,
      base: head,
      head,
      publishable: true,
      why: ["The reply view should be easy to compare in both themes."],
      whatChanged: ["Each changed view keeps its two states together."],
      before: ["The earlier views sat above the results."],
      after: ["Each view shows its earlier state beside the result."],
      checked: [{ check: "Reply view", result: "Both pictures remain whole." }],
      verification: ["Compared both complete reply-view pictures in the isolated app."],
      views: views.map((view, index) => ({
        id: `view-${index + 1}`,
        kind: view.fresh ? ("new" as const) : ("changed" as const),
        caption: view.caption,
        ...(view.fresh ? { layout: "adjacent" as const } : {}),
        before: view.before.map(shown),
        after: view.after.map(shown),
      })),
      risk: {
        blast: { level: "low", why: "The merge card's views" },
        behavior: { level: "low", why: "Corrects how the views compare" },
        undo: { level: "low", why: "A revert restores the old drawing" },
        evidence: { level: "medium", why: "The layout test" },
        sensitivity: { level: "low", why: "No sign-in, data or release code" },
        novelty: { level: "low", why: "Edits the existing drawing" },
        deps: { level: "low", why: "Nothing added" },
      },
      requiredActions: [],
      unfinished: [],
      projectText: "",
    },
    { taskId: TASK_ID, worktree: process.cwd(), dir },
  );
  const db = openDatabase(userDataDir);
  try {
    for (const [index, card] of CARDS.entries()) {
      const title = words[card.words];
      const story: ChangePresentation = {
        ...staged,
        title,
        version: card.version,
        taskId: TASK_ID,
        revision: 1,
        destination: {
          host: "github.com",
          projectId: 1,
          fullName: "octo/meterlab",
          visibility: "private",
        },
      };
      new CardStore(db).upsert({
        id: card.id,
        title,
        author: "firstmate",
        meta: "firstmate",
        priority: 20 - index,
        status: "ready",
        createdAt: Date.now() - index,
        body: presentationCardBody(story),
        pictures: story.pictures,
        actions: [],
      });
    }
  } finally {
    db.close();
  }
}
