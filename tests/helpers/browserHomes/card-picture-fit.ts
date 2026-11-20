import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { bandedPng, type SeedPicture, storeCardWithPictures } from "../browserCardPictures";
import type { HomeRead } from "../browserFreshHome";

const CARD_ID = "card-picture-fit";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** What the card-picture-fit test's story reads back. */
type Words = { title: string; picture: SeedPicture };

/** A crewmate's card naming one very wide picture it wrote into its working copy. */
export default async function seed(userDataDir: string, { title, picture }: Words): Promise<void> {
  const db = openDatabase(userDataDir);
  try {
    const task = seedTask(new TaskService({ db, strict: true }), {
      id: "picture-fit",
      title: "Show the whole meter row",
      status: "queued",
      startPolicy: "on-request",
    });
    await storeCardWithPictures(
      db,
      userDataDir,
      {
        id: CARD_ID,
        taskId: task.id,
        author: "crewmate",
        meta: "crewmate",
        priority: 15,
        title,
        body: `<p>The meter row, end to end.</p><img src="${picture.path}" alt="${picture.alt}">`,
        status: "ready",
        createdAt: Date.now(),
        actions: [],
      },
      [{ path: picture.path, bytes: bandedPng(picture) }],
    );
  } finally {
    db.close();
  }
}
