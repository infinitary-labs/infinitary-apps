import { SETTLE_FACTS_OPEN } from "@shared/cards";
import type { RiskAssessment } from "@shared/risk";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import type { HomeRead } from "../browserFreshHome";
import { completionCardBody } from "../completionCard";
import { seedDelivery } from "../taskDelivery";

const CARD_ID = "card-triage-skill";
const TASK_ID = "task-triage-skill";

/**
 * The card's thread, which the window reads when the card shows, and the
 * crew step's task key, which the body looks up to link it.
 */
export const asked: HomeRead[] = [
  ["inf:cards:thread", [CARD_ID]],
  ["inf:tasks:search", ["DOT-41"]],
];

/** What the after-merge strip test's card reads back. */
type Words = { title: string; risk: RiskAssessment; paragraph: string };

/**
 * A merge card like the one in the captain's photo (INF-3149): a skill
 * ready to merge, one step only the captain can do after it, and two the
 * crew starts on its own - one an existing task by its key, one the first
 * mate does in the app. The declarations' own refusals are the card tool's
 * and the supervisor's tests.
 */
export default function seed(userDataDir: string, { title, risk, paragraph }: Words): void {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, { id: TASK_ID, title: "Build the alert triage skill", status: "completed" });
    seedDelivery(tasks, TASK_ID, { mode: "local-only", ci: "green", ciAt: Date.now(), risk });
    const words = `<p>${paragraph}</p>`.repeat(3);
    new CardStore(db).upsert({
      id: CARD_ID,
      taskId: TASK_ID,
      author: "crewmate",
      meta: "crewmate",
      priority: 30,
      title,
      body: `${completionCardBody(words, words, words, words)}${SETTLE_FACTS_OPEN}</div>`,
      status: "ready",
      createdAt: Date.now(),
      risk,
      requiredActions: [
        {
          id: "link-skill",
          target: "your dotfiles",
          title: "Link the skill after merge",
          consequence: "The skill is not available until it is linked.",
          instructions: ["Run the link step in your dotfiles."],
          criterion: "The skill shows in the skill list.",
          prerequisites: [],
          completion: { kind: "manual", label: "Linked" },
        },
      ],
      afterMerge: [
        {
          key: "DOT-41",
          title: "Add the skill to the team's index",
          goal: "The team index lists the alert triage skill.",
        },
        {
          doer: "firstmate",
          title: "Tell the data channel the skill exists",
          goal: "One message in the data channel names the skill.",
        },
      ],
      actions: [
        {
          id: "discard",
          label: "Discard",
          danger: true,
          effect: { kind: "settle", mode: "discard" },
        },
        { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
      ],
    });
  } finally {
    db.close();
  }
}
