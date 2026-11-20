import { SETTLE_FACTS_OPEN } from "@shared/cards";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import {
  ANNOTATION_BODY,
  ANNOTATION_DRAWING,
  ANNOTATION_TITLE,
} from "../../fixtures/cardAnnotations";
import type { HomeRead } from "../browserFreshHome";

const ID = "card-annotation-review";
export const asked: HomeRead[] = [["inf:cards:thread", [ID]]];

/** Review f3/f4/f5: the same real card fixture used by the approved annotation journey. */
export default async function seed(
  userDataDir: string,
  input?: { repeatedMerge?: boolean; drawing?: boolean },
): Promise<void> {
  const db = openDatabase(userDataDir);
  try {
    if (input?.repeatedMerge) {
      const tasks = new TaskService({ db, strict: true });
      seedTask(tasks, {
        id: ID,
        title: ANNOTATION_TITLE,
        status: "queued",
        startPolicy: "on-request",
      });
    }
    new CardStore(db).upsert({
      id: ID,
      author: "firstmate",
      meta: "firstmate",
      title: ANNOTATION_TITLE,
      ...(input?.repeatedMerge ? { taskId: ID } : {}),
      body:
        (input?.repeatedMerge
          ? `${ANNOTATION_BODY}${SETTLE_FACTS_OPEN}</div>${ANNOTATION_BODY}`
          : ANNOTATION_BODY) + (input?.drawing ? ANNOTATION_DRAWING : ""),
      actions: input?.repeatedMerge
        ? [
            {
              id: "merge",
              label: "Merge",
              default: true,
              effect: { kind: "merge", after: "close" },
            },
          ]
        : [],
      priority: 30,
      status: "ready",
      createdAt: Date.now(),
    });
  } finally {
    db.close();
  }
}
