import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { TaskService } from "../tasks/taskService";
import { ANSWER_MISSING_REF, AnswerDeliveryCheck } from "./answerDeliveryCheck";
import { answerMissingWake, captainTurn } from "./wakes";

/**
 * The check over its saved state: a restart (a second check over the same
 * database) resumes where the first stopped, and no message gets a second
 * retry or a second notice.
 */
function fixture(observe = false) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const notices: string[] = [];
  const boot = () =>
    new AnswerDeliveryCheck({
      tasks,
      inbox,
      now: () => 1_000,
      raiseNotice: (card) => notices.push(card.id),
      cardTitle: () => undefined,
      observe,
    });
  const ask = (id: string, text = `message ${id}`) => tasks.openAsk({ id, text });
  const retryRows = () =>
    inbox
      .allFor(FIRSTMATE_RECIPIENT)
      .flatMap((row) => (row.facts?.kind === "answer-missing" ? [row.facts.askId] : []));
  return { db, tasks, inbox, notices, boot, ask, retryRows };
}

describe("the answer-delivery check across a restart", () => {
  it("queues one retry for a message nothing followed, even when the turn is judged twice", () => {
    const f = fixture();
    f.ask("m1");
    const check = f.boot();
    check.endTurn({ asks: ["m1"], held: false, unread: [] });
    expect(f.tasks.getAsk("m1")?.delivery).toBe("retrying");
    expect(f.retryRows()).toEqual(["m1"]);
    // A second look at the same message (a replayed turn end) finds it retrying
    // with its wake on the lane: that is a notice, never a second wake.
    f.boot().reconcile([]);
    expect(f.retryRows()).toEqual(["m1"]);
    expect(f.notices).toEqual([]);
  });

  it("judges a message whose turn the app quit in from its saved facts", () => {
    const f = fixture();
    f.ask("covered");
    f.ask("silent");
    f.tasks.noteDelivery(["covered"], {
      outcome: "action",
      kind: "card",
      tool: "emit_card",
      at: 1,
    });
    f.boot().reconcile(["covered", "silent"]);
    expect(f.tasks.getAsk("covered")?.delivery).toBe("covered");
    expect(f.tasks.getAsk("silent")?.delivery).toBe("retrying");
    expect(f.retryRows()).toEqual(["silent"]);
    // Booting again changes nothing.
    f.boot().reconcile([]);
    expect(f.retryRows()).toEqual(["silent"]);
    expect(f.notices).toEqual([]);
  });

  it("leaves a stranded message whose words are parked on the lane to the turn that serves them", () => {
    const f = fixture();
    f.ask("parked");
    f.inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      captainTurn("message parked", false, undefined, "parked"),
      "captain-turn",
      "captain",
    );
    f.boot().reconcile(["parked"]);
    expect(f.tasks.getAsk("parked")?.delivery).toBe("pending");
    expect(f.retryRows()).toEqual([]);
  });

  it("raises one notice for a retried message whose wake was served, and never a second", () => {
    const f = fixture();
    f.ask("m1");
    f.boot().endTurn({ asks: ["m1"], held: false, unread: [] });
    // The retry was served and acknowledged; the app quit before its check.
    const [row] = f.inbox.allFor(FIRSTMATE_RECIPIENT);
    f.inbox.ack([row?.id as number]);
    f.boot().reconcile([]);
    expect(f.notices).toEqual(["card-ask-m1"]);
    expect(f.tasks.getAsk("m1")).toMatchObject({
      delivery: "unresolved",
      noticeCardId: "card-ask-m1",
    });
    f.boot().reconcile([]);
    expect(f.notices).toEqual(["card-ask-m1"]);
    expect(f.retryRows()).toEqual([]);
  });

  it("covers a retried message whose served retry did show an answer, quietly", () => {
    const f = fixture();
    f.ask("m1");
    f.boot().endTurn({ asks: ["m1"], held: false, unread: [] });
    const [row] = f.inbox.allFor(FIRSTMATE_RECIPIENT);
    f.inbox.ack([row?.id as number]);
    f.tasks.noteDelivery(["m1"], { outcome: "action", kind: "card", tool: "emit_card", at: 2 });
    f.boot().reconcile([]);
    expect(f.tasks.getAsk("m1")?.delivery).toBe("covered");
    expect(f.notices).toEqual([]);
  });

  it("leaves a retrying message whose wake is still queued for the turn that serves it", () => {
    const f = fixture();
    f.ask("m1");
    f.inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      answerMissingWake({ askId: "m1", excerpt: "message m1" }),
      "agent",
      ANSWER_MISSING_REF,
    );
    f.tasks.setAskDelivery("m1", "retrying");
    f.boot().reconcile([]);
    expect(f.tasks.getAsk("m1")?.delivery).toBe("retrying");
    expect(f.notices).toEqual([]);
  });

  it("ends a retrying message unresolved, with no notice, when the purge empties the lane", () => {
    const f = fixture();
    f.ask("m1");
    f.boot().endTurn({ asks: ["m1"], held: false, unread: [] });
    f.inbox.deleteFor(FIRSTMATE_RECIPIENT);
    f.boot().lanePurged();
    f.boot().reconcile([]);
    expect(f.tasks.getAsk("m1")).toMatchObject({ delivery: "unresolved", noticeCardId: null });
    expect(f.notices).toEqual([]);
  });

  it("judges nothing in observe mode", () => {
    const f = fixture(true);
    f.ask("m1");
    f.boot(); // reconcile is the boot's own call; endTurn is the turn's.
    f.boot().endTurn({ asks: ["m1"], held: false, unread: [] });
    expect(f.tasks.getAsk("m1")?.delivery).toBe("pending");
    expect(f.retryRows()).toEqual([]);
  });
});
