/**
 * A crewmate's cards as the crew takes them, and the integration calls it
 * holds for the captain (docs/card-threads.md, docs/task-browser.md
 * "A page from the project" and "Asking for help", docs/forge.md "A write
 * that asks", docs/integrations.md; `CrewmateCards`, `CardBrowserActions`
 * and `IntegrationAsks`). These cases pin the behaviour no other test
 * reaches: a page from the project on a card's button and each of its
 * refusals, a card that asks to send a kept write, a write on another
 * writer's card, a hand-off with no browser to pause, the merge request's
 * review gate, who still owes a completion card, which refusals the task
 * keeps, and the integration asks of a task, a panel and a first mate
 * whose call never came back. Each drives a public door - the crewmate's
 * own emit_card, a card choice, the crewmate cards' and the integration
 * asks' own doors - and reads the record, the stack and the words.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECLINE_ACTION_ID } from "@shared/cardLeave";
import { LIVE_ATTACHMENT_LABEL_MAX, MERGE_NOT_NOW_ID } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import type { LiveValidation } from "@shared/liveValidation";
import { liveValidationSummary } from "@shared/liveValidationSummary";
import { presentationValidation } from "@shared/presentationValidation";
import { PROJECT_PAGE_RULE } from "@shared/projectPage";
import { MERGE_NOT_NOW_WORDS, sendWriteWords, submitFeedbackWords } from "@shared/vocabulary";
import type { ForgeWriteAsk, IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import { DEMO_POSTER, DEMO_RECORDING } from "../../../tests/e2e/demoFixtures";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody } from "../forge";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { keepValidationEvidence, readKeptValidationEvidence } from "../pi/validationEvidence";
import type { CrewMachines } from "../placed/crewMachines";
import { bindTool } from "../session/tools";
import { recordValidation } from "../tasks/liveValidation";
import { seedTask } from "../tasks/seedTask";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { writeAskStrip } from "./requestStrips";

fakeCrewTimersEachTest();

type Browsers = NonNullable<CrewSupervisorOptions["browsers"]>;

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
  const { taskId } = await h.supervisor.intake.commission({
    title: "Build a small game",
    intent: intentOf("build a small game I can play"),
    ...(repo ? { repoId: repo.id } : {}),
  });
  await tick();
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  const own = () => h.supervisor.cards.snapshot().filter((card) => card.taskId === taskId);
  return { ...h, crewmate, taskId, emitCard, own };
}

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

describe("a page from the project on a crewmate's card", () => {
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

describe("a crewmate's browser door and hand-off", () => {
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

describe("a crewmate's card that asks to send a kept write", () => {
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
      // Its Not now is not marked as its way to say no, so the app's Decline joins (INF-3108).
      expect.objectContaining({ id: DECLINE_ACTION_ID }),
    ]);
    expect(card?.body.endsWith(writeAskStrip(ask))).toBe(true);
    expect(card?.body).toContain("The notes project tracks each release");
  });

  it("names a /feedback report's send Submit feedback, the captain's words for it", async () => {
    const h = await crewmateOn();
    const title = "Merge card keeps showing checks that already finished";
    const ask: ForgeWriteAsk = {
      ...keptWrite("wa000000000002"),
      path: "/repos/infinitary-labs/infinitary-apps/issues",
      body: JSON.stringify({
        title,
        body: "## What happened\n\nThe merge card kept showing its checks as running.",
      }),
      feedback: { kind: "bug", title, login: "octocat" },
    };
    h.tasks.delivery.keepWriteAsk(h.taskId, ask);
    await h.emitCard.run(sendCard(ask.id));
    const send = h.own()[0]?.actions.find((action) => action.id === "send");
    expect(send).toMatchObject({
      label: submitFeedbackWords(),
      default: true,
      effect: { kind: "request_write", ask: ask.id },
    });
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

describe("a crewmate's write on a card", () => {
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

  it.each([
    [
      "is cancelled",
      (h: Awaited<ReturnType<typeof crewmateOn>>) =>
        h.supervisor.sessions.interruptCrewmate(h.taskId, "cancel"),
    ],
    [
      "fails",
      async (h: Awaited<ReturnType<typeof crewmateOn>>) => {
        h.crewmate.failPrompt("Client exited unexpectedly.");
      },
    ],
    [
      "is settled",
      (h: Awaited<ReturnType<typeof crewmateOn>>) =>
        h.supervisor.settling.closing.closeTask(h.taskId, {
          status: "dropped",
          reason: "discarded",
          actor: "host",
        }),
    ],
  ])("shows its held revision of another task's card once its task %s", async (_how, end) => {
    // INF-3307's audit, row 2: the writer's turn ended with no close-out,
    // so the stage kept the old version until a restart.
    const h = await crewmateOn();
    seedTask(h.tasks, { id: "author", title: "Inspect the level", status: "idle" });
    const cards = h.supervisor.cards;
    const id = cards.emitCrewmateCard(
      "author",
      { title: "The level", body: "<p>The forest.</p>", actions: [] },
      "m",
    );
    cards.closeOut({ kind: "crewmate", taskId: "author" }, "idle");
    await h.emitCard.run({
      id,
      expected_revision: cards.cardRead(id)?.revision,
      contribution_reason: "The cave is built too.",
      title: "The level",
      body: "<p>The forest and the cave.</p>",
      actions: [],
    });
    expect(cards.shown(id)?.body).toBe("<p>The forest.</p>");

    await end(h);
    await tick();
    expect(h.tasks.get(h.taskId)?.status).toBe("dropped");
    expect(cards.shown(id)?.body).toBe("<p>The forest and the cave.</p>");
  });

  it("reads a card as it stands, and names an unknown id in words", async () => {
    const h = await crewmateOn();
    const id = h.supervisor.cards.addFirstmateCard({
      title: "Which level comes first",
      body: "<p>The forest or the cave.</p>",
      actions: [],
    });
    expect(JSON.parse(h.supervisor.crewmateCards.readCard(` ${id} `))).toMatchObject({
      id,
      title: "Which level comes first",
      author: "firstmate",
      open: true,
      choices: [],
      body: "<p>The forest or the cave.</p>",
      thread: [],
    });
    expect(h.supervisor.crewmateCards.readCard(" card-gone ")).toBe(
      'No card "card-gone" is on the record. Read the id again.',
    );
  });
});

describe("a crewmate's merge cards and refusals", () => {
  const MERGE_REQUEST = {
    title: "Merge the level editor's pull request",
    body: "<p>The level editor's pull request is reviewed.</p>",
    // INF-2744: the crewmate declares only the merge; the host writes the
    // Not now beside a merge that keeps the task open.
    actions: [
      {
        id: "",
        label: "",
        effect: { kind: "merge" as const, review: "mr-1", after: "continue" as const },
      },
    ],
  };

  it("holds a merge card naming a review on the review gate's refusal, and puts it up with the host's buttons when the gate passes it (INF-2744)", async () => {
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
      expect.objectContaining({ id: MERGE_NOT_NOW_ID, label: MERGE_NOT_NOW_WORDS }),
      expect.objectContaining({
        id: "merge",
        default: true,
        effect: { kind: "merge", review: "mr-1", after: "continue" },
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
        { id: "merge", label: "", effect: { kind: "merge" as const, after: "close" as const } },
      ],
    };
    await expect(h.emitCard.run(merge)).rejects.toThrow("Card refused: declare required_actions");
    expect(h.tasks.get(h.taskId)?.delivery?.cardRefusal).toMatchObject({
      title: "The game is ready",
      reason: "shape",
      why: "required_actions is missing",
    });

    const answer = await crewmateOn();
    const answerTask = await answer.supervisor.intake.commission({
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

  // That a live change task owes its card until one is up, and an unknown task
  // none, is crewmateCards.completion.test.ts's fact; this case owns the shapes.
  it("says a task's crewmate owes no completion card on review, in-place, answer or queued work", async () => {
    const h = await crewmateOn();
    const seeded = (id: string, shape: Parameters<typeof seedTask>[1]["shape"]) => {
      seedTask(h.tasks, { id, title: id, status: "running", shape });
      return h.supervisor.crewmateCards.crewmateOwesCompletion(id);
    };
    expect(seeded("t-change", { kind: "unclear", deliverable: "change" })).toBe(true);
    expect(seeded("t-review", { kind: "review", deliverable: "change" })).toBe(false);
    expect(
      seeded("t-in-place", { kind: "unclear", deliverable: "change", in_place: { folder: true } }),
    ).toBe(false);
    expect(seeded("t-answer", { kind: "unclear", deliverable: "answer" })).toBe(false);
    seedTask(h.tasks, { id: "t-queued", title: "t-queued", status: "queued" });
    expect(h.supervisor.crewmateCards.crewmateOwesCompletion("t-queued")).toBe(false);
  });
});

/**
 * A task whose Careful review and live proof passed, as INF-3323's stood when
 * its merge card would not go up: the proof its report tool kept in the
 * task's cards folder, the passed review, and a published story whose
 * validation table shows that proof. Its completion stand-in does what the
 * story service's does: each call mints a fresh copy of the story's picture
 * for that card alone and draws the story with it.
 */
async function reviewedWithProof() {
  const head = "5ca2d466ee21f9733827383f23df81f3874e0d10";
  const poster = DEMO_POSTER.bytes;
  if (!poster) throw new Error("The demo poster must supply its bytes.");
  const digest = createHash("sha256").update(poster).digest("hex");
  let cards = "";
  let story: ChangePresentation | undefined;
  let record: LiveValidation | undefined;
  const minted: string[] = [];
  const completionPresentation = vi.fn(async (taskId: string) => {
    if (!story) throw new Error("No story is saved yet.");
    const id = `${taskId}-${randomBytes(16).toString("hex")}`;
    writeFileSync(join(cards, `${id}.png`), poster);
    minted.push(`${id}.png`);
    const shown: ChangePresentation = {
      ...story,
      assets: story.assets.map((asset) => ({ ...asset, id, file: `${id}.png` })),
      views: story.views.map((view) => ({
        ...view,
        after: view.after.map((entry) => ({ ...entry, asset: id })),
      })),
      pictures: story.pictures.map((picture) => ({ ...picture, id })),
      // Each row's proof, from the task's record as the story service reads it.
      ...(story.liveValidation
        ? {
            liveValidation: {
              ...story.liveValidation,
              rows: story.liveValidation.rows.map((row) => ({
                ...row,
                evidence: readKeptValidationEvidence(
                  liveValidationSummary(record, story?.head, false)?.rows.find(
                    (item) => item.id === row.id,
                  )?.evidence ?? [],
                  cards,
                  taskId,
                ),
              })),
            },
          }
        : {}),
    };
    return {
      title: shown.title,
      body: presentationCardBody(shown),
      pictures: shown.pictures,
      riskDeclaration: shown.risk,
      requiredActions: shown.requiredActions,
    };
  });
  const h = await crewmateOn({ completionPresentation, checkCi: async () => "green" });
  vi.spyOn(h.supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
  vi.spyOn(h.supervisor.facts, "taskAutonomy").mockReturnValue(false);
  vi.mocked(h.workspace.branchHead).mockResolvedValue(head);
  cards = join(h.paths.crewmatesDir, h.taskId, "cards");
  mkdirSync(cards, { recursive: true });

  // The builder's selected proof, kept the way its report tool keeps a run's.
  const evidenceDir = scratchDir("infinitary-proof-evidence-");
  writeFileSync(join(evidenceDir, "popover.png"), poster);
  const run = await keepValidationEvidence(
    {
      kind: "run",
      id: "phone-check",
      head,
      scenarioRevision: 1,
      completion: "complete",
      verdict: "go",
      reason: "The phone check ran the notes journey on the iPhone simulator.",
      observations: [
        {
          scenario: "point-at",
          result: "pass",
          live: true,
          actual: "The paragraph lit and its popover held the typed comment.",
          evidence: ["popover"],
          standIns: [],
          unproven: [],
          attempted: [],
        },
      ],
      evidence: [
        {
          id: "popover",
          path: join(evidenceDir, "popover.png"),
          description: "The lit paragraph and its note popover",
        },
      ],
    },
    { taskId: h.taskId, worktree: scratchDir("infinitary-proof-work-"), dir: cards, evidenceDir },
  );
  if (run.kind !== "run") throw new Error("Expected a kept run");
  let proof = recordValidation(
    undefined,
    {
      kind: "plan",
      previousRevision: 0,
      reason: "The change adds note popovers to the phone's cards.",
      scenarios: [
        {
          id: "point-at",
          source: "Point at a part of a card and add a comment.",
          importance: "required",
          action: "Tap Point at, tap a paragraph, type a comment and queue it.",
          expected: "The paragraph lights and the popover keeps the comment.",
          adverse: "No note is sent before the reply.",
          environment: "The phone check's simulator against its scripted home.",
          signal: "The popover shows the typed comment.",
          boundary: "Card frame and its popover",
        },
      ],
    },
    { head, deviceId: null, at: 1 },
  );
  proof = recordValidation(proof, run, { head, deviceId: null, at: 2 });
  const revision = proof.runs.at(-1)?.revision ?? 0;
  proof = recordValidation(
    proof,
    {
      kind: "review",
      head,
      revision,
      code: "clear",
      coverage: "complete",
      coverageReason: "The scenario covers the requested notes.",
      effects: [],
      omitted: [],
      verdict: "go",
      reason: "Read the change and the kept proof.",
    },
    {
      head,
      deviceId: null,
      at: 3,
      reviewer: "reviewer",
      assignment: { head, revision, scenarioRevision: proof.scenarioRevision, effects: [] },
    },
  );
  record = proof;
  seedDelivery(h.tasks, h.taskId, {
    reviewVerdict: "pass",
    liveValidation: proof,
    headSha: head,
    prNumber: 1,
    ci: "green",
  });

  // The story's own picture, kept where preparing the story keeps it.
  const assetId = `${h.taskId}-${"d".repeat(32)}`;
  writeFileSync(join(cards, `${assetId}.png`), poster);
  const validationRows = [
    {
      id: "point-at",
      scenario: "Point at a paragraph and queue a note",
      evidence: "The popover kept the typed comment.",
    },
  ];
  story = {
    version: 2,
    taskId: h.taskId,
    revision: 1,
    destination: {
      host: "github.com",
      projectId: 1,
      fullName: "octo/notes",
      visibility: "private",
    },
    title: "feat: annotate card parts on the phone",
    base: head,
    head,
    why: ["Notes on a card's parts reached only the Mac."],
    whatChanged: ["The phone's cards take notes on a part or on selected words."],
    before: ["The phone could only reply to a card."],
    after: ["The phone queues notes and sends them with one reply."],
    views: [
      {
        id: "popover",
        caption: "A note on a paragraph",
        kind: "new",
        before: [],
        after: [
          { asset: assetId, alt: "The lit paragraph and its note popover", captureHead: head },
        ],
      },
    ],
    validationRows,
    liveValidation: presentationValidation(proof, head, validationRows),
    verification: ["The phone check passed on the iPhone simulator."],
    risk: METER_RISK,
    requiredActions: [],
    unfinished: [],
    projectText: "",
    assets: [
      {
        id: assetId,
        file: `${assetId}.png`,
        mediaType: "image/png",
        sourceSha256: digest,
        uploadSha256: digest,
        bytes: poster.length,
        width: DEMO_POSTER.width,
        height: DEMO_POSTER.height,
      },
    ],
    pictures: [
      {
        id: assetId,
        sha256: digest,
        alt: "The lit paragraph and its note popover",
        width: DEMO_POSTER.width,
        height: DEMO_POSTER.height,
        group: 0,
      },
    ],
  };
  const saved = story;
  const published = {
    state: "confirmed" as const,
    revision: 1,
    number: 1,
    head,
    region: "story",
    regionHash: createHash("sha256").update("story").digest("hex"),
  };
  h.tasks.delivery.updateChangePresentation(h.taskId, () => ({
    revisions: [saved],
    receipts: [],
    publication: published,
    published,
  }));
  return { ...h, cards, minted, proof: run.evidence[0]!.file, poster, story: `${assetId}.png` };
}

describe("a refused saved-story merge card", () => {
  const MERGE = {
    title: "feat: annotate card parts on the phone",
    presentation: 1,
    actions: [
      { id: "merge", default: true, effect: { kind: "merge" as const, after: "close" as const } },
    ],
  };

  // INF-3060: a refused differing risk copy takes the story's media copies with it.
  it.each(["unpublished", "unreadable change", "a differing risk copy"])(
    "removes completion copies after %s refuse the card (INF-228 F3, INF-3060)",
    async (refusal) => {
      let taskId = "";
      let dir = "";
      const pictureId = () => `${taskId}-${"a".repeat(32)}`;
      const recordingId = () => `${taskId}-${"b".repeat(32)}`;
      const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      // The story service's answer: the body it drew, and the copies it minted for this card.
      const completionPresentation = vi.fn(async () => {
        if (!DEMO_POSTER.bytes) throw new Error("Missing poster fixture");
        writeFileSync(join(dir, `${pictureId()}.png`), DEMO_POSTER.bytes);
        writeFileSync(join(dir, `${recordingId()}.mp4`), DEMO_RECORDING.bytes);
        return {
          title: "The story is ready",
          body: completionBody(
            `<figure data-inf-demo="app-frame://media/${recordingId()}.mp4"><img src="app-frame://images/${pictureId()}.png" alt="The box at its starting place"></figure>`,
          ),
          pictures: [
            {
              id: pictureId(),
              sha256: sha256(DEMO_POSTER.bytes),
              alt: "The box at its starting place",
              width: DEMO_POSTER.width,
              height: DEMO_POSTER.height,
              group: 0,
              demo: {
                id: recordingId(),
                kind: "mp4" as const,
                width: DEMO_RECORDING.width,
                height: DEMO_RECORDING.height,
                durationMs: DEMO_RECORDING.durationMs,
                bytes: DEMO_RECORDING.bytes.length,
                sha256: sha256(DEMO_RECORDING.bytes),
              },
            },
          ],
          riskDeclaration: METER_RISK,
          requiredActions: [],
        };
      });
      const { supervisor, tasks, specs, cards, paths } = setup(fakeCrewmate(), {
        completionPresentation,
        checkCi: async () => ({
          overall: "pending",
          recorded: false,
          problem: "The proposed change could not be read",
        }),
      });
      ({ taskId } = await supervisor.intake.commission({
        title: "Share the story",
        intent: intentOf("share the same story"),
        shape: { rigor_ask: "quick" },
      }));
      await tick();
      vi.spyOn(supervisor.facts, "taskDelivery").mockReturnValue("direct-pr");
      dir = join(paths.crewmatesDir, taskId, "cards");
      mkdirSync(dir, { recursive: true });
      // An earlier card's independent copy must survive this later refusal.
      const earlier = `${taskId}-${"c".repeat(32)}.mp4`;
      writeFileSync(join(dir, earlier), DEMO_RECORDING.bytes);
      if (refusal !== "unpublished")
        tasks.delivery.updateChangePresentation(taskId, () => ({
          revisions: [],
          receipts: [],
          published: {
            state: "confirmed",
            revision: 1,
            number: 1,
            head: "5ca2d466ee21f9733827383f23df81f3874e0d10",
            region: "story",
            regionHash: createHash("sha256").update("story").digest("hex"),
          },
        }));
      await expect(
        specs[0]?.onCard?.({
          title: "The story is ready",
          body: "",
          presentationRevision: 1,
          actions: [{ id: "merge", effect: SETTLE_MERGE }],
          ...(refusal === "a differing risk copy"
            ? { riskDeclaration: { ...METER_RISK, blast: { level: "high", why: "Every file" } } }
            : {}),
        }),
      ).rejects.toThrow(
        refusal === "unpublished"
          ? /not been published/
          : refusal === "unreadable change"
            ? /The proposed change could not be read/
            : /those facts come from its saved revision/,
      );
      expect(cards()).toHaveLength(0);
      expect(readdirSync(dir)).toEqual([earlier]);
      expect(readFileSync(join(dir, earlier))).toEqual(DEMO_RECORDING.bytes);
    },
  );

  // INF-3323: one refused merge card took the live proof its validation table
  // shows, and every merge card after it was refused with "ENOENT ... lstat"
  // on that proof, even a story with no pictures of its own.
  it("takes only the copy minted for it, so the next merge card re-reads the live proof and goes up (INF-3323)", async () => {
    const h = await reviewedWithProof();
    await expect(
      h.emitCard.run({
        ...MERGE,
        risk: { ...METER_RISK, blast: { level: "high", why: "Every file" } },
      }),
    ).rejects.toThrow(/those facts come from its saved revision/);
    expect(h.own()).toEqual([]);
    // The refused card's own copy went with it; the proof and the story's picture stayed.
    expect(h.minted).toHaveLength(1);
    expect(existsSync(join(h.cards, h.minted[0]!))).toBe(false);
    expect(readFileSync(join(h.cards, h.proof))).toEqual(h.poster);
    expect(readFileSync(join(h.cards, h.story))).toEqual(h.poster);

    await h.emitCard.run(MERGE);
    const shown = h.own()[0];
    expect(shown?.title).toBe(MERGE.title);
    expect(shown?.body).toContain(`app-frame://images/${h.proof}`);
    expect(shown?.body).toContain(`app-frame://images/${h.minted[1]}`);
    expect(readdirSync(h.cards).sort()).toEqual([h.proof, h.story, h.minted[1]].sort());
  });

  // INF-3672: INF-1894's merge card kept failing with "ENOENT ... lstat" on
  // a proof picture an earlier build's refused card had taken, though the
  // task's folder still held another copy of exactly that picture.
  it("copies a lost proof picture again from an identical copy, and the merge card goes up (INF-3672)", async () => {
    const h = await reviewedWithProof();
    // The story's own picture is the same screenshot as the proof.
    rmSync(join(h.cards, h.proof));
    await h.emitCard.run(MERGE);
    const shown = h.own()[0];
    expect(shown?.title).toBe(MERGE.title);
    expect(shown?.body).toContain(`app-frame://images/${h.proof}`);
    expect(readFileSync(join(h.cards, h.proof))).toEqual(h.poster);
    expect(readFileSync(join(h.cards, h.story))).toEqual(h.poster);
  });
});

describe("integration calls held for the captain", () => {
  it("puts a task's held call on its own card, and none for a task that has closed", async () => {
    const h = await crewmateOn();
    // The service keeps a task's ask on its record before presenting it.
    const held = heldCall("ia000000000010");
    h.tasks.delivery.keepWriteAsk(h.taskId, held);
    h.supervisor.integrationAsks.askIntegration(h.taskId, held);
    expect(h.own()).toEqual([
      expect.objectContaining({ author: "host", title: "Allow Add a note on Notes?" }),
    ]);
    seedTask(h.tasks, { id: "t-closed", title: "Old notes", status: "running" });
    h.tasks.close("t-closed", { status: "dropped", reason: "cancelled", actor: "host" });
    h.supervisor.integrationAsks.askIntegration("t-closed", heldCall("ia000000000011"));
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
    const cardId = h.supervisor.integrationAsks.askIntegrationForPanel(ask);
    const row = h.tasks.capture.openCardTaskFor(cardId);
    expect(row?.delivery?.writeAsks).toEqual([expect.objectContaining({ id: ask.id })]);
    expect(
      h.supervisor.cards.snapshot().find((card) => card.id === cardId)?.taskId,
    ).toBeUndefined();

    h.supervisor.cardActions.act(cardId, "once");
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
    const cardId = h.supervisor.integrationAsks.askIntegrationForFirstmate(ask);
    const row = h.tasks.capture.openCardTaskFor(cardId);
    h.supervisor.cardActions.act(cardId, "once");
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
