import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AskEnding } from "./askEnding";
import type { KeptApproval } from "./keptApproval";
import type { SettleServiceHost } from "./settleHost";
import type { SettleLocks } from "./settleLocks";
import { closingNoteTitle } from "./settleWords";
import { type TaskClose, TaskClosing } from "./taskClose";

/**
 * Where a closed task's outcome goes (INF-6115, the captain's pick "Its own
 * note"): a card speaks only for its own task, so a close line or merge
 * line lands only on a card of the closed task, and otherwise the drop is
 * told on one short note named for that task. Over a real task graph and
 * message record, with one clock so "shown since the message" is an order.
 */
function fixture() {
  const clock = { t: 1_000 };
  const now = () => clock.t;
  const later = () => {
    clock.t += 1_000;
    return clock.t;
  };
  const tasks = new TaskService({ db: freshDatabase(), strict: true, now });
  const open = new Map<string, Card>();
  const stored = new Map<string, Card>();
  const shown = new Map<string, number>();
  const ending = new AskEnding({
    tasks,
    openCards: () => open.values(),
    storedCard: (id) => stored.get(id),
    shownAt: (card) => shown.get(card.id) ?? 0,
    seenCards: () => [],
  });
  /** Every card the close wrote: revised, put back or added. */
  const writes: { kind: "revised" | "added"; card: Card }[] = [];
  const cards = {
    values: () => open.values(),
    drawsMergedLine: () => false,
    closedByCaptain: (taskId: string) =>
      [...stored.values()].filter((card) => card.taskId === taskId && !open.has(card.id)),
    reviseBody: (id: string, body: string) => {
      const card = { ...(stored.get(id) as Card), body };
      stored.set(id, card);
      if (open.has(id)) open.set(id, card);
      writes.push({ kind: "revised", card });
    },
    addFirstmateCard: (input: Omit<Card, "id" | "author" | "priority" | "meta" | "status">) => {
      const card: Card = {
        id: `card-note-${writes.length}`,
        author: "firstmate",
        priority: 30,
        meta: "",
        status: "ready",
        ...input,
        createdAt: later(),
      } as Card;
      open.set(card.id, card);
      stored.set(card.id, card);
      writes.push({ kind: "added", card });
      return card;
    },
  };
  const host = { tasks, askEnding: ending, cards, now } as unknown as SettleServiceHost;
  const closing = new TaskClosing(host, {} as SettleLocks, {} as KeptApproval);

  const message = (id: string, text: string, taskId: string) => {
    later();
    tasks.capture.openAsk({ id, text });
    tasks.capture.attachAsk(id, taskId, "tool:spawn_crewmate");
    tasks.capture.closeAsk(id, "closed");
  };
  const show = (card: Partial<Card> & Pick<Card, "id" | "title">): Card => {
    const full: Card = {
      author: "crewmate",
      priority: 30,
      meta: "",
      body: `<p>${card.title}.</p>`,
      actions: [],
      status: "ready",
      createdAt: clock.t,
      ...card,
    };
    open.set(full.id, full);
    stored.set(full.id, full);
    shown.set(full.id, later());
    return full;
  };
  /** The captain chooses on a card or closes a note: it leaves the stack. */
  const respond = (card: Card, response: "choice" | "close", action?: string) => {
    later();
    ending.captainResponded(card, response, action);
    open.delete(card.id);
  };
  const close = (
    taskId: string,
    status: TaskClose["status"],
    reason: TaskClose["reason"],
    actor: TaskClose["actor"],
    sentence?: string,
  ) => {
    later();
    tasks.close(taskId, { status, reason, actor });
    closing.placeOutcome(tasks.get(taskId) as TaskRecord, reason, actor, sentence);
  };
  return { tasks, ending, open, stored, writes, message, show, respond, close, later };
}

const MERGE: Card["actions"][number] = {
  id: "merge",
  label: "Merge",
  default: true,
  effect: { kind: "merge", after: "close" },
};
const SENTENCE =
  "You chose to drop the checklist page, so I filed its launch steps as tasks instead.";

describe("where a closed task's outcome goes", () => {
  // The case that raised INF-6114: a build started from a plan card's
  // choice, its review, a chart fix grounded in that review with its own
  // message, the captain's merge of the fix, then the first mate's discard
  // of the build. The fix's merge card used to come back with the drop.
  it("leaves the fix's merge card as the captain merged it and tells the drop on one note of its own", () => {
    const f = fixture();
    const plan = seedTask(f.tasks, {
      id: "plan",
      title: "Plan the open-sourcing",
      status: "running",
    });
    f.message("ask-open", "plan how we open-source the project", plan.id);
    const planCard = f.show({
      id: "card-plan",
      taskId: plan.id,
      title: "Open-sourcing in ten steps",
      actions: [{ id: "build", label: "Approve and build", default: true }],
    });
    f.respond(planCard, "choice", "build");
    f.close(plan.id, "done", "answered", "captain");
    const build = seedTask(f.tasks, {
      id: "build",
      title: "Build the checklist page",
      status: "running",
      shape: { kind: "implement", basis: plan.key },
    });
    const review = seedTask(f.tasks, {
      id: "review",
      title: "Review the checklist page",
      status: "running",
      parentId: build.id,
      shape: { kind: "implement", basis: build.key },
    });
    const fix = seedTask(f.tasks, {
      id: "fix",
      title: "Fix the chart",
      status: "running",
      shape: { kind: "fix", basis: review.key },
    });
    f.message("ask-chart", "the chart on the usage page is cut off", fix.id);
    f.close(review.id, "done", "finished", "host");

    const merge = f.show({
      id: "card-fix-merge",
      taskId: fix.id,
      title: "The chart fits its panel",
      actions: [MERGE],
    });
    f.respond(merge, "choice", "merge");
    f.close(fix.id, "done", "merged", "captain");
    const merged = f.stored.get(merge.id);

    f.close(build.id, "dropped", "discarded", "firstmate", SENTENCE);

    // The merge card is unchanged and not raised again.
    expect(f.stored.get(merge.id)).toBe(merged);
    expect(f.open.has(merge.id)).toBe(false);
    expect(f.writes.filter((write) => write.card.id === merge.id)).toEqual([]);
    // Exactly one card names the dropped build: its own closing note.
    const naming = [...f.open.values()].filter((card) =>
      `${card.title} ${card.body}`.includes(build.key),
    );
    expect(naming.map((card) => ({ title: card.title, taskId: card.taskId }))).toEqual([
      { title: closingNoteTitle(build.key, "dropped"), taskId: build.id },
    ]);
    expect(naming[0]?.body).toContain("You chose to drop the checklist page");
  });

  // The invariant behind it, for every close the first mate's sentence can
  // ride: a card the close writes on belongs to the task it closed.
  const closes: [TaskClose["status"], TaskClose["reason"]][] = [
    ["done", "merged"],
    ["done", "landed"],
    ["done", "released"],
    ["done", "finished"],
    ["dropped", "discarded"],
    ["dropped", "cancelled"],
  ];
  const actors: TaskClose["actor"][] = ["captain", "firstmate", "host"];
  const answers = ["accepted", "up"] as const;
  for (const [status, reason] of closes)
    for (const actor of actors)
      for (const answer of answers)
        for (const sentence of [undefined, SENTENCE])
          it(`writes only on the closed task's cards: ${reason} by ${actor}, the other work's answer ${answer}, ${sentence ? "with" : "without"} a sentence`, () => {
            const f = fixture();
            const first = seedTask(f.tasks, {
              id: "first",
              title: "Build the page",
              status: "running",
            });
            const other = seedTask(f.tasks, {
              id: "other",
              title: "Fix the chart",
              status: "running",
            });
            f.message("ask", "ship the page and fix the chart", first.id);
            f.tasks.capture.attachAsk("ask", other.id, "tool:spawn_crewmate");
            const card = f.show({
              id: "card-other",
              taskId: other.id,
              title: "The chart fits its panel",
              answering: true,
              actions: [{ id: "read", label: "I read it", default: true }],
            });
            f.close(other.id, "done", "finished", "host");
            if (answer === "accepted") f.respond(card, "choice", "read");

            f.close(first.id, status, reason, actor, sentence);

            expect(f.writes.filter((write) => write.card.taskId !== first.id)).toEqual([]);
            expect(f.stored.get(card.id)?.body).toBe(card.body);
          });
});
