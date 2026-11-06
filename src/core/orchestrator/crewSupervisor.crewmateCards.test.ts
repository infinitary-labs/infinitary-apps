/**
 * A crewmate's cards as the crew supervisor takes them, and the integration
 * calls it holds for the captain (docs/card-threads.md, docs/task-browser.md
 * "A page from the project" and "Asking for help", docs/forge.md "A write
 * that asks", docs/integrations.md). INF-2625's plan, the crew supervisor's
 * fifth step, moves this code out of the supervisor into owners of its
 * own - the crewmate's cards, the card's browser door and the integration
 * asks; these cases pin, before it moves, the behaviour no other test
 * reaches: a page from the project on a card's button and each of its
 * refusals, a card that asks to send a kept write, a write on another
 * writer's card, a hand-off with no browser to pause, the merge request's
 * review gate, who still owes a completion card, which refusals the task
 * keeps, and the integration asks of a task, a panel and a first mate
 * whose call never came back. Each drives a public door - the crewmate's
 * own emit_card, a card choice, the supervisor's ask doors - and reads the
 * record, the stack and the words.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_ATTACHMENT_LABEL_MAX } from "@shared/cards";
import { PROJECT_PAGE_RULE } from "@shared/projectPage";
import { sendWriteWords } from "@shared/vocabulary";
import type { ForgeWriteAsk, IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  intentOf,
  METER_RISK,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import type { CrewMachines } from "../placed/crewMachines";
import { bindTool } from "../session/tools";
import { seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { writeAskStrip } from "./requestStrips";

type Browsers = NonNullable<CrewSupervisorOptions["browsers"]>;

/** A task's own browser as the stand-in holds it: open unless a case says otherwise. */
function taskBrowser(answers: { state?: "open" | "stopped"; helps?: boolean } = {}) {
  const browsers = {
    forTask: () => ({
      navigate: vi.fn(async () => ({ text: "opened" })),
      inspect: vi.fn(async () => ({ text: "read" })),
      act: vi.fn(async () => ({ text: "used" })),
      capture: vi.fn(async () => ({ text: "photographed" })),
      close: vi.fn(async () => ({ text: "stopped" })),
      pages: vi.fn(async () => ({ text: "one page" })),
    }),
    fact: () => ({ state: answers.state ?? "open", session: "run-1", generation: 2 }),
    withCaptain: () => false,
    // A browser the host cannot reach answers nothing.
    requestHelp: vi.fn(async () =>
      answers.helps === false
        ? undefined
        : { ok: true as const, handle: { session: "run-1", generation: 2 } },
    ),
    takeControl: vi.fn(async () => ({ ok: true as const })),
    savedSignInFor: vi.fn(() => undefined),
    markSavedSignInFailed: vi.fn(() => false),
    grantSavedSignIn: vi.fn(async () => ({ ok: true as const })),
  };
  return browsers as unknown as Browsers & { requestHelp: typeof browsers.requestHelp };
}

/** A crewmate in its first turn, with its own emit_card bound as Pi and Claude bind it. */
async function crewmateOn(
  extras: Parameters<typeof setup>[1] = {},
  options: { project?: string } = {},
) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, extras);
  const repo = options.project ? h.repos.ensurePersonal(options.project) : undefined;
  const { taskId } = await h.supervisor.commission({
    title: "Build a small game",
    intent: intentOf("build a small game I can play"),
    ...(repo ? { repoId: repo.id } : {}),
  });
  await tick();
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  const own = () => h.supervisor.cards.snapshot().filter((card) => card.taskId === taskId);
  return { ...h, crewmate, taskId, emitCard, own };
}

/** A project folder on this Mac holding the game's page. */
function projectWithPage(): string {
  const folder = scratchDir("infinitary-page-project-");
  mkdirSync(join(folder, "game"));
  writeFileSync(join(folder, "game", "index.html"), "<!doctype html><title>Game</title>");
  return folder;
}

const PLAY = {
  title: "The game is ready to play",
  body: "<p>I built the game in game/index.html. Press Play to try it.</p>",
  actions: [],
};

const HANDOFF = {
  site: "aurora.example",
  reason: "Aurora needs your account to hold the fare",
  after: "fill in the passenger details",
};

const SIGN_IN = {
  title: "Sign in to aurora.example to continue the booking",
  body: "<p>Aurora needs your account to hold the fare, so I paused the browser on its sign-in page.</p>",
  browser_handoff: HANDOFF,
  actions: [
    { id: "leave", label: "Leave waiting" },
    {
      id: "sign-in",
      label: "Open browser and sign in",
      default: true,
      effect: { kind: "open" as const, target: "browser" as const },
    },
  ],
};

/** A write the crewmate asked to send where another project lives, kept on its task. */
function keptWrite(id: string, at = 1_000): ForgeWriteAsk {
  return {
    id,
    kind: "github",
    host: "github.com",
    place: "GitHub",
    via: "account",
    method: "POST",
    path: "/repos/someone/notes/issues",
    body: JSON.stringify({ title: "Game ready" }),
    at,
  };
}

/** A card that asks the captain to send one kept write, beside the crewmate's own Not now. */
function sendCard(...asks: string[]) {
  return {
    title: "Send the release issue to the notes project",
    body: "<p>The notes project tracks each release, so I asked to open its issue there.</p>",
    actions: [
      { id: "not-now", label: "Not now" },
      ...asks.map((ask) => ({
        id: "",
        label: "",
        effect: { kind: "request_write" as const, ask },
      })),
    ],
  };
}

/** An integration action held at Asks you, as its caller asked it. */
function heldCall(id: string, by?: IntegrationAsk["by"]): IntegrationAsk {
  return {
    id,
    kind: "integration",
    ...(by ? { by } : {}),
    ...(by === "panel" ? { panel: { key: "notes-panel", title: "Notes panel" } } : {}),
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
    at: 1_000,
  };
}

describe("a page from the project on a crewmate's card, before it moves out of the crew supervisor", () => {
  it("puts the page on the card's button once the file is in the project folder, its label and path trimmed", async () => {
    const h = await crewmateOn({ browsers: taskBrowser() }, { project: projectWithPage() });
    await h.emitCard.run({ ...PLAY, browser_button: " Play ", browser_page: " game/index.html " });
    expect(h.own()).toHaveLength(1);
    expect(h.own()[0]?.attachment).toEqual({
      kind: "page",
      label: "Play",
      taskId: h.taskId,
      path: "game/index.html",
    });
  });

  it("refuses a page with no button label, a path that is not a page, a page not there yet, a page beside a hand-off, and a page of a task on another computer", async () => {
    const browsers = taskBrowser();
    const h = await crewmateOn({ browsers }, { project: projectWithPage() });
    await expect(h.emitCard.run({ ...PLAY, browser_page: "game/index.html" })).rejects.toThrow(
      `Card refused: browser_page needs browser_button, the label of its button, at most ${LIVE_ATTACHMENT_LABEL_MAX} characters, such as Play.`,
    );
    await expect(
      h.emitCard.run({
        ...PLAY,
        browser_button: "P".repeat(LIVE_ATTACHMENT_LABEL_MAX + 1),
        browser_page: "game/index.html",
      }),
    ).rejects.toThrow("browser_page needs browser_button");
    for (const path of ["../game/index.html", "game/notes.txt"])
      await expect(
        h.emitCard.run({ ...PLAY, browser_button: "Play", browser_page: path }),
      ).rejects.toThrow(`Card refused: browser_page must name ${PROJECT_PAGE_RULE}.`);
    const missing = h.emitCard.run({ ...PLAY, browser_button: "Play", browser_page: "play.html" });
    await expect(missing).rejects.toThrow("Card refused: browser_page found no page to open.");
    await expect(missing).rejects.toThrow("There is no play.html in the project folder yet.");
    await expect(missing).rejects.toThrow(
      "Name the HTML file you built, relative to your working copy.",
    );
    await expect(
      h.emitCard.run({ ...SIGN_IN, browser_button: "Play", browser_page: "game/index.html" }),
    ).rejects.toThrow(
      "Card refused: browser_page opens a page for the captain to use, and browser_handoff asks for their help in the browser as it is: give one, on a card of its own.",
    );
    expect(browsers.requestHelp).not.toHaveBeenCalled();
    h.tasks.placement.setDevice(h.taskId, "mini");
    await expect(
      h.emitCard.run({ ...PLAY, browser_button: "Play", browser_page: "game/index.html" }),
    ).rejects.toThrow(
      "and this task runs on another computer. Emit the card without browser_page.",
    );
    expect(h.own()).toEqual([]);
  });

  it("refuses a page on a task with no project", async () => {
    const h = await crewmateOn({ browsers: taskBrowser() });
    await expect(
      h.emitCard.run({ ...PLAY, browser_button: "Play", browser_page: "game/index.html" }),
    ).rejects.toThrow(
      "Card refused: browser_page opens a page from your task's project, and this task has no project. Emit the card without browser_page.",
    );
    expect(h.own()).toEqual([]);
  });
});

describe("a crewmate's browser door and hand-off, before they move out of the crew supervisor", () => {
  it("refuses a hand-off when the host has no browser to pause, and puts no card up", async () => {
    const browsers = taskBrowser({ helps: false });
    const h = await crewmateOn({ browsers });
    await expect(h.emitCard.run(SIGN_IN)).rejects.toThrow(
      "Card refused: this task has no browser to hand over.",
    );
    expect(browsers.requestHelp).toHaveBeenCalledTimes(1);
    expect(h.own()).toEqual([]);
  });

  it("refuses a hand-off of a browser that has stopped, before pausing anything", async () => {
    const browsers = taskBrowser({ state: "stopped" });
    const h = await crewmateOn({ browsers });
    await expect(h.emitCard.run(SIGN_IN)).rejects.toThrow(
      "Card refused: this task's browser has stopped, so there is nothing to hand over.",
    );
    expect(browsers.requestHelp).not.toHaveBeenCalled();
    expect(h.own()).toEqual([]);
  });
});

describe("a crewmate's card that asks to send a kept write, before it moves out of the crew supervisor", () => {
  it("names the send after where the write goes, makes it the default, and shows the exact call under the body", async () => {
    const h = await crewmateOn();
    const ask = keptWrite("wa000000000001");
    h.tasks.delivery.keepWriteAsk(h.taskId, ask);
    await h.emitCard.run(sendCard(ask.id));
    const card = h.own()[0];
    expect(card?.actions).toEqual([
      expect.objectContaining({ id: "not-now", label: "Not now" }),
      expect.objectContaining({
        id: "send",
        label: sendWriteWords("GitHub"),
        default: true,
        effect: { kind: "request_write", ask: ask.id },
      }),
    ]);
    expect(card?.body.endsWith(writeAskStrip(ask))).toBe(true);
    expect(card?.body).toContain("The notes project tracks each release");
  });

  it("refuses a send for an ask that is not this task's, an integration's, one already sent, and two sends on one card", async () => {
    const h = await crewmateOn();
    await expect(h.emitCard.run(sendCard("wa-unknown"))).rejects.toThrow(
      "Card refused: ask wa-unknown is not on this task. Name the id github_write or an integration's call answered with.",
    );
    h.tasks.delivery.keepWriteAsk(h.taskId, heldCall("ia000000000001"));
    await expect(h.emitCard.run(sendCard("ia000000000001"))).rejects.toThrow(
      "The app already presents integration approval cards. Wait for its answer; do not emit another card.",
    );
    h.tasks.delivery.keepWriteAsk(h.taskId, keptWrite("wa000000000002"));
    expect(h.tasks.delivery.takeWriteAsk(h.taskId, "wa000000000002")).toMatchObject({
      ask: { sentAt: expect.any(Number) },
    });
    await expect(h.emitCard.run(sendCard("wa000000000002"))).rejects.toThrow(
      "Card refused: ask wa000000000002 was already sent once",
    );
    h.tasks.delivery.keepWriteAsk(h.taskId, keptWrite("wa000000000003"));
    h.tasks.delivery.keepWriteAsk(h.taskId, keptWrite("wa000000000004"));
    await expect(h.emitCard.run(sendCard("wa000000000003", "wa000000000004"))).rejects.toThrow(
      "Card refused: a card that asks to send a write asks for exactly one, and carries no merge or discard.",
    );
    expect(h.own()).toEqual([]);
  });
});

describe("a crewmate's write on a card, before it moves out of the crew supervisor", () => {
  it("refuses a revision of its own card read at another revision, and leaves the card as it was", async () => {
    const h = await crewmateOn();
    await h.emitCard.run({
      id: "game-plan",
      title: "The game's plan",
      body: "<p>One level.</p>",
      actions: [],
    });
    const [card] = h.own();
    const read = h.supervisor.cards.cardRead(card?.id ?? "");
    expect(read?.revision).toEqual(expect.any(String));
    await expect(
      h.emitCard.run({
        id: card?.id,
        expected_revision: "stale-revision",
        title: "The game's plan",
        body: "<p>Two levels.</p>",
        actions: [],
      }),
    ).rejects.toThrow(
      `Nothing changed on card "The game's plan" (${card?.id}): you read revision stale-revision, and it is at ${read?.revision} now. Read it again before revising it.`,
    );
    expect(h.own().map((shown) => shown.body)).toEqual(["<p>One level.</p>"]);
  });

  it("refuses, before the card's writer, a choice with no label on another writer's card", async () => {
    const h = await crewmateOn();
    const theirs = h.supervisor.cards.addFirstmateCard({
      title: "Which level comes first",
      body: "<p>The forest or the cave.</p>",
      actions: [
        { id: "forest", label: "Forest", default: true },
        { id: "cave", label: "Cave" },
      ],
    });
    const before = h.supervisor.cards.cardRead(theirs);
    const result = await h.emitCard.run({
      id: theirs,
      title: "Which level comes first",
      body: "<p>The forest, the cave or the sea.</p>",
      expected_revision: before?.revision,
      contribution_reason: "The sea level is built too.",
      actions: [
        { id: "forest", label: "Forest", default: true },
        { id: "sea", label: " " },
      ],
    });
    expect(result.text).toContain(
      `Nothing changed on card "Which level comes first" (${theirs}): choice "sea" needs its label.`,
    );
    expect(h.supervisor.cards.cardRead(theirs)).toEqual(before);
  });

  it("refuses a write on another writer's card from a computer on an older Infinitary, writing nothing", async () => {
    const machines = {
      computers: () => ["mini"],
      ready: () => true,
      nameOf: () => "Mac mini",
      placeOf: () => ({ label: "Mac mini", where: "on Mac mini", who: "Mac mini" }),
      takesSharedCards: () => false,
      signInWait: () => undefined,
      signInsOf: async () => undefined,
      takesRepoless: () => true,
      served: async () => undefined,
      accountOf: () => undefined,
      cutOffOf: () => undefined,
    } as unknown as CrewMachines;
    const h = await crewmateOn({ machines });
    const theirs = h.supervisor.cards.addFirstmateCard({
      title: "Which level comes first",
      body: "<p>The forest or the cave.</p>",
      actions: [],
    });
    const before = h.supervisor.cards.cardRead(theirs);
    h.tasks.placement.setDevice(h.taskId, "mini");
    await expect(
      h.emitCard.run({ id: theirs, title: "Which level", body: "<p>The sea.</p>", actions: [] }),
    ).rejects.toThrow(
      `Card refused: card ${theirs} is not this task's, and Mac mini runs an older Infinitary that cannot write on someone else's card. Nothing was written; reply on it or report the gap to the first mate.`,
    );
    expect(h.supervisor.cards.cardRead(theirs)).toEqual(before);
  });

  it("reads a card as it stands, and names an unknown id in words", async () => {
    const h = await crewmateOn();
    const id = h.supervisor.cards.addFirstmateCard({
      title: "Which level comes first",
      body: "<p>The forest or the cave.</p>",
      actions: [],
    });
    expect(JSON.parse(h.supervisor.readCard(` ${id} `))).toEqual(
      JSON.parse(JSON.stringify(h.supervisor.cards.cardRead(id))),
    );
    expect(h.supervisor.readCard(" card-gone ")).toBe(
      'No card "card-gone" is on the record. Read the id again.',
    );
  });
});

describe("a crewmate's merge cards and refusals, before they move out of the crew supervisor", () => {
  const MERGE_REQUEST = {
    title: "Merge the level editor's pull request",
    body: "<p>The level editor's pull request is reviewed.</p>",
    actions: [
      { id: "later", label: "Not now" },
      { id: "", label: "", effect: { kind: "request_merge" as const, review: "mr-1" } },
    ],
  };

  it("holds a merge request card on the review gate's refusal, and puts it up with the host's button when the gate passes it", async () => {
    let refusal: string | undefined = "Card refused: pull request #7 moved after its review.";
    const reviewGate = vi.fn(async () => refusal);
    const h = await crewmateOn({ reviewGate });
    await expect(h.emitCard.run(MERGE_REQUEST)).rejects.toThrow(
      "Card refused: pull request #7 moved after its review.",
    );
    expect(reviewGate).toHaveBeenCalledWith(h.taskId, "mr-1");
    expect(h.own()).toEqual([]);
    refusal = undefined;
    await h.emitCard.run(MERGE_REQUEST);
    expect(h.own()[0]?.actions).toEqual([
      expect.objectContaining({ id: "later", label: "Not now" }),
      expect.objectContaining({
        id: "merge",
        default: true,
        effect: { kind: "request_merge", review: "mr-1" },
      }),
    ]);
  });

  it("keeps a refused completion card on a task that owes one, and nothing on a task that ships no change", async () => {
    const h = await crewmateOn();
    const merge = {
      title: "The game is ready",
      body: "<p>The game works.</p>",
      risk: METER_RISK,
      actions: [
        { id: "merge", label: "", effect: { kind: "settle" as const, mode: "merge" as const } },
      ],
    };
    await expect(h.emitCard.run(merge)).rejects.toThrow("Card refused: declare required_actions");
    expect(h.tasks.get(h.taskId)?.delivery?.cardRefusal).toMatchObject({
      title: "The game is ready",
      reason: "shape",
      why: "required_actions is missing",
    });

    const answer = await crewmateOn();
    const answerTask = await answer.supervisor.commission({
      title: "Check the game's licence",
      intent: {
        ...intentOf("tell me whether the font's licence lets me ship it"),
        constraints: [{ kind: "read-only" }],
      },
    });
    await tick();
    expect(answer.tasks.get(answerTask.taskId)?.shape).toMatchObject({ deliverable: "answer" });
    const emitAnswer = bindTool(EMIT_CARD_TOOL, answer.specs.at(-1) as CrewmateSpec);
    await expect(emitAnswer.run(merge)).rejects.toThrow(
      "Card refused: this task's deliverable is an answer",
    );
    expect(answer.tasks.get(answerTask.taskId)?.delivery?.cardRefusal).toBeUndefined();
  });

  it("says a task's crewmate owes its completion card only on active change work with none up yet", async () => {
    const h = await crewmateOn();
    expect(h.supervisor.crewmateOwesCompletion(h.taskId)).toBe(true);
    const seeded = (id: string, shape: Parameters<typeof seedTask>[1]["shape"]) => {
      seedTask(h.tasks, { id, title: id, status: "running", shape });
      return h.supervisor.crewmateOwesCompletion(id);
    };
    expect(seeded("t-change", { kind: "unclear", deliverable: "change" })).toBe(true);
    expect(seeded("t-review", { kind: "review", deliverable: "change" })).toBe(false);
    expect(
      seeded("t-in-place", { kind: "unclear", deliverable: "change", in_place: { folder: true } }),
    ).toBe(false);
    expect(seeded("t-answer", { kind: "unclear", deliverable: "answer" })).toBe(false);
    seedTask(h.tasks, { id: "t-queued", title: "t-queued", status: "queued" });
    expect(h.supervisor.crewmateOwesCompletion("t-queued")).toBe(false);
  });
});

describe("integration calls held for the captain, before they move out of the crew supervisor", () => {
  it("puts a task's held call on its own card, and none for a task that has closed", async () => {
    const h = await crewmateOn();
    h.supervisor.askIntegration(h.taskId, heldCall("ia000000000010"));
    expect(h.own()).toEqual([
      expect.objectContaining({ author: "host", title: "Allow Add a note on Notes?" }),
    ]);
    seedTask(h.tasks, { id: "t-closed", title: "Old notes", status: "running" });
    h.tasks.close("t-closed", { status: "dropped", reason: "cancelled", actor: "host" });
    h.supervisor.askIntegration("t-closed", heldCall("ia000000000011"));
    expect(h.supervisor.cards.snapshot().filter((card) => card.taskId === "t-closed")).toEqual([]);
  });

  it("keeps a panel's call on its card's own row, and tells the panel the choice, never the first mate", async () => {
    const panelAskAnswered = vi.fn();
    const sendTakenIntegrationAsk = vi.fn(async (_rowId: string, taken, _choice) => ({
      ok: true,
      ...("ask" in taken ? { ask: taken.ask } : {}),
      call: "add_note",
      place: "Notes",
      outcome: { kind: "ran" as const },
      answer: "1. Return the library books by Friday",
    })) as NonNullable<CrewSupervisorOptions["sendTakenIntegrationAsk"]>;
    const h = setup(fakeCrewmate(), { sendTakenIntegrationAsk, panelAskAnswered });
    const ask = heldCall("ia000000000020", "panel");
    const cardId = h.supervisor.askIntegrationForPanel(ask);
    const row = h.tasks.capture.openCardTaskFor(cardId);
    expect(row?.delivery?.writeAsks).toEqual([expect.objectContaining({ id: ask.id })]);
    expect(
      h.supervisor.cards.snapshot().find((card) => card.id === cardId)?.taskId,
    ).toBeUndefined();

    h.supervisor.act(cardId, "once");
    await tick();
    expect(sendTakenIntegrationAsk).toHaveBeenCalledTimes(1);
    expect(panelAskAnswered.mock.calls).toEqual([[ask.id, "once"]]);
    expect(h.ops).toEqual([]);
  });

  it("records a first mate's call that threw after the click as unknown, and wakes the first mate once saying so", async () => {
    const sendTakenIntegrationAsk = vi.fn(async () => {
      throw new Error("the Notes connection dropped mid-call");
    });
    const h = setup(fakeCrewmate(), { sendTakenIntegrationAsk });
    const ask = heldCall("ia000000000030", "firstmate");
    const cardId = h.supervisor.askIntegrationForFirstmate(ask);
    const row = h.tasks.capture.openCardTaskFor(cardId);
    h.supervisor.act(cardId, "once");
    await tick();
    expect(sendTakenIntegrationAsk).toHaveBeenCalledTimes(1);
    expect(h.tasks.get(row?.id ?? "")?.delivery?.writeAsks?.[0]?.outcome).toEqual({
      kind: "unknown",
      why: "the Notes connection dropped mid-call",
    });
    expect(h.ops).toHaveLength(1);
    expect(h.ops[0]).toContain(ask.id);
    expect(h.ops[0]).toContain("the Notes connection dropped mid-call");
  });
});
