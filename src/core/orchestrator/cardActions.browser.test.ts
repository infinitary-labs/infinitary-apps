/**
 * The captain's card actions on a task's browser (docs/task-browser.md):
 * taking the browser over and returning control, a saved sign-in offered on
 * a request card, and a card's browser button.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import type { Card } from "@shared/cards";
import {
  SAVED_SIGN_IN_FAILED_LABEL,
  SIGN_IN_MYSELF_LABEL,
  savedSignInLabel,
  type TaskBrowserFact,
  USE_SAVED_SIGN_IN_ACTION,
} from "@shared/taskBrowser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { BROWSER_SIGN_IN_STEP, EMIT_CARD_TOOL } from "../pi/cardTool";
import { CREWMATE_BROWSER_LINE } from "../pi/piResources";
import { bindTool } from "../session/tools";
import type { TaskRecord } from "../storage/taskRecords";
import { THREAD_BROWSER_HELD } from "./captainWakes";
import type { CrewmateSpec } from "./crewSession";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

describe('the captain takes a task\'s browser over (docs/task-browser.md, "Taking control")', () => {
  // On the host's one clock: the case moves `hostNow`; nothing fakes a timer.
  let hostNow = 0;
  const hostClock = () => hostNow;
  beforeEach(() => {
    vi.useRealTimers();
    hostNow = Date.now();
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const minutes = (n: number) => n * 60_000;

  const OPEN: TaskBrowserFact = {
    state: "open",
    site: "aurora.example",
    url: "http://aurora.example/signin",
    title: "Sign in",
    session: "run-1",
    generation: 2,
  };
  const HANDOFF = {
    site: "aurora.example",
    reason: "Aurora needs your account to hold the fare",
    after: "fill in the passenger details",
  };
  const REQUEST = {
    title: "Sign in to aurora.example to continue the booking",
    body: "<p>Aurora needs your account to hold the fare, so I paused the browser on its sign-in page.</p><p>While you have control I cannot see the page, and your typing is not recorded.</p>",
    browser_handoff: HANDOFF,
    actions: [
      { id: "leave", label: "Leave waiting" },
      {
        id: "sign-in",
        label: BROWSER_SIGN_IN_STEP,
        default: true,
        effect: { kind: "open" as const, target: "browser" as const },
      },
    ],
  };

  /** A crewmate on this Mac whose browser the stand-in holds, in its first turn. */
  async function crewmateWithBrowser(
    answers: {
      requestHelp?: () => Promise<
        { ok: true; handle: { session: string; generation: number } } | { ok: false; text: string }
      >;
      /** The sign-in this Mac has saved for the browser's site, if any. */
      saved?: { site: string; savedAt: number; failedAt?: number };
      /** Whether the browser uses a save its crewmate's word can mark. */
      marks?: boolean;
      grant?: () => Promise<{ ok: true } | { ok: false; text: string }>;
      /** A read-only check whose deliverable is an answer (INF-1317), not a booking. */
      readOnly?: boolean;
    } = {},
  ) {
    const crewmate = fakeCrewmate();
    const held = { current: false };
    /** The task's browser fact as the stand-in holds it now; a case moves it. */
    const shown: { fact: TaskBrowserFact | undefined } = { fact: OPEN };
    const calls: string[] = [];
    const browsers = {
      forTask: () => ({
        navigate: vi.fn(async () => ({ text: "opened" })),
        inspect: vi.fn(async () => ({ text: "read" })),
        act: vi.fn(async () => ({ text: "used" })),
        capture: vi.fn(async () => ({ text: "photographed" })),
        close: vi.fn(async () => ({ text: "stopped" })),
        pages: vi.fn(async () => ({ text: "one page" })),
      }),
      fact: () => shown.fact,
      withCaptain: () => held.current,
      requestHelp: vi.fn(async (taskId: string) => {
        calls.push(`pause ${taskId}`);
        held.current = true;
        return answers.requestHelp
          ? answers.requestHelp()
          : { ok: true as const, handle: { session: "run-1", generation: 2 } };
      }),
      takeControl: vi.fn(
        async (): Promise<{ ok: true } | { ok: false; text: string }> => ({ ok: true }),
      ),
      savedSignInFor: vi.fn((_taskId: string, site: string) =>
        answers.saved && answers.saved.site === site ? answers.saved : undefined,
      ),
      markSavedSignInFailed: vi.fn((_taskId: string, _site: string) => {
        calls.push("mark");
        return answers.marks ?? false;
      }),
      grantSavedSignIn: vi.fn(
        async (): Promise<{ ok: true } | { ok: false; text: string }> =>
          answers.grant ? answers.grant() : { ok: true },
      ),
    };
    const h = setup(crewmate, {
      now: hostClock,
      browsers,
      ...(answers.readOnly
        ? {
            classifier: {
              classify: async () =>
                ({ kind: "research", source: "classifier:test", version: "kc1" }) as const,
            },
          }
        : {}),
    });
    const { taskId } = await h.supervisor.intake.commission(
      answers.readOnly
        ? {
            title: "Check Microsoft account readiness for Windows signing",
            intent: {
              ...intentOf(
                "a read-only report on whether my Microsoft directory, paid Azure subscription and Individual billing can serve Artifact Signing Basic",
              ),
              constraints: [{ kind: "read-only" }],
            },
          }
        : {
            title: "Help me book a flight to Lisbon",
            intent: intentOf("help me book a flight to Lisbon"),
          },
    );
    await tick();
    /** The turn ends: a card it emitted goes on the stage. */
    const endTurn = async () => {
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await tick();
    };
    const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
    const saved = () => h.cardStore.listOpen().find((card) => card.taskId === taskId);
    return { ...h, crewmate, taskId, emitCard, saved, browsers, held, shown, calls, endTurn };
  }

  /**
   * INF-1317 (INF-1322): a read-only check asked the captain to sign in to
   * Azure, and his "Open browser and sign in" closed the task answered,
   * which stopped the browser he had just taken. A hand-off card is never
   * an answer task's answer: the click hands the browser over and the task
   * waits for Return control, and any other choice reaches the crewmate.
   */
  it("keeps a read-only answer task open when the captain chooses on its browser hand-off card", async () => {
    const h = await crewmateWithBrowser({ readOnly: true });
    expect(h.tasks.get(h.taskId)?.shape).toMatchObject({ deliverable: "answer" });
    await h.emitCard.run(REQUEST);
    h.specs.at(-1)?.onReport?.("The sign-in card is up; I resume when control returns.");
    await h.endTurn();
    const card = h.saved() as Card;
    expect(card.attachment).toMatchObject({ kind: "browser", handoff: true });

    const result = h.supervisor.cardActions.act(card.id, "sign-in");
    await tick();
    expect(result.effect).toMatchObject({ kind: "open", target: "browser" });
    expect(h.browsers.takeControl).toHaveBeenCalledWith(h.taskId, {
      session: "run-1",
      generation: 2,
    });
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });

    // "Leave waiting" on a second hand-off card goes back to the crewmate.
    await h.emitCard.run(REQUEST);
    h.specs.at(-1)?.onReport?.("The sign-in card is up again.");
    await h.endTurn();
    const again = h.saved() as Card;
    h.supervisor.cardActions.act(again.id, "leave");
    await tick();
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "active", closedReason: null });
    expect(h.crewmate.steer).toHaveBeenCalledTimes(1);
    expect(h.crewmate.steer.mock.calls[0]?.[0]).toContain('chose "Leave waiting"');
  });

  // INF-4585's plan: a sign-in request opens its site in the kept profile, so the host
  // carries the crewmate's declared sign-in to the browser it pauses.
  it("carries the crewmate's sign-in mark to the paused browser, and nothing without it", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run({ ...REQUEST, browser_sign_in: true });
    expect(h.browsers.requestHelp).toHaveBeenLastCalledWith(h.taskId, { ...HANDOFF, signIn: true });
  });

  it("pauses the browser before the request card goes up, and the captain's click hands it over in silence", async () => {
    const h = await crewmateWithBrowser();
    h.browsers.requestHelp.mockImplementationOnce(async (taskId: string) => {
      // The card is not up yet while the browser pauses.
      h.calls.push(`pause ${taskId} with ${h.saved() ? "a card" : "no card"}`);
      h.held.current = true;
      return { ok: true, handle: { session: "run-1", generation: 2 } };
    });
    const answer = await h.emitCard.run(REQUEST);
    expect(h.calls).toEqual([`pause ${h.taskId} with no card`]);
    expect(h.browsers.requestHelp).toHaveBeenCalledWith(h.taskId, HANDOFF);
    expect(answer.text).toContain("Your browser is paused for the captain");
    const card = h.saved();
    // The site the strip names is the host's; the crewmate named no door, so it reads Open browser.
    expect(card?.attachment).toEqual({
      kind: "browser",
      label: "Open browser",
      taskId: h.taskId,
      session: "run-1",
      generation: 2,
      handoff: true,
    });
    expect(card?.actions.find((action) => action.id === "sign-in")?.effect).toEqual({
      kind: "open",
      target: "browser",
    });
    await h.endTurn();
    const prompts = h.crewmate.promptCalls.length;
    // A script in the body can never press it.
    expect(() => h.supervisor.cardActions.act(card?.id ?? "", "sign-in", "frame")).toThrow(
      "This action is available only from the card controls.",
    );
    expect(h.browsers.takeControl).not.toHaveBeenCalled();

    // The captain's click takes the card's own browser and opens its view.
    expect(h.supervisor.cardActions.act(card?.id ?? "", "sign-in")).toEqual({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: h.taskId, session: "run-1", generation: 2, cardId: card?.id },
      },
    });
    expect(h.browsers.takeControl).toHaveBeenCalledWith(h.taskId, {
      session: "run-1",
      generation: 2,
    });
    await tick();
    // The request stays with the page (INF-4578): the click answers nothing.
    expect(h.saved()?.id).toBe(card?.id);
    expect(h.supervisor.cards.snapshot().map((shown) => shown.id)).toContain(card?.id);
    // The crewmate hears nothing of it; with its browser in his hands it is
    // his turn, so the idle ladder never nudges it.
    expect(h.crewmate.steer).not.toHaveBeenCalled();
    expect(h.supervisor.postures.workPosture(h.tasks.get(h.taskId) as TaskRecord)).toEqual({
      state: "idle",
      reason: "captain",
    });
    hostNow += minutes(45);
    h.supervisor.watch.reconcileIdle(hostNow);
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(prompts);
  });

  // INF-4578: the captain lost the steps on the card once the page opened,
  // and had no way to ask the crewmate while looking at the page.
  it("keeps the request beside the page until Return control, which carries the captain's words once", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run({ ...REQUEST, id: "sign-in-card" });
    await h.endTurn();
    const card = h.saved() as Card;
    h.supervisor.cardActions.act(card.id, "sign-in");
    await tick();
    h.shown.fact = { ...OPEN, control: "captain" };
    expect(h.saved()?.id).toBe(card.id);

    // A reply from beside the page tells the crewmate who holds its browser.
    h.supervisor.cardActions.replyToCard(card.id, "Which email should I use?");
    await tick();
    expect(h.crewmate.promptCalls.at(-1)).toContain(THREAD_BROWSER_HELD);
    expect(h.crewmate.promptCalls.at(-1)).toContain("Which email should I use?");
    await h.endTurn();
    expect(h.saved()?.id).toBe(card.id);

    // Return control with words left in the field: the card leaves, and the
    // one wake carries the words.
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.cardActions.holdReturnWords(h.taskId, "  I used my work email.  ");
    const returned = {
      site: "aurora.example",
      after: HANDOFF.after,
      once: "browser-returned:run-1:2:1",
    };
    h.supervisor.cardActions.browserReturned(h.taskId, returned);
    await tick();
    expect(h.saved()).toBeUndefined();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "browser-returned",
          site: "aurora.example",
          after: HANDOFF.after,
          words: "I used my work email.",
        },
      }),
    );
    // The words went with that return: the next one carries none.
    await h.endTurn();
    h.supervisor.cardActions.browserReturned(h.taskId, {
      ...returned,
      once: "browser-returned:run-1:2:2",
    });
    await tick();
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: { kind: "browser-returned", site: "aurora.example", after: HANDOFF.after },
      }),
    );
  });

  it("redraws a request revised under its id while the captain holds its browser, and refuses a new one", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run({ ...REQUEST, id: "sign-in-card" });
    await h.endTurn();
    const card = h.saved() as Card;
    h.supervisor.cardActions.act(card.id, "sign-in");
    await tick();
    h.shown.fact = { ...OPEN, control: "captain" };
    expect(h.browsers.requestHelp).toHaveBeenCalledTimes(1);

    const answer = await h.emitCard.run({
      ...REQUEST,
      id: card.id,
      body: "<p>Choose Organization and use the company name from the infinitary-business project.</p>",
    });
    expect(answer.text).toContain("reads this card beside its page");
    expect(h.browsers.requestHelp).toHaveBeenCalledTimes(1);
    expect(h.saved()?.id).toBe(card.id);
    expect(h.saved()?.body).toContain("Choose Organization");

    // A request under a new id asks again, which the browser refuses while he holds it.
    h.browsers.requestHelp.mockResolvedValueOnce({
      ok: false,
      text: "the captain already has control of this task's browser.",
    });
    await expect(h.emitCard.run({ ...REQUEST, id: "another-request" })).rejects.toThrow(
      "the captain already has control",
    );
  });

  it("takes the request down and tells the crewmate when its browser is gone before he holds it", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run(REQUEST);
    await h.endTurn();
    const card = h.saved() as Card;
    const prompts = h.crewmate.promptCalls.length;
    // The browser stops between the click and the take.
    h.browsers.takeControl.mockImplementationOnce(async () => {
      h.shown.fact = {
        state: "stopped",
        site: "aurora.example",
        url: OPEN.url,
        stopped: "crewmate",
        at: hostNow,
        session: "run-1",
        generation: 2,
      };
      return { ok: false, text: "This browser stopped before you had control." };
    });
    h.supervisor.cardActions.act(card.id, "sign-in");
    await tick();
    await tick();
    expect(h.saved()).toBeUndefined();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { title: REQUEST.title },
          choice: { id: "sign-in", label: BROWSER_SIGN_IN_STEP },
          browserGone: "stopped",
        },
      }),
    );
  });

  it("tells the crewmate the captain's choice when the card's browser ended with the app's quit", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run(REQUEST);
    const card = h.saved();
    await h.endTurn();
    const prompts = h.crewmate.promptCalls.length;
    // The app quit and started again: this run has no browser for the task yet.
    h.shown.fact = undefined;
    h.held.current = false;
    h.browsers.takeControl.mockResolvedValueOnce({
      ok: false,
      text: "This browser is no longer running, so there is nothing to take.",
    });
    // The click still answers the card and opens the view, which says the card's browser stopped.
    expect(h.supervisor.cardActions.act(card?.id ?? "", "sign-in")).toEqual({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: h.taskId, session: "run-1", generation: 2, cardId: card?.id },
      },
    });
    await tick();
    await tick();
    expect(h.saved()).toBeUndefined();
    // Its crewmate hears the choice and that its browser was gone, once, on its lane.
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { title: REQUEST.title },
          choice: { id: "sign-in", label: BROWSER_SIGN_IN_STEP },
          browserGone: "quit",
        },
      }),
    );
    expect(
      h.tasks
        .timeline(h.taskId)
        .filter((event) => event.kind === "steered")
        .map((event) => event.actor),
    ).toEqual(["captain"]);
    expect(h.events).toContainEqual({
      type: "firstmate_note",
      text: `The card's browser for "Help me book a flight to Lisbon" had stopped when Infinitary quit, so its crewmate is told to open the site again and ask you anew.`,
      taskId: expect.any(String),
    });
  });

  it("tells the crewmate when the card's browser stopped and a newer one followed it", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run(REQUEST);
    const card = h.saved();
    await h.endTurn();
    // Stopped and opened again in this run: the task's browser is a newer one.
    h.shown.fact = { ...OPEN, generation: 3 };
    h.held.current = false;
    h.browsers.takeControl.mockResolvedValueOnce({
      ok: false,
      text: "This browser is no longer running, so there is nothing to take.",
    });
    h.supervisor.cardActions.act(card?.id ?? "", "sign-in");
    await tick();
    await tick();
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { title: REQUEST.title },
          choice: { id: "sign-in", label: BROWSER_SIGN_IN_STEP },
          browserGone: "stopped",
        },
      }),
    );
    expect(h.events).toContainEqual({
      type: "firstmate_note",
      text: `The card's browser for "Help me book a flight to Lisbon" had stopped, so its crewmate is told to open the site again and ask you anew.`,
      taskId: expect.any(String),
    });
  });

  it("tells the crewmate, never naming the saved sign-in, when a grant finds the card's browser stopped", async () => {
    const h = await crewmateWithBrowser({
      saved: { site: "aurora.example", savedAt: Date.parse("2026-10-02T09:00:00Z") },
      grant: async () => ({
        ok: false,
        text: "This browser is no longer running, so it cannot use your saved sign-in.",
      }),
    });
    await h.emitCard.run(REQUEST);
    const card = h.saved();
    await h.endTurn();
    const prompts = h.crewmate.promptCalls.length;
    // The captain stopped it from the view, and nothing opened it again.
    h.shown.fact = {
      state: "stopped",
      site: "aurora.example",
      url: OPEN.url,
      stopped: "captain",
      at: hostNow,
      session: "run-1",
      generation: 2,
    };
    h.held.current = false;
    h.supervisor.cardActions.act(card?.id ?? "", USE_SAVED_SIGN_IN_ACTION);
    await tick();
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    const told = h.crewmate.promptCalls.at(-1) ?? "";
    expect(told).toBe(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "chrome",
          card: { title: REQUEST.title },
          choice: { id: USE_SAVED_SIGN_IN_ACTION, label: savedSignInLabel("aurora.example") },
          browserGone: "stopped",
        },
      }),
    );
    // The crewmate never learns which sites this Mac keeps a sign-in for.
    expect(told).not.toContain("saved");
    // The feed no longer says the browser is still paused for him.
    expect(h.events).toContainEqual({
      type: "firstmate_note",
      text: `The card's browser for "Help me book a flight to Lisbon" had stopped, so its crewmate is told to open the site again and ask you anew.`,
      taskId: expect.any(String),
    });
    expect(
      h.events.some(
        (event) => event.type === "firstmate_note" && event.text.includes("still paused for you"),
      ),
    ).toBe(false);
  });

  it("refuses a request it cannot pause for, and an open-browser action with no request, in words", async () => {
    const h = await crewmateWithBrowser({
      requestHelp: async () => ({
        ok: false,
        text: "browser_handoff names aurora.example, but this task's browser is on skyfare.example. Name the site it is on.",
      }),
    });
    await expect(h.emitCard.run(REQUEST)).rejects.toThrow(
      "Card refused: browser_handoff names aurora.example, but this task's browser is on skyfare.example. Name the site it is on.",
    );
    const { browser_handoff: _request, ...noRequest } = REQUEST;
    await expect(h.emitCard.run(noRequest)).rejects.toThrow(
      /an action that opens this task's browser for the captain needs browser_handoff/,
    );
    await expect(
      h.emitCard.run({ ...REQUEST, browser_handoff: { ...HANDOFF, after: "  " } }),
    ).rejects.toThrow(/browser_handoff needs site, reason and after/);
    await expect(
      h.emitCard.run({
        ...REQUEST,
        actions: [{ id: "leave", label: "Leave waiting", default: true }],
      }),
    ).rejects.toThrow(/exactly one action whose effect is/);
    expect(h.saved()).toBeUndefined();
    expect(h.browsers.requestHelp).toHaveBeenCalledTimes(1);
  });

  it("offers this Mac's saved sign-in for the site as the request card's default, beside Sign in myself", async () => {
    const h = await crewmateWithBrowser({
      saved: { site: "aurora.example", savedAt: Date.parse("2026-10-02T09:00:00Z") },
    });
    await h.emitCard.run(REQUEST);
    expect(h.browsers.savedSignInFor).toHaveBeenCalledWith(h.taskId, "aurora.example");
    const card = h.saved();
    expect(
      card?.actions.map(({ id, label, default: chosen, effect }) => ({
        id,
        label,
        ...(chosen ? { default: true } : {}),
        ...(effect ? { effect } : {}),
      })),
    ).toEqual([
      { id: "leave", label: "Leave waiting" },
      {
        id: "sign-in",
        label: SIGN_IN_MYSELF_LABEL,
        effect: { kind: "open", target: "browser" },
      },
      {
        id: USE_SAVED_SIGN_IN_ACTION,
        label: savedSignInLabel("aurora.example"),
        default: true,
        effect: { kind: "open", target: "browser", savedSignIn: true },
      },
    ]);
    await h.endTurn();
    // A script in the body can never press it.
    expect(() =>
      h.supervisor.cardActions.act(card?.id ?? "", USE_SAVED_SIGN_IN_ACTION, "frame"),
    ).toThrow("available only from the card controls");
    // The captain's click gives the card's own browser the saved sign-in and opens its view;
    // the captain never takes control.
    expect(h.supervisor.cardActions.act(card?.id ?? "", USE_SAVED_SIGN_IN_ACTION)).toEqual({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: h.taskId, session: "run-1", generation: 2, cardId: card?.id },
      },
    });
    expect(h.browsers.grantSavedSignIn).toHaveBeenCalledWith(h.taskId, {
      session: "run-1",
      generation: 2,
    });
    expect(h.browsers.takeControl).not.toHaveBeenCalled();
    await tick();
    expect(h.saved()).toBeUndefined();
  });

  // INF-1849, the captain's answer: after a save fails, keep it as a second
  // choice that says it did not work last time; Sign in myself is the default.
  it("leads with Sign in myself and keeps a save a crewmate marked as a second choice that says it did not work", async () => {
    const h = await crewmateWithBrowser({
      saved: {
        site: "aurora.example",
        savedAt: Date.parse("2026-10-02T09:00:00Z"),
        failedAt: Date.parse("2026-10-03T09:00:00Z"),
      },
    });
    await h.emitCard.run(REQUEST);
    expect(
      h.saved()?.actions.map(({ id, label, default: chosen }) => ({
        id,
        label,
        ...(chosen ? { default: true } : {}),
      })),
    ).toEqual([
      { id: "leave", label: "Leave waiting" },
      { id: USE_SAVED_SIGN_IN_ACTION, label: SAVED_SIGN_IN_FAILED_LABEL },
      // The default stands last in the row.
      { id: "sign-in", label: SIGN_IN_MYSELF_LABEL, default: true },
    ]);
  });

  it("marks the save its browser uses when the crewmate says it did not sign the page in, before the card is offered", async () => {
    const h = await crewmateWithBrowser({ marks: true });
    const answer = await h.emitCard.run({
      ...REQUEST,
      browser_handoff: { ...HANDOFF, saved_failed: true },
    });
    expect(h.browsers.markSavedSignInFailed).toHaveBeenCalledWith(h.taskId, "aurora.example");
    expect(h.calls.indexOf("mark")).toBeLessThan(h.calls.indexOf(`pause ${h.taskId}`));
    expect(answer.text).not.toContain("marked nothing");
    expect(h.saved()?.title).toBe(REQUEST.title);
  });

  it("tells the crewmate its word marked nothing when its browser uses no saved sign-in", async () => {
    const h = await crewmateWithBrowser({ marks: false });
    const answer = await h.emitCard.run({
      ...REQUEST,
      browser_handoff: { ...HANDOFF, saved_failed: true },
    });
    expect(answer.text).toContain(
      "Your browser uses no saved sign-in for aurora.example, so saved_failed marked nothing.",
    );
    // A card without the word marks nothing.
    const plain = await crewmateWithBrowser({ marks: true });
    await plain.emitCard.run(REQUEST);
    expect(plain.browsers.markSavedSignInFailed).not.toHaveBeenCalled();
  });

  it("never counts the saved sign-in against the crewmate's own 2 or 3 actions (FI3-411)", async () => {
    const h = await crewmateWithBrowser({
      saved: { site: "aurora.example", savedAt: Date.parse("2026-10-02T09:00:00Z") },
    });
    // The crewmate never learns a site is saved, so the three it gave stand
    // and the host's offer goes beside them.
    await h.emitCard.run({
      ...REQUEST,
      actions: [{ id: "skip", label: "Book another airline" }, ...REQUEST.actions],
    });
    expect(h.saved()?.actions.map((action) => action.id)).toEqual([
      "skip",
      "leave",
      "sign-in",
      USE_SAVED_SIGN_IN_ACTION,
    ]);
  });

  it("leaves a request card as declared when no sign-in is saved for its site", async () => {
    const h = await crewmateWithBrowser({
      saved: { site: "skyfare.example", savedAt: Date.parse("2026-10-02T09:00:00Z") },
    });
    await h.emitCard.run(REQUEST);
    expect(h.saved()?.actions.map((action) => [action.id, action.label, action.default])).toEqual([
      ["leave", "Leave waiting", undefined],
      ["sign-in", BROWSER_SIGN_IN_STEP, true],
    ]);
  });

  it("never carries a saved sign-in a crewmate declares, and says in the feed when one cannot be used", async () => {
    const h = await crewmateWithBrowser({
      saved: { site: "aurora.example", savedAt: Date.parse("2026-10-02T09:00:00Z") },
      grant: async () => ({
        ok: false,
        text: "No sign-in for aurora.example is kept on this computer.",
      }),
    });
    // The tool carries no saved sign-in field: the crewmate's action is only a second open-browser one.
    await expect(
      h.emitCard.run({
        ...REQUEST,
        actions: [
          ...REQUEST.actions,
          {
            id: "mine",
            label: "Use my saved sign-in",
            effect: {
              kind: "open" as const,
              target: "browser" as const,
              savedSignIn: true as const,
            },
          },
        ],
      }),
    ).rejects.toThrow(/exactly one action whose effect is/);
    expect(h.browsers.requestHelp).not.toHaveBeenCalled();
    await h.emitCard.run(REQUEST);
    const card = h.saved();
    await h.endTurn();
    h.supervisor.cardActions.act(card?.id ?? "", USE_SAVED_SIGN_IN_ACTION);
    await tick();
    expect(h.events).toContainEqual({
      type: "firstmate_note",
      text: 'Your sign-in was not used for "Help me book a flight to Lisbon": No sign-in for aurora.example is kept on this computer. Its browser is still paused for you.',
      taskId: expect.any(String),
    });
    expect(h.crewmate.steer).not.toHaveBeenCalled();
  });

  it("wakes the crewmate once when the captain lets it use a saved sign-in, in words of their own", async () => {
    const h = await crewmateWithBrowser();
    await h.endTurn();
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.cardActions.browserReturned(h.taskId, {
      site: "aurora.example",
      after: "fill in the passenger details",
      saved: true,
      once: "browser-saved-sign-in:run-1:2:aurora.example",
    });
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    // Its words are the wake's own (wakes.test.ts holds them).
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "browser-returned",
          site: "aurora.example",
          after: "fill in the passenger details",
          saved: true,
        },
      }),
    );
  });

  it("wakes the crewmate once when the captain returns control, through its lane", async () => {
    const h = await crewmateWithBrowser();
    await h.endTurn();
    const prompts = h.crewmate.promptCalls.length;
    const returned = {
      site: "aurora.example",
      after: "fill in the passenger details",
      once: "browser-returned:run-1:2:1",
    };
    h.supervisor.cardActions.browserReturned(h.taskId, returned);
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    // Its words are the wake's own (wakes.test.ts holds them).
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: {
          kind: "browser-returned",
          site: "aurora.example",
          after: "fill in the passenger details",
        },
      }),
    );
    expect(
      h.tasks
        .timeline(h.taskId)
        .filter((event) => event.kind === "steered")
        .map((event) => event.actor),
    ).toEqual(["supervisor"]);
    // The same return again is not new: the inbox queued it once.
    await h.endTurn();
    h.supervisor.cardActions.browserReturned(h.taskId, returned);
    await tick();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
  });

  it("wakes the crewmate once for a page nothing answers at, queued while its turn runs", async () => {
    const h = await crewmateWithBrowser();
    const prompts = h.crewmate.promptCalls.length;
    const unanswered = {
      site: "localhost:5173",
      url: "http://localhost:5173/settings",
      once: "page-unanswered:run-1:t1:1",
    };
    const wake = renderWake({
      facts: {
        kind: "page-unanswered",
        site: "localhost:5173",
        url: "http://localhost:5173/settings",
      },
    });
    const told = () => [
      ...h.crewmate.promptCalls.slice(prompts),
      ...h.crewmate.steer.mock.calls.map(([text]) => text),
    ];
    // Its turn is running: the wake still goes, into that turn at its next chance.
    h.supervisor.cardActions.pageUnanswered(h.taskId, unanswered);
    await tick();
    expect(told()).toEqual([wake]);
    // The same outage again, once the turn ended, is not new.
    await h.endTurn();
    h.supervisor.cardActions.pageUnanswered(h.taskId, unanswered);
    await tick();
    expect(told()).toEqual([wake]);
  });

  // The captain's words on INF-155's sign-in card: "i clicked "open browser",
  // finished the sign in process and came back. but the card is still here".
  it("takes a request card down when the captain returns the browser he took from its record, leaving a plain door", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run({ ...REQUEST, id: "sign-in" });
    await h.emitCard.run({
      title: "The fare on aurora.example",
      body: "<p>The fare is held on aurora.example.</p>",
      id: "fare",
      browser_button: "View fare",
    });
    await h.endTurn();
    const open = () =>
      h.cardStore
        .listOpen()
        .filter((card) => card.taskId === h.taskId)
        .map((card) => card.title);
    expect(open()).toEqual([REQUEST.title, "The fare on aurora.example"]);
    // He took the browser from the record, never pressing the card's action.
    h.shown.fact = { ...OPEN, control: "captain" };
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.cardActions.browserReturned(h.taskId, {
      site: "aurora.example",
      after: HANDOFF.after,
      once: "browser-returned:run-1:2:1",
    });
    await tick();
    // The request is answered and leaves; the card that asked nothing stays.
    expect(open()).toEqual(["The fare on aurora.example"]);
    expect(h.supervisor.cards.snapshot().map((card) => card.title)).not.toContain(REQUEST.title);
    // Its crewmate hears only the return's one wake, never a choice he did not make.
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toBe(
      renderWake({
        facts: { kind: "browser-returned", site: "aurora.example", after: HANDOFF.after },
      }),
    );
  });

  it("leaves a request card naming an older browser when the captain returns a newer one", async () => {
    const h = await crewmateWithBrowser();
    await h.emitCard.run(REQUEST);
    await h.endTurn();
    // That browser stopped and a newer one took its place, which he took and returns.
    h.shown.fact = { ...OPEN, generation: 3, control: "captain" };
    h.supervisor.cardActions.browserReturned(h.taskId, {
      site: "aurora.example",
      once: "browser-returned:run-1:3:1",
    });
    await tick();
    // Its click is what tells the crewmate that its browser is gone.
    expect(h.saved()?.title).toBe(REQUEST.title);
  });
});

describe("a task's own browser (docs/task-browser.md)", () => {
  it("hands a crewmate on this Mac its own task's browser, and none when the app has no browser", async () => {
    const asked: string[] = [];
    const browser = {
      navigate: vi.fn(async () => ({ text: "opened" })),
      inspect: vi.fn(async () => ({ text: "read" })),
      act: vi.fn(async () => ({ text: "used" })),
      capture: vi.fn(async () => ({ text: "photographed" })),
      close: vi.fn(async () => ({ text: "stopped" })),
      pages: vi.fn(async () => ({ text: "one page" })),
    };
    const h = setup(fakeCrewmate(), {
      browsers: {
        forTask: (taskId) => {
          asked.push(taskId);
          return browser;
        },
        fact: () => undefined,
        withCaptain: () => false,
        requestHelp: async () => ({ ok: false, text: "no browser" }),
        takeControl: async () => ({ ok: false, text: "no browser" }),
      },
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Check the sign-up page",
      intent: intentOf("check the sign-up page the project serves"),
    });
    await tick();
    expect(asked).toEqual([taskId]);
    expect(h.specs.at(-1)?.browser).toBe(browser);
    // It reaches that browser through its shell's command, on whichever
    // backend runs it: the task's channel, and the one prompt line.
    expect(h.sessionSpecs.at(-1)?.shell).toEqual({
      env: { INFINITARY_AXI_KEY: `/channel/${taskId}.key` },
      path: ["/app/axi-bin"],
    });
    expect(h.sessionSpecs.at(-1)?.instructions.base).toContain(CREWMATE_BROWSER_LINE);
    expect(h.sessionSpecs.at(-1)?.tools.filter((tool) => tool.name.startsWith("browser_"))).toEqual(
      [],
    );

    const bare = setup(fakeCrewmate());
    await bare.supervisor.intake.commission({
      title: "Check the sign-up page",
      intent: intentOf("check the sign-up page the project serves"),
    });
    await tick();
    expect(bare.specs.at(-1)?.browser).toBeUndefined();
    expect(bare.sessionSpecs.at(-1)?.shell).toBeUndefined();
    expect(bare.sessionSpecs.at(-1)?.instructions.base).not.toContain(CREWMATE_BROWSER_LINE);
    // Its card tool offers the browser button only beside a browser.
    const emitCardOf = (harness: typeof h) =>
      harness.sessionSpecs.at(-1)?.tools.find((tool) => tool.name === "emit_card");
    expect(emitCardOf(h)?.parameters.properties).toHaveProperty("browser_button");
    expect(emitCardOf(bare)?.parameters.properties).not.toHaveProperty("browser_button");
  });

  describe('a card\'s browser button ("From a card")', () => {
    const browser = {
      navigate: vi.fn(async () => ({ text: "opened" })),
      inspect: vi.fn(async () => ({ text: "read" })),
      act: vi.fn(async () => ({ text: "used" })),
      capture: vi.fn(async () => ({ text: "photographed" })),
      close: vi.fn(async () => ({ text: "stopped" })),
      pages: vi.fn(async () => ({ text: "one page" })),
    };

    async function crewmateWithBrowser(fact: { current: TaskBrowserFact | undefined }) {
      const h = setup(fakeCrewmate(), {
        browsers: {
          forTask: () => browser,
          fact: () => fact.current,
          withCaptain: () => false,
          requestHelp: async () => ({ ok: false, text: "no browser" }),
          takeControl: async () => ({ ok: false, text: "no browser" }),
        },
      });
      const { taskId } = await h.supervisor.intake.commission({
        title: "Check the sign-up page",
        intent: intentOf("check the sign-up page the project serves"),
      });
      await tick();
      const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
      const saved = () => h.cardStore.listOpen().find((card) => card.taskId === taskId);
      return { ...h, taskId, emitCard, saved };
    }

    const OPEN: TaskBrowserFact = {
      state: "open",
      site: "localhost:5173",
      url: "http://localhost:5173/signup",
      title: "Sign up",
      session: "run-1",
      generation: 2,
    };
    const DECISION = {
      title: "The sign-up page thanks the name after Send",
      body:
        '<p>The sign-up page said "Thanks, Sam" after Send.</p>' +
        "<p>Its browser is still open on this computer, so you can try the page yourself.</p>",
      actions: [
        { id: "not-yet", label: "Not yet" },
        { id: "looks-right", label: "Looks right", default: true },
      ],
    };

    it("puts the browser the task holds on the card, labeled as the crewmate asked", async () => {
      const fact = { current: OPEN as TaskBrowserFact | undefined };
      const { emitCard, saved, taskId, cardStore } = await crewmateWithBrowser(fact);
      await emitCard.run({ ...DECISION, id: "try-sign-up", browser_button: "  Try   it " });
      const card = saved();
      expect(card?.attachment).toEqual({
        kind: "browser",
        label: "Try it",
        taskId,
        session: "run-1",
        generation: 2,
      });
      // It is part of what the card offers, and no action of the card.
      const offer = cardStore
        .observations(card?.id ?? "")
        .find((observation) => observation.kind === "offer");
      expect(offer?.payload).toMatchObject({ attachment: card?.attachment });
      expect(card?.actions.map((action) => action.id)).toEqual(["not-yet", "looks-right"]);
      // A stopped browser Open again can still start is a door too; a
      // revision without the button takes it away.
      fact.current = { ...OPEN, state: "stopped", stopped: "idle", at: 1 } as TaskBrowserFact;
      await emitCard.run({ ...DECISION, id: card?.id, browser_button: "View booking" });
      expect(saved()?.attachment).toMatchObject({ label: "View booking", generation: 2 });
      await emitCard.run({ ...DECISION, id: card?.id });
      expect(saved()?.attachment).toBeUndefined();
    });

    it("refuses a button with no browser to open, or no label, in words", async () => {
      const fact = { current: undefined as TaskBrowserFact | undefined };
      const { emitCard, saved } = await crewmateWithBrowser(fact);
      await expect(emitCard.run({ ...DECISION, browser_button: "Try it" })).rejects.toThrow(
        "Card refused: this task has no browser for browser_button to open. Open one with `infinitary-browser-axi open <url>` first, or emit the card without browser_button.",
      );
      fact.current = {
        ...OPEN,
        state: "stopped",
        stopped: "task-closed",
        at: 1,
      } as TaskBrowserFact;
      await expect(emitCard.run({ ...DECISION, browser_button: "Try it" })).rejects.toThrow(
        /no browser for browser_button to open/,
      );
      fact.current = OPEN;
      await expect(emitCard.run({ ...DECISION, browser_button: "   " })).rejects.toThrow(
        /browser_button is the label of one button, at most 32 characters/,
      );
      await expect(
        emitCard.run({ ...DECISION, browser_button: "Open the browser and look at the page" }),
      ).rejects.toThrow(/at most 32 characters/);
      expect(saved()).toBeUndefined();
    });
  });
});
