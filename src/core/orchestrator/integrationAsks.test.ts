/**
 * The first mate's integration approval card as `IntegrationAsks` holds
 * it (docs/integrations.md).
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { INTEGRATION_APPROVAL_WORDS, integrationApprovalsTitle } from "@shared/integrations";
import { DROPPED_ASK_WHY, type IntegrationAsk, WRITE_ASK_CAP } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { WRITE_ANSWERED_LEAD } from "./deliveryWakes";
import { integrationApprovalCard } from "./integrationApprovalCard";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

// INF-1108: the first mate's held integration call waits on the app's own
// card, whose row the host files, and its outcome wakes the first mate once.
// The captain's q1: "Yes, like any action, but its card highlights Only this
// time, so Always allow takes a deliberate click".
describe("the first mate's integration approval card (INF-1108)", () => {
  function heldCall(id: string): IntegrationAsk {
    return {
      id,
      kind: "integration",
      by: "firstmate",
      integration: "mcp-notes",
      connection: "mcp-notes#1",
      place: "Notes",
      action: "add_note",
      label: "Add a note",
      description: "Adds a note to the end of the list.",
      effect: "changes",
      reason: "The captain asked me to remember the library books.",
      signature: "add_note:changes",
      input: JSON.stringify({ text: "Return the library books by Friday" }),
      at: Date.now(),
    };
  }

  function firstmateSetup() {
    const sent: { rowId: string; askId: string | null; choice: string }[] = [];
    const harness = setup(fakeCrewmate(), {
      sendTakenIntegrationAsk: async (rowId, taken, choice) => {
        sent.push({ rowId, askId: "ask" in taken ? taken.ask.id : null, choice });
        if (!("ask" in taken))
          return {
            ok: false,
            call: "",
            place: "",
            outcome: { kind: "refused", why: taken.refused },
          };
        return choice === "deny"
          ? {
              ok: false,
              ask: taken.ask,
              call: "add_note",
              place: "Notes",
              outcome: { kind: "refused", why: "The captain chose Not now. Nothing ran." },
            }
          : {
              ok: true,
              ask: taken.ask,
              call: "add_note",
              place: "Notes",
              outcome: { kind: "ran" },
              answer: "1. Return the library books by Friday",
            };
      },
    });
    // The real agent's notifyOp is the inbox's deduped wake path.
    harness.supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => {
        harness.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref);
      },
      retryConverse: vi.fn(),
    });
    const wakes = () =>
      harness.inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .map((row) => renderWake(row))
        .filter((text) => text.includes(WRITE_ANSWERED_LEAD) || text.includes("sent nothing"));
    return { ...harness, sent, wakes };
  }

  it("keeps the call on the card's own row, runs it once on the click, and wakes the first mate once", async () => {
    const { supervisor, tasks, sent, wakes } = firstmateSetup();
    const ask = heldCall("ia0000000001");
    const cardId = supervisor.integrationAsks.askIntegrationForFirstmate(ask);
    const card = supervisor.cards.snapshot().find((shown) => shown.id === cardId);
    expect(card).toMatchObject({ author: "host", title: "Allow Add a note on Notes?" });
    expect(card?.taskId).toBeUndefined();
    expect(card?.body).toContain("Your first mate wants to use this action.");
    expect(card?.body).toContain(ask.reason);
    expect(card?.actions.find((action) => action.default)?.label).toBe(
      INTEGRATION_APPROVAL_WORDS.once,
    );
    const row = tasks.capture.openCardTaskFor(cardId);
    expect(row?.delivery?.writeAsks).toEqual([expect.objectContaining({ id: ask.id })]);

    supervisor.cardActions.act(cardId, "once");
    await tick();
    expect(sent).toEqual([{ rowId: row?.id, askId: ask.id, choice: "once" }]);
    expect(tasks.get(row?.id ?? "")?.delivery?.writeAsks?.[0]?.sentAt).toEqual(expect.any(Number));
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).toContain(
      `${WRITE_ANSWERED_LEAD} ${ask.id} (add_note) to Notes, once, and it ran.`,
    );
    expect(wakes()[0]).toContain("1. Return the library books by Friday");

    // The card is answered: a second click or a close runs nothing and wakes nobody.
    supervisor.cardActions.act(cardId, "once");
    supervisor.close(cardId);
    await tick();
    expect(sent).toHaveLength(1);
    expect(wakes()).toHaveLength(1);
  });

  it("INF-1879: putting consent away waits; only Not now refuses it", async () => {
    const { supervisor, tasks, sent, wakes } = firstmateSetup();
    const ask = heldCall("ia0000000002");
    const cardId = supervisor.integrationAsks.askIntegrationForFirstmate(ask);
    const row = tasks.capture.openCardTaskFor(cardId);
    supervisor.close(cardId);
    await tick();
    expect(sent).toEqual([]);
    expect(wakes()).toEqual([]);
    expect(tasks.get(row!.id)?.status).toBe("open");
    supervisor.cardActions.act(cardId, "deny");
    await tick();
    expect(sent).toEqual([{ rowId: row?.id, askId: ask.id, choice: "deny" }]);
    expect(wakes()).toHaveLength(1);
    supervisor.cardActions.act(cardId, "once");
    expect(sent).toHaveLength(1);
  });
});

// INF-2993: Allow for the rest of this task is a crewmate's choice only; the
// first mate's and a panel's cards keep their three buttons, and Only this
// time stays the default for a change.
describe("the approval card's Allow for the rest of this task (INF-2993)", () => {
  const scope = {
    key: "POST /repos/octo/queue-proof-4ca5",
    words: "POST requests to octo/queue-proof-4ca5",
  };
  const ask: IntegrationAsk = {
    id: "pulls",
    kind: "integration",
    integration: "github",
    connection: "c-github",
    place: "GitHub",
    action: "write",
    label: "Change something on GitHub",
    description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
    effect: "changes",
    reason: "Open the proof pull request the task asks for.",
    signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
    input: JSON.stringify({ method: "POST", path: "/repos/octo/queue-proof-4ca5/pulls" }),
    scope,
    at: 1,
  };
  const task = { id: "task-1", title: "Open the proof pull request" };
  const labels = (card: ReturnType<typeof integrationApprovalCard>) =>
    (card.actions ?? []).map((action) => `${action.label}${action.default ? " (default)" : ""}`);

  it("offers it on a crewmate's card that names its place, with one line saying what it covers", () => {
    const card = integrationApprovalCard(ask, task);
    expect(labels(card)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      `${INTEGRATION_APPROVAL_WORDS.once} (default)`,
      INTEGRATION_APPROVAL_WORDS.always,
      INTEGRATION_APPROVAL_WORDS.task,
    ]);
    // The footer draws its default last (`footerGroups`), so this order draws
    // Not now, Always allow, this choice, then Only this time.
    expect(card.body).toContain(
      `${INTEGRATION_APPROVAL_WORDS.task} lets this crewmate run this action for POST requests to octo/queue-proof-4ca5 without asking, until the task closes.`,
    );
    expect(card.title).toBe("Allow Change something on GitHub?");
  });

  it("keeps three buttons for an ask with no place, the first mate's and a panel's", () => {
    const { scope: _none, ...unscoped } = ask;
    for (const card of [
      integrationApprovalCard(unscoped, task),
      integrationApprovalCard({ ...ask, by: "firstmate" }),
      integrationApprovalCard({
        ...ask,
        by: "panel",
        panel: { key: "workspace:board", title: "Board" },
      }),
    ]) {
      expect(labels(card)).toHaveLength(3);
      expect(card.body).not.toContain(INTEGRATION_APPROVAL_WORDS.task);
    }
  });
});

// INF-2993 piece 2, the captain's pick "Every ask that arrives while the card
// waits": a crewmate's asks to one connection share its waiting card. On the
// run that prompted it eight asks waited at once, exactly the cap; a ninth
// drops the oldest waiting ask, which leaves the card and is refused at once.
describe("a crewmate's asks folded into one waiting card (INF-2993 piece 2)", () => {
  const ask = (n: number): IntegrationAsk => ({
    id: `pr-${n}`,
    kind: "integration",
    integration: "github",
    connection: "c-github",
    place: "GitHub",
    action: "write",
    label: "Change something on GitHub",
    description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
    effect: "changes",
    reason: `Open throwaway pull request ${n} for the approved live run of the queue.`,
    signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
    input: JSON.stringify({ method: "POST", path: "/repos/octo/queue-proof-4ca5/pulls" }),
    scope: {
      key: "POST /repos/octo/queue-proof-4ca5",
      words: "POST requests to octo/queue-proof-4ca5",
    },
    at: n,
  });

  it("drops the oldest waiting ask from the card past the cap and tells the crewmate it never ran", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Ship the queue's GitHub part",
      intent: intentOf("ship the queue's GitHub part"),
    });
    await tick();
    for (let n = 1; n <= WRITE_ASK_CAP; n++) {
      const kept = ask(n);
      expect(h.tasks.delivery.keepWriteAsk(taskId, kept)).toEqual([]);
      h.supervisor.integrationAsks.askIntegration(taskId, kept);
    }
    await endTurn(crewmate, taskId, "The pull requests wait on the captain's click.");
    const prompts = crewmate.promptCalls.length;
    const card = () => h.supervisor.cards.get("integration-ask-pr-1");
    expect(card()?.body).toContain('data-inf-ask-row="pr-1"');

    const ninth = ask(WRITE_ASK_CAP + 1);
    const dropped = h.tasks.delivery.keepWriteAsk(taskId, ninth);
    expect(dropped.map((one) => one.id)).toEqual(["pr-1"]);
    expect(h.supervisor.integrationAsks.askIntegration(taskId, ninth, dropped)).toBe(true);
    await tick();

    expect(card()?.title).toBe(integrationApprovalsTitle(WRITE_ASK_CAP, "GitHub"));
    expect(card()?.body).not.toContain('data-inf-ask-row="pr-1"');
    expect(card()?.body).toContain(`data-inf-ask-row="pr-${WRITE_ASK_CAP + 1}"`);
    const heard = crewmate.promptCalls.slice(prompts).join("\n");
    expect(heard).toContain("ask pr-1");
    expect(heard).toContain(DROPPED_ASK_WHY);
  });
});
