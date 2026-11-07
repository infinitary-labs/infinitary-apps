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
import { INTEGRATION_APPROVAL_WORDS } from "@shared/integrations";
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
import { CardChoiceUnavailableError } from "./cardActions";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
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
  h.supervisor.cards.raiseHostCard({
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
    expect(sendWriteAsk).toHaveBeenCalledWith(h.taskId, "ask-1", undefined);
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
// the card waits" inside that place runs on the same click.
describe("Allow for the rest of this task on a crewmate's integration card (INF-2993)", () => {
  const SCOPE = {
    key: "POST /repos/octo/queue-proof-4ca5",
    words: "POST requests to octo/queue-proof-4ca5",
  };
  function integrationAsk(id: string, path: string, scope = SCOPE): IntegrationAsk {
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
      reason: "Open the proof pull request the task asks for.",
      signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
      input: JSON.stringify({ method: "POST", path, body: "{}" }),
      scope,
      at: 1,
    };
  }

  it("runs the chosen call, then the task's waiting calls in the same place, and leaves any other waiting", async () => {
    const allowance: IntegrationAllowance = {
      connection: "c-github",
      action: "write",
      signature: '["POST, PATCH, PUT or DELETE one path","changes"]',
      scope: SCOPE.key,
      words: SCOPE.words,
      mark: "",
      at: 2,
      card: "integration-ask-pulls",
    };
    const sendWriteAsk = vi.fn(
      async (taskId: string, askId: string, choice?: string): Promise<WriteAskSent> => {
        const ask = h.tasks.get(taskId)?.delivery?.writeAsks?.find((entry) => entry.id === askId);
        return {
          ok: true,
          ...(ask ? { ask: { ...ask, sentAt: 3 } } : {}),
          call: "write",
          place: "GitHub",
          outcome: { kind: "ran" },
          answer: '{"number":7}',
          ...(choice === "task" ? { allowance } : {}),
        };
      },
    );
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, { sendWriteAsk });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Open the proof pull request",
      intent: intentOf("open the proof pull request"),
    });
    await tick();
    const asks = [
      integrationAsk("pulls", "/repos/octo/queue-proof-4ca5/pulls"),
      integrationAsk("statuses", "/repos/octo/queue-proof-4ca5/statuses/0be4f05"),
      integrationAsk("meter", "/repos/octo/meter/pulls", {
        key: "POST /repos/octo/meter",
        words: "POST requests to octo/meter",
      }),
    ];
    for (const ask of asks) {
      h.tasks.delivery.keepWriteAsk(taskId, ask);
      h.supervisor.integrationAsks.askIntegration(taskId, ask);
    }
    await endTurn(crewmate, taskId, "The proof pull request waits on the captain's click.");
    const prompts = crewmate.promptCalls.length;

    expect(h.supervisor.cardActions.act("integration-ask-pulls", "task")).toEqual({});
    await tick();
    await tick();

    expect(sendWriteAsk.mock.calls.map(([, id, choice]) => `${id} ${choice}`)).toEqual([
      "pulls task",
      "statuses once",
    ]);
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
    const heard = crewmate.promptCalls.slice(prompts).join("\n");
    expect(heard).toContain(
      `${INTEGRATION_APPROVAL_WORDS.task}: your later calls of write on GitHub for POST requests to octo/queue-proof-4ca5 run at once`,
    );
  });
});
