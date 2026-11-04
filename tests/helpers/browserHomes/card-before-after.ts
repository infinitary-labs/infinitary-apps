import { SETTLE_FACTS_OPEN } from "@shared/cards";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { bandedPng, type SeedPicture, storeCardWithPictures } from "../browserCardPictures";
import type { HomeRead } from "../browserFreshHome";
import { completionCardBody } from "../completionCard";
import { seedDelivery } from "../taskDelivery";

const CARD_ID = "card-before-after";
const TASK_ID = "before-after";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** One changed view's picture under Before or After, with its caption. */
type View = { picture: SeedPicture; caption: string; fresh?: boolean };

/** What the card-before-after test's story reads back. */
type Words = { title: string; merge: string; before: View[]; after: View[] };

/** A view as a crewmate writes it: a figure, marked new on the figure when the view is new. */
const figure = ({ picture, caption, fresh }: View) =>
  `<figure${fresh ? " data-inf-new" : ""}><img src="${picture.path}" alt="${picture.alt}"><figcaption>${caption}</figcaption></figure>`;

/**
 * A crewmate's completion decision with two Before pictures and three After
 * pictures, one of a new view, each a file it wrote into its working copy,
 * on a finished task whose checks passed, so the host draws the settle facts
 * beside its merge button.
 */
export default async function seed(
  userDataDir: string,
  { title, merge, before, after }: Words,
): Promise<void> {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, { id: TASK_ID, title: "Read the meters at a glance", status: "completed" });
    seedDelivery(tasks, TASK_ID, { mode: "local-only", ci: "green", ciAt: Date.now() });
    await storeCardWithPictures(
      db,
      userDataDir,
      {
        id: CARD_ID,
        taskId: TASK_ID,
        author: "crewmate",
        meta: "crewmate",
        priority: 30,
        title,
        body: `${completionCardBody(
          "<p>The meter row and the transcript were hard to read at a glance.</p>",
          "<p>Both views are rearranged, and a history list is added.</p>",
          `<p>The meters wrapped and the transcript ran together.</p>${before.map(figure).join("")}`,
          `<p>The meters sit in one line and the transcript has room.</p>${after.map(figure).join("")}`,
        )}${SETTLE_FACTS_OPEN}</div>`,
        status: "ready",
        createdAt: Date.now(),
        actions: [
          { id: "merge", label: merge, default: true, effect: { kind: "settle", mode: "merge" } },
        ],
      },
      [...before, ...after].map(({ picture }, index) => ({
        path: picture.path,
        bytes: bandedPng(picture, 30 + index * 12),
      })),
    );
  } finally {
    db.close();
  }
}
