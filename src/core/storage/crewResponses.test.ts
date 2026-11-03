import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { laneTurnText, renderWake } from "../orchestrator/wakes";
import { FIRSTMATE_RECIPIENT, InboxStore } from "./inboxStore";

// Intent: INF-2214's accepted default-response contract; fixture: the recorded
// DOP-217 question, DOP-208 answer and later unrelated progress. No PC access.
const question =
  "What is the full path to setup/shell-pc/shell-pc-job-host-remove.cmd on SHELL-PC?";
const path = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
const actor = { task: "DOP-208", session: "dop-208-session" };
function setup() {
  const db = freshDatabase();
  const clock = { now: 1_000 };
  const inbox = new InboxStore(db, { now: () => clock.now });
  const { request, inboxId } = inbox.requestResponse(actor.task, question, {
    session: "firstmate-session",
    message: "path-question",
    targetSession: actor.session,
  });
  return { db, clock, inbox, request, inboxId };
}

describe("requested answers (INF-2214)", () => {
  it("saves the exact answer and first mate row immediately; later work and worker closure cannot erase either", () => {
    const { db, clock, inbox, request, inboxId } = setup();
    expect(inbox.responseRequest(request.id)).toMatchObject({
      body: question,
      state: "pending",
      sourceMessage: "path-question",
    });
    expect(laneTurnText(inbox.allFor(actor.task))).toContain(request.id);
    inbox.markDelivered([inboxId]);
    const response = {
      requestId: request.id,
      responseId: "path-answer",
      status: "answered" as const,
    };
    const saved = inbox.submitResponse(response, actor, path);
    // No turn-end, idle, job, or needs_firstmate input enters the writer.
    expect(inbox.get(saved.wakeId)?.facts).toMatchObject({
      kind: "requested-response",
      excerpt: path,
    });
    inbox.enqueue(actor.task, "The checks are still running.");
    clock.now += 100;
    inbox.purgeTask(actor.task);
    const restarted = new InboxStore(db, { now: () => clock.now });
    expect(restarted.savedResponse(response.responseId)).toEqual(saved);
    expect(restarted.submitResponse(response, actor, path)).toEqual(saved);
    expect(restarted.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    expect(renderWake(restarted.get(saved.wakeId)!)).toContain(path);
    expect(restarted.pendingResponses(actor.task)).toEqual([]);
    db.close();
  });

  it("rolls back answer and wake together, then retries without duplicate submission or notification", () => {
    const { db, inbox, request } = setup();
    const response = {
      requestId: request.id,
      responseId: "path-answer",
      status: "answered" as const,
    };
    expect(() =>
      inbox.transaction(() => {
        inbox.submitResponse(response, actor, path);
        throw new Error("process cut before commit");
      }),
    ).toThrow("process cut before commit");
    expect(inbox.savedResponse(response.responseId)).toBeUndefined();
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    const saved = inbox.submitResponse(response, actor, path);
    inbox.markDelivered([saved.wakeId]);
    inbox.releaseAfterProviderFailure([saved.wakeId]);
    expect(inbox.get(saved.wakeId)?.failures).toBe(1);
    inbox.markDelivered([saved.wakeId]);
    inbox.resetInFlight();
    expect(inbox.get(saved.wakeId)?.deliveredAt).toBeNull();
    inbox.markDelivered([saved.wakeId]);
    expect(inbox.savedResponse(response.responseId)).toMatchObject({
      deliveredAt: null,
      handledAt: null,
    });
    inbox.responsesDelivered([saved.wakeId]);
    expect(inbox.savedResponse(response.responseId)).toMatchObject({
      deliveredAt: 1_000,
      handledAt: null,
    });
    inbox.ack([saved.wakeId]);
    expect(inbox.submitResponse(response, actor, path)).toEqual({
      ...saved,
      deliveredAt: 1_000,
      handledAt: 1_000,
    });
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    db.close();
  });

  it("correlates individual requests; nonfinal answers notify but leave pending, and corrections append", () => {
    const { db, inbox, request } = setup();
    const other = inbox.requestResponse(actor.task, "Did the checks finish?").request;
    inbox.submitResponse(
      { requestId: request.id, responseId: "not-ready", status: "not-yet-answered" },
      actor,
      "I am checking the target location.",
    );
    expect(inbox.pendingResponses(actor.task).map((r) => r.id)).toEqual([request.id, other.id]);
    inbox.submitResponse(
      { requestId: request.id, responseId: "path-answer", status: "answered" },
      actor,
      path,
    );
    // Another authenticated contributor is allowed; this grants no card edit rights.
    inbox.submitResponse(
      { requestId: request.id, responseId: "path-correction", status: "answered" },
      { task: "DOP-209", session: "helper" },
      `${path} (run as administrator)`,
    );
    expect(inbox.savedResponse("path-answer")?.text).toBe(path);
    expect(inbox.savedResponse("path-correction")?.contributorTask).toBe("DOP-209");
    expect(inbox.pendingResponses(actor.task).map((r) => r.id)).toEqual([other.id]);
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(3);
    expect(() =>
      inbox.submitResponse(
        { requestId: other.id, responseId: "path-answer", status: "answered" },
        actor,
        "changed",
      ),
    ).toThrow("identity");
    inbox.cancelResponse(other.id);
    expect(() =>
      inbox.submitResponse(
        { requestId: other.id, responseId: "late", status: "answered" },
        actor,
        "finished",
      ),
    ).toThrow("cancelled");
    expect(() =>
      inbox.submitResponse(
        { requestId: "unknown", responseId: "unknown", status: "answered" },
        actor,
        path,
      ),
    ).toThrow("Unknown");
    db.close();
  });

  it("only the caller's consumed clean-turn rows can produce a missing-response fact, once for that turn", () => {
    const { db, inbox, request, inboxId } = setup();
    const turn = { id: "dop-208-turn", since: 1_000, report: "Checks are still running." };
    expect(inbox.noteMissingResponses(actor.task, [], turn)).toEqual([]);
    expect(inbox.noteMissingResponses("wrong-task", [inboxId], turn)).toEqual([]);
    const missing = inbox.noteMissingResponses(actor.task, [inboxId], turn);
    expect(missing).toHaveLength(1);
    expect(inbox.noteMissingResponses(actor.task, [inboxId], turn)).toEqual([]);
    expect(inbox.get(missing[0]!)?.facts).toMatchObject({
      kind: "response-missing",
      requestId: request.id,
      report: turn.report,
    });
    expect(inbox.responseRequest(request.id)?.state).toBe("pending");
    inbox.submitResponse(
      { requestId: request.id, responseId: "not-yet", status: "not-yet-answered" },
      actor,
      "I am checking the path.",
    );
    expect(
      inbox.noteMissingResponses(actor.task, [inboxId], { ...turn, id: "another-turn" }),
    ).toEqual([]);
    db.close();
  });
});
