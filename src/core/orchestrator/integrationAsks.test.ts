/**
 * The first mate's integration approval card as `IntegrationAsks` holds
 * it (docs/integrations.md).
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { INTEGRATION_APPROVAL_WORDS } from "@shared/integrations";
import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { WRITE_ANSWERED_LEAD } from "./deliveryWakes";
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
