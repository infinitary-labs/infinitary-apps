import { SETTLE_FACTS_OPEN } from "@shared/cards";
import type { RiskAssessment } from "@shared/risk";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { encodePng } from "../../e2e/pictureFixtures";
import type { HomeRead } from "../browserFreshHome";
import { completionCardBody } from "../completionCard";
import { seedDelivery } from "../taskDelivery";

const CARD_ID = "card-wide-cards";
const TASK_ID = "task-wide-cards";

/** The card's thread, which the window reads when the card shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [CARD_ID]]];

/** What the risk-chart test's story reads back. */
type Words = { title: string; risk: RiskAssessment; before: string; after: string };

/** A screenshot-sized view as a data picture, so the body needs no file. */
function view(shade: number, alt: string): string {
  const png = encodePng(1200, 360, () => [shade, shade, shade + 8]);
  return `<img src="data:image/png;base64,${png.toString("base64")}" alt="${alt}">`;
}

/**
 * A merge card as the host stores it, its crewmate's risk already declared,
 * on a finished task whose checks passed: the declaration's own refusals and
 * persistence are the card tool's and the supervisor's tests.
 */
export default function seed(userDataDir: string, { title, risk, before, after }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, { id: TASK_ID, title: "Open cards wide", status: "completed" });
    seedDelivery(tasks, TASK_ID, { mode: "local-only", ci: "green", ciAt: Date.now(), risk });
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: TASK_ID,
      author: "crewmate",
      meta: "crewmate",
      priority: 30,
      title,
      body: `${completionCardBody(
        "<p>You asked for cards to open wider.</p>",
        "<p>Every card opens at 800 px, and saved widths move over.</p>",
        `<p>Cards opened at 560 px.</p>${view(24, before)}`,
        `<p>Cards open at 800 px.</p>${view(30, after)}`,
      )}${SETTLE_FACTS_OPEN}</div>`,
      status: "ready",
      createdAt: Date.now(),
      width: "wide",
      risk,
      actions: [
        {
          id: "discard",
          label: "Discard",
          danger: true,
          effect: { kind: "settle", mode: "discard" },
        },
        { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
      ],
    });
  } finally {
    db.close();
  }
}
