/**
 * The first mate's integration approval card as `IntegrationAsks` holds
 * it (docs/integrations.md).
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import {
  cardReaderAsksTitle,
  cardReaderCallsLead,
  cardReaderCallsPagesTitle,
  cardReaderPagesLead,
  cardReaderPagesTitle,
  cardReaderWritesLead,
} from "@shared/i18n/messages.generated";
import { INTEGRATION_APPROVAL_WORDS, integrationApprovalsTitle } from "@shared/integrations";
import {
  DROPPED_ASK_WHY,
  type ForgeWriteAsk,
  type IntegrationAsk,
  type WebReadAsk,
  WRITE_ASK_CAP,
} from "@shared/writeAsk";
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
import type { WriteAskSent } from "./githubGateway";
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

// An unsafe data reader's web pages (docs/agents-reach.md, "Web pages"): the
// captain's plan put a page it waits to open on the reader's one approval
// card, as a row showing its whole address.
describe("a reader's web pages on its approval card", () => {
  const write: ForgeWriteAsk = {
    id: "fw-issue",
    kind: "github",
    host: "github.com",
    via: "project",
    place: "GitHub",
    method: "POST",
    path: "/repos/octo/meter/issues",
    body: JSON.stringify({ title: "Triage: the meter idles on a cold start" }),
    at: 1,
  };
  const page: WebReadAsk = {
    id: "wa-forum",
    kind: "web",
    url: "https://forum.meter.example/t/idle?from=12",
    place: "forum.meter.example",
    at: 2,
  };

  async function reader(answer: (ask: WebReadAsk) => WriteAskSent) {
    const crewmate = fakeCrewmate();
    const sent: { askId: string | null; choice: string }[] = [];
    const h = setup(crewmate, {
      sendTakenIntegrationAsk: async (_taskId, taken, choice) => {
        sent.push({ askId: "ask" in taken ? taken.ask.id : null, choice });
        if (!("ask" in taken) || taken.ask.kind !== "web")
          return { ok: false, call: "", place: "", outcome: { kind: "refused", why: "unused" } };
        return answer(taken.ask);
      },
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Triage the waiting issues",
      intent: intentOf("triage the waiting issues"),
    });
    await tick();
    return { ...h, crewmate, sent, taskId };
  }

  it("lists a page alone with its whole address under its own title", async () => {
    const h = await reader(() => {
      throw new Error("not clicked");
    });
    h.tasks.delivery.keepWriteAsk(h.taskId, page);
    expect(h.supervisor.integrationAsks.askForge(h.taskId, page)).toBe(false);
    const card = h.supervisor.cards.get(`write-ask-${page.id}`);
    expect(card?.title).toBe(cardReaderPagesTitle());
    expect(card?.body).toContain(`GET ${page.url}`);
    expect(card?.body).toContain(cardReaderPagesLead({ task: "Triage the waiting issues" }));
    expect(card?.body).not.toContain(
      cardReaderWritesLead({ task: "Triage the waiting issues", place: "GitHub" }),
    );
  });

  it("joins a reader's waiting integration call on its one card, whose title names the calls and the pages", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Triage the waiting issues",
      intent: {
        ...intentOf("triage the waiting issues"),
        constraints: [{ kind: "read-only" as const }],
      },
      shape: { unsafe_data_reader: true },
    });
    await tick();
    const note: IntegrationAsk = {
      id: "ia-note",
      kind: "integration",
      integration: "mcp-notes",
      connection: "mcp-notes#1",
      place: "Notes",
      action: "add_note",
      label: "Add a note",
      effect: "changes",
      signature: "add_note:changes",
      input: JSON.stringify({ text: "The meter idles on a cold start" }),
      at: 1,
    };
    h.tasks.delivery.keepWriteAsk(taskId, note);
    h.supervisor.integrationAsks.askIntegration(taskId, note);
    h.tasks.delivery.keepWriteAsk(taskId, page);
    expect(h.supervisor.integrationAsks.askForge(taskId, page)).toBe(true);

    const cards = h.supervisor.cards.snapshot().filter((card) => card.taskId === taskId);
    expect(cards.map((card) => card.id)).toEqual([`write-ask-${note.id}`]);
    const card = cards[0];
    expect(card?.title).toBe(cardReaderCallsPagesTitle());
    expect(card?.body).toContain(cardReaderCallsLead({ task: "Triage the waiting issues" }));
    expect(card?.body).toContain(cardReaderPagesLead({ task: "Triage the waiting issues" }));
    expect(card?.body).toContain(`GET ${page.url}`);
    expect(card?.body?.match(/checked>/g)).toHaveLength(2);
  });

  it("joins a waiting write's card as a second ticked row, and the click opens the page once", async () => {
    const h = await reader((ask) => ({
      ok: true,
      ask,
      call: `GET ${ask.url}`,
      place: ask.place,
      outcome: { kind: "answered", status: 200, requestId: null },
      answer: "web_read part 1 of 1",
    }));
    h.tasks.delivery.keepWriteAsk(h.taskId, write);
    h.supervisor.integrationAsks.askForge(h.taskId, write);
    h.tasks.delivery.keepWriteAsk(h.taskId, page);
    expect(h.supervisor.integrationAsks.askForge(h.taskId, page)).toBe(true);
    await endTurn(h.crewmate, h.taskId, "A write and a page wait on the captain.");
    const prompts = h.crewmate.promptCalls.length;
    const cardId = `write-ask-${write.id}`;
    const card = h.supervisor.cards.get(cardId);
    expect(card?.title).toBe(cardReaderAsksTitle({ place: "GitHub" }));
    const rows = [
      ...(card?.body ?? "").matchAll(
        /data-inf-ask-row="([^"]+)"[\s\S]*?inf-ask-call inf-mono">([^<]+)</g,
      ),
    ].map((match) => [match[1], match[2]]);
    expect(rows).toEqual([
      [write.id, "POST /repos/octo/meter/issues"],
      [page.id, "GET https://forum.meter.example/t/idle?from=12"],
    ]);
    expect(card?.body?.match(/checked>/g)).toHaveLength(2);
    expect(card?.actions.map((action) => action.label)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      INTEGRATION_APPROVAL_WORDS.once,
    ]);

    h.supervisor.cardActions.act(cardId, "once");
    await tick();
    await tick();
    // Oldest first, each once: this stand-in answers only the page.
    expect(h.sent).toEqual([
      { askId: write.id, choice: "once" },
      { askId: page.id, choice: "once" },
    ]);
    const heard = h.crewmate.promptCalls.slice(prompts).join("\n");
    expect(heard).toContain(
      `${WRITE_ANSWERED_LEAD} ${page.id} (GET ${page.url}): the page opened once, signed out, and answered 200.`,
    );
    expect(heard).toContain("web_read part 1 of 1");
  });
});
