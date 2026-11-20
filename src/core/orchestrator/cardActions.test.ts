/**
 * A click on a card as `CardActions` takes it (docs/cards.md; FI3-1571
 * piece 4 for a crewmate's kept write): the choices it refuses before any
 * bookkeeping, a settle or merge button that names no task, and a
 * crewmate's kept write sent once on the captain's click, with the
 * crewmate hearing what came of it. These cases pin the behaviour no other
 * test reaches. Each case clicks a card through the card actions' public
 * door and reads its answer, the record and what the crewmate heard.
 */

import type { HostEffect } from "@shared/cards";
import {
  ASK_ROW_WORDS,
  allowFieldOf,
  INTEGRATION_APPROVAL_WORDS,
  type IntegrationApprovalChoice,
  integrationApprovalsTitle,
  NOT_ALLOWED_WHY,
} from "@shared/integrations";
import type { IntegrationAllowance, IntegrationAsk, WriteAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { IntegrationAskTaken } from "../integrations";
import { CardChoiceUnavailableError } from "./cardActions";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { integrationApprovalCard } from "./integrationApprovalCard";
import { writeSentLine } from "./integrationAsks";

fakeCrewTimersEachTest();

type Harness = ReturnType<typeof setup>;
type WriteAskSent = Awaited<ReturnType<NonNullable<CrewSupervisorOptions["sendWriteAsk"]>>>;

const CALL = "POST /repos/meter-co/meter/issues";
const PLACE = "GitHub";

/** The write github_write kept for the captain's click: a new issue upstream. */
const ASK: WriteAsk = {
  id: "ask-1",
  kind: "github",
  host: "github.com",
  place: PLACE,
  via: "project",
  method: "POST",
  path: "/repos/meter-co/meter/issues",
  body: '{"title":"The meter skips presses"}',
  at: 1,
};

/** A started task whose crewmate asks, in its first turn, to send a kept write. */
async function askedWrite(extras: SetupExtras = {}) {
  const crewmate: FakeCrewmate = fakeCrewmate();
  const h = setup(crewmate, extras);
  const { taskId } = await h.supervisor.intake.commission({
    title: "File the meter bug",
    intent: intentOf("file the meter bug upstream"),
  });
  await tick();
  h.tasks.delivery.keepWriteAsk(taskId, ASK);
  const emitted = await h.specs[0]?.onCard?.({
    title: "Send the bug report",
    body: "<p>I need your click to file the issue upstream.</p>",
    actions: [
      { id: "send", label: "Send it", effect: { kind: "request_write", ask: "ask-1" } },
      { id: "not-now", label: "Not now" },
    ],
  });
  // A card asked mid-turn goes up when its turn ends.
  await endTurn(crewmate, taskId, "The bug report is ready to file.");
  const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
  if (!card) throw new Error(`the crewmate's card did not go up: ${JSON.stringify(emitted)}`);
  return { ...h, crewmate, taskId, cardId: card.id };
}

/** What the kept write's host answered: a created issue. */
function sent(): WriteAskSent {
  return {
    ok: true,
    ask: { ...ASK, sentAt: 2 },
    call: CALL,
    place: PLACE,
    outcome: { kind: "answered", status: 201, requestId: null },
    answer: "201 Created",
  };
}

/** The app's own card with one action carrying this effect, about no task. */
function taskless(
  h: Harness,
  id: string,
  effect: HostEffect | { kind: string; [k: string]: unknown },
) {
  h.supervisor.cards.hostCards.raiseHostCard({
    id,
    title: "A question the app asks",
    meta: "the app",
    body: "<p>Go ahead?</p>",
    actions: [{ id: "go", label: "Go", effect: effect as HostEffect }],
  });
  return id;
}

describe("a click on a card, as CardActions takes it", () => {
  it("sends a crewmate's kept write once on the captain's click, notes it, and tells the crewmate what came of it", async () => {
    const sendWriteAsk = vi.fn(async () => sent());
    const h = await askedWrite({ sendWriteAsk });
    const prompts = h.crewmate.promptCalls.length;

    expect(h.supervisor.cardActions.act(h.cardId, "send")).toEqual({});
    await tick();

    expect(sendWriteAsk).toHaveBeenCalledTimes(1);
    expect(sendWriteAsk).toHaveBeenCalledWith(h.taskId, "ask-1");
    expect(
      h.tasks
        .timeline(h.taskId)
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain(writeSentLine(sent()));
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    const heard = h.crewmate.promptCalls.at(-1) ?? "";
    expect(heard).toContain(CALL);
    expect(heard).toContain("201");
  });

  it("sends nothing when the app cannot send a kept write, and tells a closed task nothing", async () => {
    const none = await askedWrite();
    const prompts = none.crewmate.promptCalls.length;
    expect(none.supervisor.cardActions.act(none.cardId, "send")).toEqual({});
    await tick();
    expect(none.crewmate.promptCalls).toHaveLength(prompts);

    // The task closes while the send is under way: its note and its crewmate's turn never come.
    let answer: (value: WriteAskSent) => void = () => {};
    const sendWriteAsk = vi.fn(
      () =>
        new Promise<WriteAskSent>((resolve) => {
          answer = resolve;
        }),
    );
    const closing = await askedWrite({ sendWriteAsk });
    const before = closing.crewmate.promptCalls.length;
    closing.supervisor.cardActions.act(closing.cardId, "send");
    closing.tasks.close(closing.taskId, {
      status: "dropped",
      reason: "cancelled",
      actor: "captain",
    });
    answer(sent());
    await tick();
    expect(sendWriteAsk).toHaveBeenCalledTimes(1);
    expect(
      closing.tasks
        .timeline(closing.taskId)
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).not.toContain(writeSentLine(sent()));
    expect(closing.crewmate.promptCalls).toHaveLength(before);
  });

  it("refuses a choice the card never offered, a frame's oversized value and a frame's click on an effect", async () => {
    const sendWriteAsk = vi.fn(async () => sent());
    const h = await askedWrite({ sendWriteAsk });

    expect(() => h.supervisor.cardActions.act(h.cardId, "delete-repo")).toThrow(
      CardChoiceUnavailableError,
    );
    expect(() =>
      h.supervisor.cardActions.act(h.cardId, "not-now", "frame", { note: "x".repeat(5000) }),
    ).toThrow("Card settings must be JSON no larger than 4,096 bytes.");
    // cardActions.browser.test.ts owns the refusal's words.
    expect(() => h.supervisor.cardActions.act(h.cardId, "send", "frame")).toThrow(
      "available only from the card controls",
    );
    // Nothing was sent and the card is still up for the captain's own click.
    expect(sendWriteAsk).not.toHaveBeenCalled();
    expect(h.cards().some((card) => card.id === h.cardId)).toBe(true);
  });

  it("does nothing for a settle, merge or write button on a card that names no task", () => {
    const h = setup(fakeCrewmate());
    const settle = vi.spyOn(h.supervisor.settling.settle, "reportCardSettle");
    const merge = vi.spyOn(h.supervisor.settling.kept, "requestMerge");

    expect(
      h.supervisor.cardActions.act(
        taskless(h, "c-settle", { kind: "settle", mode: "discard" }),
        "go",
      ),
    ).toEqual({});
    expect(
      h.supervisor.cardActions.act(
        taskless(h, "c-merge", { kind: "merge", review: "r-1", after: "continue" }),
        "go",
      ),
    ).toEqual({});
    expect(
      h.supervisor.cardActions.act(
        taskless(h, "c-write", { kind: "request_write", ask: "ask-1" }),
        "go",
      ),
    ).toEqual({});
    expect(settle).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });
});

// INF-2993, the captain's picks: Allow for the rest of this task covers "The
// same action, kind of request and place", and "Every ask that arrives while
// the card waits" joins that card (piece 2), so one click answers them all.
describe("a crewmate's integration approval card (INF-2993)", () => {
  const SCOPE = {
    key: "POST /repos/octo/queue-proof-4ca5",
    words: "POST requests to octo/queue-proof-4ca5",
  };
  const SIGNATURE = '["POST, PATCH, PUT or DELETE one path","changes"]';
  function integrationAsk(id: string, path: string, scope = SCOPE, at = 1): IntegrationAsk {
    return {
      id,
      kind: "integration",
      integration: "github",
      connection: "c-github",
      place: "GitHub",
      action: "write",
      label: "Change something on GitHub",
      description: "POST, PATCH, PUT or DELETE one path through the captain's GitHub sign-in.",
      effect: "changes",
      reason: `Open ${id} for the proof the task asks for.`,
      signature: SIGNATURE,
      input: JSON.stringify({ method: "POST", path, body: "{}" }),
      scope,
      at,
    };
  }
  /** The service's run of a taken ask, as the integration answers it, with the allowance a task choice keeps. */
  function sendTaken() {
    return vi.fn(
      async (
        _taskId: string,
        taken: IntegrationAskTaken,
        choice: IntegrationApprovalChoice,
      ): Promise<WriteAskSent> => {
        if (!("ask" in taken) || taken.ask.kind !== "integration")
          return { ok: false, call: "", place: "", outcome: { kind: "refused", why: "taken" } };
        const ask = taken.ask;
        return {
          ok: true,
          ask,
          call: ask.action,
          place: ask.place,
          outcome: { kind: "ran" },
          answer: `{"opened":"${ask.id}"}`,
          ...(choice === "task" && ask.scope
            ? {
                allowance: {
                  connection: "c-github",
                  action: ask.action,
                  signature: SIGNATURE,
                  scope: ask.scope.key,
                  words: ask.scope.words,
                  mark: "",
                  at: 2,
                  card: `integration-ask-${ask.id}`,
                } satisfies IntegrationAllowance,
              }
            : {}),
        };
      },
    );
  }
  async function started(sendTakenIntegrationAsk: ReturnType<typeof sendTaken>) {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, { sendTakenIntegrationAsk });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Open the proof pull request",
      intent: intentOf("open the proof pull request"),
    });
    await tick();
    return { h, crewmate, taskId };
  }
  const ran = (send: ReturnType<typeof sendTaken>) =>
    send.mock.calls.map(([, taken, choice]) => `${"ask" in taken ? taken.ask.id : "-"} ${choice}`);

  it("runs a waiting call kept on its own card before cards listed several, when an allowance covers it, and leaves any other waiting", async () => {
    const send = sendTaken();
    const { h, crewmate, taskId } = await started(send);
    const task = { id: taskId, title: "Open the proof pull request" };
    // Asks kept before cards listed several each have a card of their own.
    for (const ask of [
      integrationAsk("pulls", "/repos/octo/queue-proof-4ca5/pulls"),
      integrationAsk("statuses", "/repos/octo/queue-proof-4ca5/statuses/0be4f05"),
      integrationAsk("meter", "/repos/octo/meter/pulls", {
        key: "POST /repos/octo/meter",
        words: "POST requests to octo/meter",
      }),
    ]) {
      h.tasks.delivery.keepWriteAsk(taskId, ask);
      h.supervisor.cards.put(integrationApprovalCard(ask, task));
    }
    await endTurn(crewmate, taskId, "The proof pull request waits on the captain's click.");
    const prompts = crewmate.promptCalls.length;

    expect(h.supervisor.cardActions.act("integration-ask-pulls", "task")).toEqual({});
    await tick();
    await tick();

    expect(ran(send)).toEqual(["pulls task", "statuses once"]);
    const up = h.supervisor.cards
      .snapshot()
      .filter((card) => card.taskId === taskId)
      .map((card) => card.id);
    expect(up).toContain("integration-ask-meter");
    expect(up).not.toContain("integration-ask-statuses");
    expect(
      h.tasks
        .timeline(taskId)
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain(
      "The captain allowed write on GitHub for the rest of this task, for POST requests to octo/queue-proof-4ca5.",
    );
    // One click, one message naming both outcomes.
    const heard = crewmate.promptCalls.slice(prompts);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(
      `${INTEGRATION_APPROVAL_WORDS.task}: your later calls of write on GitHub for POST requests to octo/queue-proof-4ca5 run at once`,
    );
    expect(heard[0]).toContain('{"opened":"statuses"}');
  });

  it("folds the asks that arrive while the card waits into it, and a row the captain unticks is refused while the allowed ones run", async () => {
    const send = sendTaken();
    const { h, crewmate, taskId } = await started(send);
    const asks = [
      integrationAsk("pr-a", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 1),
      integrationAsk("pr-b", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 2),
      integrationAsk("pr-c", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 3),
    ];
    const joined = asks.map((ask) => {
      h.tasks.delivery.keepWriteAsk(taskId, ask);
      return h.supervisor.integrationAsks.askIntegration(taskId, ask);
    });
    expect(joined).toEqual([false, true, true]);
    // Another connection's ask raises its own card.
    const other = { ...integrationAsk("notes", "/x", SCOPE, 4), connection: "c-notes" };
    h.tasks.delivery.keepWriteAsk(taskId, other);
    expect(h.supervisor.integrationAsks.askIntegration(taskId, other)).toBe(false);
    await endTurn(crewmate, taskId, "The proof pull requests wait on the captain's click.");
    const cards = h.supervisor.cards.snapshot().filter((card) => card.taskId === taskId);
    expect(cards.map((card) => card.id).sort()).toEqual([
      "integration-ask-notes",
      "integration-ask-pr-a",
    ]);
    const folded = cards.find((card) => card.id === "integration-ask-pr-a");
    expect(folded?.title).toBe(integrationApprovalsTitle(3, "GitHub"));
    expect(folded?.actions.map((action) => action.label)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      INTEGRATION_APPROVAL_WORDS.once,
      INTEGRATION_APPROVAL_WORDS.always,
      INTEGRATION_APPROVAL_WORDS.task,
    ]);
    for (const ask of asks) expect(folded?.body).toContain(`data-inf-ask-row="${ask.id}"`);
    // The last revision marks the row that joined in it.
    expect(folded?.body.split(ASK_ROW_WORDS.joined)).toHaveLength(2);
    const prompts = crewmate.promptCalls.length;

    expect(
      h.supervisor.cardActions.act(
        "integration-ask-pr-a",
        "once",
        "chrome",
        {
          answers: [
            { name: allowFieldOf("pr-a"), values: ["allow"], changed: false },
            { name: allowFieldOf("pr-b"), values: [], changed: true },
          ],
        },
        { id: "gesture-0001", lifecycleId: folded?.lifecycleId, offerId: folded?.offerId },
      ),
    ).toEqual({});
    await tick();
    await tick();

    expect(ran(send)).toEqual(["pr-a once", "pr-c once"]);
    const left = h.tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === "pr-b");
    expect(left?.sentAt).toBeDefined();
    expect(left?.outcome).toEqual({ kind: "refused", why: NOT_ALLOWED_WHY });
    const heard = crewmate.promptCalls.slice(prompts);
    expect(heard).toHaveLength(1);
    const order = ["pr-a", "pr-b", "pr-c"].map((id) => heard[0]?.indexOf(`ask ${id}`) ?? -1);
    expect(
      order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? 0))),
    ).toBe(true);
    expect(heard[0]).toContain(NOT_ALLOWED_WHY);
    // The other connection's card still waits.
    expect(h.supervisor.cards.get("integration-ask-notes")).toBeDefined();
  });

  it("INF-3307 audit: a later Allow for the rest of this task never runs an ask whose card its crewmate withdrew", async () => {
    const send = sendTaken();
    const { h, crewmate, taskId } = await started(send);
    const withdrawn = integrationAsk("pr-a", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 1);
    h.tasks.delivery.keepWriteAsk(taskId, withdrawn);
    h.supervisor.integrationAsks.askIntegration(taskId, withdrawn);
    // The crewmate takes its ask back before the captain answers it.
    h.supervisor.closeCard(
      "integration-ask-pr-a",
      { kind: "crewmate", taskId },
      "The proof no longer needs that pull request.",
    );
    const later = integrationAsk("pr-b", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 2);
    h.tasks.delivery.keepWriteAsk(taskId, later);
    expect(h.supervisor.integrationAsks.askIntegration(taskId, later)).toBe(false);
    await endTurn(crewmate, taskId, "The proof pull request waits on the captain's click.");

    expect(h.supervisor.cardActions.act("integration-ask-pr-b", "task")).toEqual({});
    await tick();
    await tick();

    expect(ran(send)).toEqual(["pr-b task"]);
    const kept = h.tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === "pr-a");
    expect(kept?.sentAt).toBeUndefined();
  });

  // INF-4190: what pressed the button never changes what the press does, so
  // an input this home cannot read - a key label past its bound, or a kind a
  // later window adds - never refuses a consequential press on the current offer.
  it("takes an approval pressed on the current offer whatever input it names, readable or not", async () => {
    const send = sendTaken();
    const { h, crewmate, taskId } = await started(send);
    const ask = integrationAsk("pr-a", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 1);
    h.tasks.delivery.keepWriteAsk(taskId, ask);
    h.supervisor.integrationAsks.askIntegration(taskId, ask);
    await endTurn(crewmate, taskId, "The proof pull request waits on the captain's click.");
    const shown = h.supervisor.cards.get("integration-ask-pr-a");

    expect(
      h.supervisor.cardActions.act("integration-ask-pr-a", "once", "chrome", undefined, {
        id: "gesture-0003",
        lifecycleId: shown?.lifecycleId,
        offerId: shown?.offerId,
        // A Linux two-key binding's label, past the input's 32-character bound.
        input: {
          kind: "key",
          command: "cards.choice-1",
          keys: ["Ctrl+Alt+Shift+K Ctrl+Alt+Shift+S"],
        },
      }),
    ).toEqual({});
    await tick();
    await tick();
    expect(ran(send)).toEqual(["pr-a once"]);
  });

  it("refuses a click on an offer the card showed before an ask joined, and shows the current list", async () => {
    const send = sendTaken();
    const { h, crewmate, taskId } = await started(send);
    const first = integrationAsk("pr-a", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 1);
    h.tasks.delivery.keepWriteAsk(taskId, first);
    h.supervisor.integrationAsks.askIntegration(taskId, first);
    await endTurn(crewmate, taskId, "The proof pull request waits on the captain's click.");
    const shown = h.supervisor.cards.get("integration-ask-pr-a");
    const second = integrationAsk("pr-b", "/repos/octo/queue-proof-4ca5/pulls", SCOPE, 2);
    h.tasks.delivery.keepWriteAsk(taskId, second);
    h.supervisor.integrationAsks.askIntegration(taskId, second);
    const revised = h.supervisor.cards.get("integration-ask-pr-a");
    expect(revised?.offerId).not.toBe(shown?.offerId);

    expect(() =>
      h.supervisor.cardActions.act("integration-ask-pr-a", "once", "chrome", undefined, {
        id: "gesture-0002",
        lifecycleId: shown?.lifecycleId,
        offerId: shown?.offerId,
      }),
    ).toThrow(CardChoiceUnavailableError);
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(h.supervisor.cards.get("integration-ask-pr-a")?.title).toBe(
      integrationApprovalsTitle(2, "GitHub"),
    );
  });
});
