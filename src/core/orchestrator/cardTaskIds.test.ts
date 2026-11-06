import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { TaskService } from "../tasks/taskService";
import { CardService } from "./cardService";
import { requiredActionCard } from "./requiredActionCard";

/**
 * Every card the app itself raises about a task names that task (INF-358;
 * the captain's "the task key is added to all decision cards about a
 * task, so it's not inconsistent"): the card's head draws the task's key
 * from `taskId`, so a host card that knows its task sets it, and one about
 * no task leaves it out. The stall card's is pinned where the idle ladder
 * raises it (idleLadder.test.ts, "has been stuck for").
 */
describe("the app's own cards about a task", () => {
  it("name the task on the required action card and on a sign-in asked for a task", () => {
    const action = requiredActionCard(
      "op1",
      {
        requirements: [
          {
            source: "t1",
            offer: "offer-1",
            action: {
              id: "install",
              target: "the Mac mini",
              title: "Install the new version",
              consequence: "Until then it keeps the old one.",
              instructions: ["Open Infinitary there."],
              criterion: "It reports the new version.",
              prerequisites: [],
              completion: { kind: "manual", label: "I installed it" },
            },
          },
        ],
        generation: 1,
        state: "ready",
        cardId: "card-fm-required-action-op1",
        presentedGeneration: 1,
        activatedAt: 1,
      },
      1000,
    );
    expect(action.taskId).toBe("op1");

    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => 1000 });
    const pushes: Card[][] = [];
    const cards = new CardService({
      now: () => 1000,
      tasks,
      cardStore: new CardStore(db),
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: (stack) => pushes.push(stack),
      broadcastThread: () => {},
    });
    cards.addAuthDecisionCard("card-auth-task", "Claude", "Sign in again.", { taskId: "t1" });
    cards.addAuthDecisionCard("card-auth-account", "Claude", "Sign in again.");
    expect(cards.get("card-auth-task")?.taskId).toBe("t1");
    expect(cards.get("card-auth-account")?.taskId).toBeUndefined();
  });
});
