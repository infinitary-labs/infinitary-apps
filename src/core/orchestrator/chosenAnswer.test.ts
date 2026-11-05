import { join } from "node:path";
import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CardStore } from "../storage/cardStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { WorkspaceService } from "../workspace/workspaceService";
import { AnswerDeliveryCheck } from "./answerDeliveryCheck";
import { askEndingOf } from "./askEnding";
import { CardService } from "./cardService";
import { createSettleOwners } from "./settleOwners";

/**
 * INF-2242's approved plan, replaying INF-2235's answering+asking choice.
 * The real resolution, acceptance, closure, handoff and sweep owners share
 * one database. No model runtime, worktree, signing or external service is
 * needed to observe this bookkeeping boundary.
 */
function fixture() {
  const db = freshDatabase();
  let clock = 1_000;
  const now = () => clock;
  const tasks = new TaskService({ db, strict: true, now });
  const inbox = new InboxStore(db);
  const cardStore = new CardStore(db);
  const root = scratchDir("infinitary-chosen-answer-");
  const workspace = new WorkspaceService(
    {
      worktreesDir: join(root, "worktrees"),
      worktreeTrashDir: join(root, "trash"),
      worktreePoolDir: join(root, "pool"),
      defaultWorkspaceDir: join(root, "default"),
    },
    { pool: false },
  );
  const repos = new RepoRegistry(db, join(root, "fleet"));
  const makeCards = (): CardService =>
    new CardService({
      now,
      tasks,
      cardStore,
      syncCaptainGate: () => {},
      noteCapAnswered: () => {},
      closeAnsweredTask: (card, action, by) => settle.declared.closeAnsweredTask(card, action, by),
      captainResponded: (card, response, action) => ending.captainResponded(card, response, action),
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
    });
  const cards = makeCards();
  const ending = askEndingOf(tasks, cards);
  const settle = createSettleOwners({
    now,
    tasks,
    inbox,
    workspace,
    repos,
    cards,
    askEnding: ending,
    runtimeState: () => undefined,
    stopRuntime: () => undefined,
    endLiveTask: () => {},
    isPersonalTask: () => false,
    deliverableOf: (record) => record.shape?.deliverable ?? "change",
    taskDelivery: () => undefined,
    taskAutonomy: () => false,
    resolveTaskRef: (id) => {
      const record = tasks.get(id);
      if (!record) throw new Error(`Unknown task ${id}`);
      return record;
    },
    notifyOp: () => {},
    pokeInbox: () => {},
    sweepGates: async () => {},
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
  });
  seedTask(tasks, {
    id: "reading",
    title: "Plan a reading-style feature",
    status: "running",
    shape: { kind: "plan", deliverable: "answer" },
  });
  clock += 1_000;
  tasks.openAsk({ id: "reading-style", text: "How could a reading-style feature work?" });
  tasks.attachAsk("reading-style", "reading", "tool:spawn_crewmate");
  tasks.closeAsk("reading-style", "closed");
  tasks.setAskDelivery("reading-style", "covered");
  clock += 1_000;
  const id = cards.emitCrewmateCard(
    "reading",
    {
      id: "reading-style-plan",
      title: "A reading-style plan with a separate rights assessment",
      body: '<p>The plan separates reading style from rights assessment.</p><input type="hidden" name="settings" value="separate-rights">',
      answering: true,
      asking: true,
      actions: [
        { id: "start", label: "Start the next step", default: true },
        { id: "defer", label: "Save and defer" },
        { id: "abandon", label: "Abandon" },
      ],
    },
    "model",
  );
  cards.closeOut({ kind: "crewmate", taskId: "reading" }, "report");
  return { db, tasks, inbox, cardStore, cards, ending, settle, makeCards, id };
}

describe("choosing a delivered answer", () => {
  it.each(["start", "defer", "abandon"])(
    "accepts the chosen answer before closing its plan and preserves the %s handoff",
    async (action) => {
      const { db, tasks, inbox, cardStore, cards, settle, makeCards, id } = fixture();
      const card = cards.shown(id) as Card;
      const acceptanceAtClose: unknown[] = [];
      const close = tasks.close.bind(tasks);
      vi.spyOn(tasks, "close").mockImplementation((...args) => {
        if (args[0] === "reading")
          acceptanceAtClose.push(tasks.getAsk("reading-style")?.answerCardId);
        return close(...args);
      });
      let closing: Promise<void> | undefined;
      const closeTask = settle.closing.closeTask.bind(settle.closing);
      vi.spyOn(settle.closing, "closeTask").mockImplementation((...args) => {
        closing = closeTask(...args);
        return closing;
      });
      const answers = [{ name: "settings", values: ["separate-rights"], changed: false }];
      expect(cards.resolve(card, action, action, answers)).toBe(true);
      await closing;
      expect(acceptanceAtClose).toEqual([card.id]);
      expect(tasks.get("reading")).toMatchObject({ status: "done", closedReason: "answered" });
      expect(tasks.getAsk("reading-style")).toMatchObject({
        answerCardId: card.id,
        acceptedAt: expect.any(Number),
      });
      expect(cardStore.chosenAction(card.id)).toBe(action);
      expect(cardStore.past(card.id)).toMatchObject({
        title: card.title,
        body: card.body,
        answers,
      });
      expect(cardStore.past(card.id)?.actions.map((entry) => entry.id)).toEqual(
        card.actions.map((entry) => entry.id),
      );
      const handoffs = () => inbox.pending(FIRSTMATE_RECIPIENT).map((row) => row.facts);
      expect(handoffs()).toEqual([
        expect.objectContaining({
          kind: "answer-closed",
          handoff: expect.objectContaining({
            event: "answer_task_closed",
            choice: expect.objectContaining({ id: action }),
          }),
        }),
      ]);
      // Restart the readers before the legitimate handoff is processed.
      const restartedTasks = new TaskService({ db, strict: true });
      const restored = makeCards();
      const ending = askEndingOf(restartedTasks, restored);
      const check = new AnswerDeliveryCheck({
        tasks: restartedTasks,
        inbox,
        now: Date.now,
        ending,
        raiseNotice: () => {
          throw new Error("An accepted plan needs no duplicate notice");
        },
        cardTitle: () => undefined,
      });
      check.sweep();
      expect(handoffs().some((facts) => facts?.kind === "answer-missing")).toBe(false);
      expect(restartedTasks.getAsk("reading-style")?.answeredAt).toBeNull();
      // Re-delivery finds neither an open offer nor an answer task to close.
      const acceptedAt = restartedTasks.getAsk("reading-style")?.acceptedAt;
      const handoff = handoffs();
      expect(restored.get(card.id)).toBeUndefined();
      expect(settle.declared.closeAnsweredTask(card, action, "captain")).toBe(false);
      expect(restartedTasks.getAsk("reading-style")?.acceptedAt).toBe(acceptedAt);
      expect(handoffs()).toHaveLength(1);
      inbox.ack(inbox.pending(FIRSTMATE_RECIPIENT).map((row) => row.id));
      check.sweep();
      expect(restartedTasks.getAsk("reading-style")?.answeredAt).toEqual(expect.any(Number));
      expect([...restored.values()]).toEqual([]);
      console.info(
        "Chosen-answer receipt",
        JSON.stringify({
          action,
          task: restartedTasks.get("reading")?.closedReason,
          acceptedCardId: restartedTasks.getAsk("reading-style")?.answerCardId,
          acceptedAt,
          answeredAt: restartedTasks.getAsk("reading-style")?.answeredAt,
          savedChoice: cardStore.chosenAction(card.id),
          savedAnswers: cardStore.past(card.id)?.answers,
          handoff,
          pending: handoffs(),
        }),
      );
      cards.dispose();
      restored.dispose();
    },
  );
});
