import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import type { Slot } from "@shared/quota";
import { DEFAULT_SHARING } from "@shared/sharing";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { fakeBinding, fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import {
  createTrackedAgent,
  drained,
  fakeClockEachTest,
  fakeSession,
  notifyProse,
  seatFactory,
  setup,
  tick,
} from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor } from "../paths";
import type { ModelRuntime } from "../pi/types";
import { CardStore } from "../storage/cardStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { SettingsStore } from "../storage/settingsStore";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import { SETUP_CARD_FAILED_WORDS } from "./captainWakes";
import { CrewSupervisor } from "./crewSupervisor";
import { idleStallWays } from "./holds";
import { FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS, PROVIDER_SIGN_IN_TITLE } from "./hostCards";
import { Scheduler } from "./scheduler";
import { renderWake, type TypedWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: the lane: inbox drains, the model pick and failed turns (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

describe("FirstmateAgent", () => {
  it("delivers inbox messages only when idle and drains after the turn", async () => {
    const { agent, db, session } = setup();
    await agent.converse("start work");
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task ab12 "x": done',
      "crewmate-report",
      "ab12",
    );
    await tick();
    // Still streaming: the op waits in the durable inbox.
    expect(session.prompts).toHaveLength(1);
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("crewmate 1 reported");
    session.resolveNextPrompt();
    await tick();
  });

  it("serves a typed wake as its rendered prose, verbatim, in the drained turn", async () => {
    const { agent, session } = setup();
    await agent.converse("start work");
    const wake: TypedWake = {
      facts: {
        kind: "idle-stall",
        task: { id: "ab12", title: "Fix" },
        crewmate: "crewmate 1",
        key: "FI3-1",
        idleMs: 20 * 60_000,
        thread: false,
        nudged: true,
        wakes: 1,
        last: { kind: "report", excerpt: "Done with step one." },
      },
      ways: idleStallWays("ab12"),
    };
    agent.notifyOp(wake, "agent", "ab12");
    await tick();
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
    const prose = renderWake(wake);
    expect(prose.startsWith('[fm-op] crewmate 1 on task ab12 "Fix" has been idle for 20m')).toBe(
      true,
    );
    expect(session.prompts[1]).toContain(prose);
    session.resolveNextPrompt();
    await tick();
  });

  it("delivers a closed answer choice once after a busy turn", async () => {
    const { agent, session, db } = setup();
    await agent.converse("start work");
    notifyProse(
      db,
      agent,
      '[fm-op] {"version":1,"event":"answer_task_closed","task":{"id":"ab12","key":"FI3-205","title":"Choose layout"},"card":{"id":"card-answer","title":"Layout"},"choice":{"id":"below","label":"Move attachments below","effect":null},"close":{"status":"done","reason":"answered","actor":"captain"}}',
      "agent",
      "ab12",
    );
    await tick();
    expect(session.prompts).toHaveLength(1);
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("Move attachments below");
    session.emitTurnEnd("I will commission the follow-up.");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE recipient = 'firstmate'").get(),
    ).toEqual({
      n: 0,
    });
  });

  it("coalesces wakes that arrive within the window into one turn (WI-13)", async () => {
    const { agent, db, session } = setup({ coalesceMs: 30 });
    // Three ops land synchronously while the session is idle: the window holds
    // the first for its siblings, so all three drain in ONE turn. (Without
    // coalescing the first would drain alone and the rest wait out its turn.)
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task aa11 "one": done',
      "crewmate-report",
      "aa11",
    );
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 2 reported on task bb22 "two": done',
      "crewmate-report",
      "bb22",
    );
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 3 reported on task cc33 "three": done',
      "crewmate-report",
      "cc33",
    );
    await drained(session, 1);
    expect(session.prompts[0]).toContain("aa11");
    expect(session.prompts[0]).toContain("bb22");
    expect(session.prompts[0]).toContain("cc33");
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
  });

  it("runs a captain turn at once during the window and carries the pending wakes (WI-13)", async () => {
    // A long window that will not fire on its own during the test.
    const { agent, db, session } = setup({ coalesceMs: 10_000 });
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task aa11 "one": done',
      "crewmate-report",
      "aa11",
    );
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 2 reported on task bb22 "two": done',
      "crewmate-report",
      "bb22",
    );
    await tick();
    // The wakes are still held by the window - no turn yet.
    expect(session.prompts).toHaveLength(0);
    // The captain speaks: the turn runs immediately and carries the ops
    // before its [user] line, so no separate op drain follows.
    await agent.converse("what changed?");
    expect(session.prompts).toHaveLength(1);
    const turn = session.prompts[0] as string;
    expect(turn).toContain("aa11");
    expect(turn).toContain("bb22");
    expect(turn.indexOf("aa11")).toBeLessThan(turn.indexOf("[user]"));
    expect(turn).toContain("[user]\nwhat changed?");
    session.emitTurnEnd("Here's what changed.");
    session.resolveNextPrompt();
    await tick();
    // The carried wakes were acked with the captain turn: no second turn.
    expect(session.prompts).toHaveLength(1);
  });

  it("reads the coalescing window on the host's clock: a wake already past it drains at once", async () => {
    // The window is long, but on the host's clock the wake was written a
    // full window ago, so the drain does not hold it.
    const { agent, db, session } = setup({ coalesceMs: 10_000, now: () => Date.now() + 10_000 });
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task aa11 "one": done',
      "crewmate-report",
      "aa11",
    );
    await tick();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("aa11");
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
  });

  it("tells how the captain's Add project came out at once, without waiting out the window", async () => {
    // INF-835: a refused clone's sign-in card arrived after the journey's
    // 5 seconds on a slow Mac, because its wake sat out the 3-second window.
    const { agent, session } = setup({ coalesceMs: 10_000 });
    agent.notifyOp(
      {
        facts: {
          kind: "project-setup",
          outcome: "failed",
          name: "private",
          reason: "GitHub needs your sign-in before Infinitary can clone octo/private.",
        },
      },
      "agent",
    );
    await tick();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain(SETUP_CARD_FAILED_WORDS);
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
  });

  it("a wake arriving after the window is its own turn (WI-13)", async () => {
    const { agent, db, session } = setup({ coalesceMs: 30 });
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task aa11 "one": done',
      "crewmate-report",
      "aa11",
    );
    await drained(session, 1);
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    // A later wake opens a fresh window and its own turn.
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 2 reported on task bb22 "two": done',
      "crewmate-report",
      "bb22",
    );
    await drained(session, 2);
    expect(session.prompts[1]).toContain("bb22");
    expect(session.prompts[1]).not.toContain("aa11");
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
  });

  it("persists the derived default model and the session file", async () => {
    const { agent, settings, specs } = setup();
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(settings.getFirstmateSessionFile()).toBe("/tmp/fm/sessions/session.jsonl");
    expect(specs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-1" });
  });

  it.each([
    ["high", "high"],
    ["medium", "medium"],
    ["premium", "premium"],
    ["low", "low"],
  ] as const)("Auto takes %s before any lower bucket", async (highest, expected) => {
    const order: Slot[] = ["high", "medium", "premium", "low"];
    const models = order
      .slice(order.indexOf(highest))
      .reverse()
      .map((slot) => ({ provider: "openai-codex", id: slot }));
    const { agent, settings, specs } = setup({
      availableModels: () => models,
      quotaModels: () => ({
        generatedAt: "now",
        models: models.map((model) => ({ provider: "codex", id: model.id, label: model.id })),
      }),
      slotsOf: (model) => [model.id as Slot],
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "openai-codex", id: expected });
    expect(specs[0]?.model?.id).toBe(expected);
  });

  it("ranks listed models by bucket when allowance is unread", async () => {
    const { agent, settings } = setup({
      availableModels: () => [
        { provider: "openai-codex", id: "low" },
        { provider: "openai-codex", id: "premium" },
      ],
      slotsOf: (model) => [model.id as Slot],
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "openai-codex", id: "premium" });
  });

  it("takes a listed high model ahead of a catalogued low model", async () => {
    const { agent, settings } = setup({
      availableModels: () => [
        { provider: "openai-codex", id: "low" },
        { provider: "openai-codex", id: "high" },
      ],
      quotaModels: () => ({
        generatedAt: "now",
        models: [{ provider: "codex", id: "low", label: "Low" }],
      }),
      slotsOf: (model) => [model.id as Slot],
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "openai-codex", id: "high" });
  });

  it("falls through exhausted high and medium to premium before low", async () => {
    const models = (["low", "premium", "medium", "high"] as const).map((id) => ({
      provider: "openai-codex",
      id,
    }));
    const { agent, settings } = setup({
      availableModels: () => models,
      quotaModels: () => ({
        generatedAt: "now",
        models: models.map((model) => ({
          provider: "codex",
          id: model.id,
          label: model.id,
          effectivePercentRemaining: ["high", "medium"].includes(model.id) ? 0 : 30,
        })),
      }),
      slotsOf: (model) => [model.id as Slot],
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "openai-codex", id: "premium" });
  });

  it("skips a leftover Anthropic firstmate model and derives a new default", async () => {
    const { agent, settings, specs } = setup({
      availableModels: () => [
        { provider: "anthropic", id: "claude-sonnet" },
        { provider: "fm-mock", id: "mock-1" },
      ],
    });
    settings.setFirstmateModel({ provider: "anthropic", id: "claude-sonnet" });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(specs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-1" });
  });

  it("falls back to a listed model, never a catalog's first id (docs/model-lists.md)", async () => {
    // An OpenRouter-only install with nothing slotted: the catalog's first
    // id is an old model nobody chose, and must not become the orchestrator.
    const { agent, settings, specs } = setup({
      availableModels: () => [
        { provider: "openrouter", id: "anthropic/claude-3-haiku" },
        { provider: "openrouter", id: "~anthropic/claude-sonnet-latest" },
      ],
      listedModels: () => [{ provider: "openrouter", id: "~anthropic/claude-sonnet-latest" }],
    });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({
      provider: "openrouter",
      id: "~anthropic/claude-sonnet-latest",
    });
    expect(specs[0]?.model).toEqual({
      provider: "openrouter",
      id: "~anthropic/claude-sonnet-latest",
    });
  });

  it("skips a leftover Cursor pin and derives a new default", async () => {
    const { agent, settings, specs } = setup({
      availableModels: () => [
        { provider: "cursor", id: "composer-2" },
        { provider: "fm-mock", id: "mock-1" },
      ],
    });
    settings.setFirstmateModel({ provider: "cursor", id: "composer-2" });
    await agent.converse("hello");
    expect(settings.getFirstmateModel()).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(specs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-1" });
  });

  // Audit row 5: the shared turn end must preserve the durable inbox's
  // distinction between a thrown attempt and a resolved provider failure.
  it.each(["thrown", "provider"] as const)(
    "releases an operational %s failure with its own retry accounting",
    async (failure) => {
      const f = setup();
      const inbox = new InboxStore(f.db);
      notifyProse(f.db, f.agent, "[fm-op] The checks passed", "agent");
      await drained(f.session, 1);
      const id = inbox.inFlight(FIRSTMATE_RECIPIENT)[0]!.id;
      if (failure === "thrown") f.session.rejectNextPrompt("Connection error.");
      else {
        f.session.emitTurnFailed("Connection error.");
        f.session.resolveNextPrompt();
      }
      await tick();
      expect(inbox.get(id)).toMatchObject({
        deliveredAt: null,
        attempts: failure === "thrown" ? 1 : 0,
        failures: failure === "thrown" ? 0 : 1,
      });
      expect(f.tasks.capture.listAsks()).toEqual([]);
      expect(f.turns).toEqual([
        { trigger: "operation", failed: true, reason: failure === "thrown" ? "error" : "provider" },
      ]);
    },
  );

  it("tells its listener how each turn settled: who it answered and, failed, only the kind", async () => {
    const { agent, db, session, turns } = setup();
    await agent.converse("hello");
    session.emitTurnEnd("Hi.");
    session.resolveNextPrompt();
    await tick();
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task ab12 "x": done',
      "crewmate-report",
      "ab12",
    );
    await tick();
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    await agent.converse("again");
    session.emitTurnFailed('401: {"message":"Incorrect API key provided"}');
    session.resolveNextPrompt();
    await tick();
    await agent.converse("and again");
    session.emitTurnFailed("Response incomplete: max_time_limit");
    session.resolveNextPrompt();
    await tick();
    await agent.converse("once more");
    session.emitTurnFailed("Connection error.");
    session.resolveNextPrompt();
    await tick();
    await agent.converse("last");
    session.rejectNextPrompt("something broke in /Users/kun/secret-project");
    await tick();
    expect(turns).toEqual([
      { trigger: "captain", failed: false },
      { trigger: "operation", failed: false },
      { trigger: "captain", failed: true, reason: "sign_in" },
      { trigger: "captain", failed: true, reason: "time_limit" },
      { trigger: "captain", failed: true, reason: "provider" },
      { trigger: "captain", failed: true, reason: "error" },
    ]);
    // The error text never reaches the listener.
    expect(JSON.stringify(turns)).not.toContain("secret-project");
  });

  it("tells its listener a captain turn failed when no session could start", async () => {
    const { agent, turns } = setup({ failCreate: "No signed-in model" });
    await agent.converse("hello");
    await tick();
    expect(turns).toEqual([{ trigger: "captain", failed: true, reason: "no_session" }]);
  });

  it("raises a retryable error card when a turn fails", async () => {
    const { agent, session, cards } = setup();
    await agent.converse("do a thing");
    session.rejectNextPrompt("provider exploded");
    await tick();
    const card = cards().find((entry) => entry.title === "Your first mate hit a problem") as Card;
    expect(card).toBeDefined();
    expect(card.author).toBe("host");
    expect(card.actions.map((action) => action.effect)).toEqual([
      { kind: "host", op: "retry-firstmate" },
    ]);
  });

  it("raises the auth decision card when a thrown turn failure is Pi's auth preflight", async () => {
    const session = fakeSession({ provider: "xai", id: "grok-4.6" });
    const { agent, cards } = setup({ session });
    await agent.converse("do a thing");
    session.rejectNextPrompt("No API key found for xai.\n\nUse /login to log in.");
    await tick();
    const card = cards().find((entry) => entry.title === PROVIDER_SIGN_IN_TITLE) as Card;
    expect(card).toBeDefined();
    // Product words naming the provider, never Pi's own sign-in help.
    expect(card.body).toBe(
      "Your first mate could not reach Grok, which needs you to sign in again.",
    );
    expect(
      cards().find((entry) => entry.title === "Your first mate hit a problem"),
    ).toBeUndefined();
  });

  it("surfaces a provider-failed turn: the error card plus a turn_failed feed event (REPRO A)", async () => {
    const { agent, session, events, cards } = setup();
    await agent.converse("answer with a card");
    // Pi resolves the turn; the error rides the message, nothing throws.
    session.emitTurnFailed("Error Code null: Internal error during token generation");
    session.resolveNextPrompt();
    await tick();
    expect(events).toContainEqual({
      type: "turn_failed",
      taskId: "firstmate",
      error: "fm-mock mock-1: Error Code null: Internal error during token generation",
    });
    const card = cards().find((entry) => entry.title === "Your first mate hit a problem") as Card;
    expect(card).toBeDefined();
    expect(card.body).toContain(
      "fm-mock mock-1: Error Code null: Internal error during token generation",
    );
    expect(card.actions.map((action) => action.id)).toContain("retry-firstmate");
    // A transient provider fault is not a sign-in problem.
    expect(cards().find((entry) => entry.title === "A provider needs sign in")).toBeUndefined();

    // A second failed turn revises the same card in place - a provider
    // outage across several turns never stacks copies.
    await agent.converse("try again");
    session.emitTurnFailed("Connection error.");
    session.resolveNextPrompt();
    await tick();
    const errorCards = cards().filter((entry) => entry.title === "Your first mate hit a problem");
    expect(errorCards).toHaveLength(1);
    expect(errorCards[0]?.body).toContain("fm-mock mock-1: Connection error.");
  });

  it("routes a provider-reported 401 to the sign-in decision, same as the preflight path", async () => {
    const { agent, session, cards } = setup();
    await agent.converse("hello");
    session.emitTurnFailed(
      '401: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
    );
    session.resolveNextPrompt();
    await tick();
    const card = cards().find((entry) => entry.title === "A provider needs sign in") as Card;
    expect(card).toBeDefined();
    // A provider the app does not list: the ones that can serve Firstmate,
    // never the provider's own reply.
    expect(card.body).toBe(FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS);
  });

  it("refuses a third consecutive max_time_limit instead of hanging the orchestrator again", async () => {
    const { agent, session, cards, supervisor } = setup();
    await agent.converse("one");
    session.emitTurnFailed("Response incomplete: max_time_limit");
    session.resolveNextPrompt();
    await tick();
    await agent.converse("two");
    session.emitTurnFailed("Response incomplete: max_time_limit");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
    const card = cards().find((entry) => entry.title === "Your first mate hit a problem") as Card;
    expect(card.body).toContain("will not try again until you press Retry");

    await agent.converse("three");
    await tick();
    expect(session.prompts).toHaveLength(2);

    supervisor.cardActions.act(card.id, "retry-firstmate");
    await tick();
    expect(session.prompts).toHaveLength(3);
  });

  it("watches its own turn: feed line at 10 quiet minutes, card at 20, retired on activity", async () => {
    const MIN = 60_000;
    const { agent, session, events, cards } = setup();
    await agent.converse("long think");
    const start = Date.now();

    agent.checkQuiet(start + 9 * MIN);
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(0);

    agent.checkQuiet(start + 11 * MIN);
    agent.checkQuiet(start + 12 * MIN);
    const notes = events.filter((e) => e.type === "firstmate_note");
    expect(notes).toHaveLength(1);
    expect(notes[0] && "text" in notes[0] ? notes[0].text : "").toContain("quiet for 11 minutes");

    agent.checkQuiet(start + 21 * MIN);
    await tick();
    const quiet = cards().find((card) => card.id === "card-fm-quiet");
    expect(quiet?.title).toBe("Your first mate has gone quiet");
    // Steer-only contract: the card informs, it offers no interrupt.
    expect(quiet?.actions).toEqual([]);

    // Output arrives: the question answered itself, the card retires.
    session.emitDelta("still here");
    await tick();
    expect(cards().find((card) => card.id === "card-fm-quiet")).toBeUndefined();

    session.emitTurnEnd("Done.");
    session.resolveNextPrompt();
    await tick();
    // An idle orchestrator never escalates.
    agent.checkQuiet(Date.now() + 60 * MIN);
    expect(events.filter((e) => e.type === "firstmate_note")).toHaveLength(1);
  });

  it("raises the auth decision card when no model is available", async () => {
    const paths = appPathsFor(scratchDir("infinitary-agent-"));
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const repos = new RepoRegistry(db, paths.fleetDir);
    let cards: Card[] = [];
    const tasks = new TaskService({ db, strict: true });
    const supervisor = new CrewSupervisor({
      sessions: { pi: fakeSessionFactory() },
      bind: async (accountId) => fakeBinding(accountId),
      workspace: { removeTaskWorktree: vi.fn(async () => {}) } as unknown as WorkspaceService,
      repos,
      tasks,
      cardStore: new CardStore(db),
      inbox: new InboxStore(db),
      paths,
      broadcastEvent: () => {},
      broadcastCards: (snapshot) => {
        cards = snapshot;
      },
    });
    const agent = createTrackedAgent({
      paths,
      inbox: new InboxStore(db),
      settings,
      modelRuntime: {} as ModelRuntime,
      availableModels: () => [],
      quotaModels: () => undefined,
      quotaLine: () => "unknown",
      repos,
      supervisor,
      tasks,
      broadcastEvent: () => {},
      selfSourceDir: paths.userData,
      seats: {
        pi: seatFactory("pi", async () => {
          throw new Error("should not create");
        }),
      },
    });
    await agent.converse("hello");
    await tick();
    const card = cards.find((entry) => entry.actions.length > 0) as Card;
    expect(card.title).toBe(PROVIDER_SIGN_IN_TITLE);
    expect(card.body).toBe(FIRSTMATE_NO_PROVIDER_SIGN_IN_WORDS);
    expect(card.actions[0]?.effect).toEqual({ kind: "open", target: "subscriptions" });
    // Audit row 5: the original ask waits durably for a session, rather
    // than being filed failed and duplicated when the captain retries.
    expect(tasks.capture.listOpenAsks()).toMatchObject([
      { text: "hello", turnState: "open", delivery: "held", taskId: null },
    ]);
    expect(new InboxStore(db).allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    expect(tasks.list().filter((record) => record.kind === "question")).toEqual([]);
  });

  it("reset clears the rolling session and the inbox", async () => {
    const { agent, session, db, settings, paths } = setup();
    await agent.converse("hello");
    session.resolveNextPrompt();
    await tick();
    notifyProse(db, agent, "[fm-op] queued while idle", "agent");
    await tick();
    settings.setFirstmateClaudeSession("claude-session-1");
    mkdirSync(paths.firstmateSessionsDir, { recursive: true });
    writeFileSync(join(paths.firstmateSessionsDir, "rolling.jsonl"), "{}\n");
    mkdirSync(paths.firstmateClaudeDir, { recursive: true });
    writeFileSync(join(paths.firstmateClaudeDir, "claude-session-1.jsonl"), "{}\n");
    writeFileSync(join(paths.firstmateClaudeDir, "claude-session-1.served.jsonl"), "{}\n");
    mkdirSync(paths.supervisionSessionsDir, { recursive: true });
    writeFileSync(join(paths.supervisionSessionsDir, "retired.jsonl"), "{}\n");
    mkdirSync(paths.supervisionHomeDir, { recursive: true });
    writeFileSync(join(paths.supervisionHomeDir, "keep.txt"), "stay\n");
    mkdirSync(paths.firstmateHomeDir, { recursive: true });
    writeFileSync(join(paths.firstmateHomeDir, "keep.txt"), "stay\n");
    await agent.reset();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(session.dispose).toHaveBeenCalled();
    // Each backend's rolling session is forgotten, not only the one attached.
    expect(settings.getFirstmateSessionFile()).toBeNull();
    expect(settings.getFirstmateClaudeSession()).toBeNull();
    // The Pi files, the Claude copies and sidecars, and a retired supervision
    // transcripts dir go. The client's own copies are not these paths, and
    // the supervision home is not a transcript directory.
    expect(existsSync(paths.firstmateSessionsDir)).toBe(false);
    expect(existsSync(paths.firstmateClaudeDir)).toBe(false);
    expect(existsSync(paths.supervisionSessionsDir)).toBe(false);
    expect(readFileSync(join(paths.supervisionHomeDir, "keep.txt"), "utf8")).toBe("stay\n");
    expect(readFileSync(join(paths.firstmateHomeDir, "keep.txt"), "utf8")).toBe("stay\n");
  });

  // INF-3948: a rule's history shows what each run found, so a promise to
  // tell the captain can be checked run by run (INF-3926's finding 1).
  it("keeps the closing words of the turn that handled a scheduled run in its history", async () => {
    const db = openInMemoryDatabase();
    const inbox = new InboxStore(db);
    const store = new ScheduleStore(db);
    const scheduler = new Scheduler({
      store,
      notify: (wake, origin) => inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, origin),
      inbox,
      broadcastEvent: () => {},
    });
    const { agent, session } = setup({ db, scheduler });
    const rule = scheduler.create(
      { kind: "every", minutes: 60 },
      "Check whether the focus fix is in a published alpha.",
      true,
      "Alpha watch",
    );
    scheduler.tick(rule.nextFire + 1);
    agent.pokeInbox();
    await tick();
    expect(session.prompts.at(-1)).toContain(
      "Check whether the focus fix is in a published alpha.",
    );
    expect(scheduler.history(rule.id)[0]?.state).toBe("waiting");
    session.emitTurnEnd("Not in a published alpha yet; the newest is alpha.552.");
    session.resolveNextPrompt();
    await tick();
    const [run] = scheduler.history(rule.id);
    expect(run?.state).toBe("handled");
    expect(run?.found).toBe("Not in a published alpha yet; the newest is alpha.552.");
  });

  // INF-751: whether the captain set a schedule is the first mate's evidence
  // to judge, and the wake it stamps; the change is not refused on it.
  it.each([true, false, undefined])(
    "stamps a schedule's wake as the captain's only when he set it (%s)",
    async (captainRequested) => {
      const store = new ScheduleStore(openInMemoryDatabase());
      const scheduler = new Scheduler({ store, notify: () => {}, broadcastEvent: () => {} });
      const { agent, session, specs } = setup({ scheduler });
      const calls: unknown[] = [];
      agent.bindAppDispatch(async (channel, args, actor) => {
        calls.push([channel, args, actor]);
        const values: Record<string, unknown> = {
          "inf:settings:sharing:get": DEFAULT_SHARING,
          "inf:voice:status": { modelReady: false, firstUse: true },
          "inf:presence:get": { startAtLogin: false, showInDock: true },
          "inf:shell:preferences": { panels: { enabled: true } },
          "inf:settings:dictation:get": { enabled: true, key: "AltRight" },
          "inf:devices:list": [],
          "inf:release-notes:list": { version: "0.1.28", name: "stable 0.1.28", notes: [] },
          // General's lines include ending a secret read and stopping a copy, which list theirs.
          "inf:secrets:view": { reads: [] },
          "inf:standby:list": { standbys: [] },
        };
        return (values[channel] ?? true) as never;
      });
      await agent.converse("turn notifications off each morning");
      const tool = (name: string) => {
        const found = specs[0]?.tools.find((entry) => entry.name === name);
        if (!found) throw new Error(`Missing ${name}`);
        return found;
      };
      await tool("schedule_prompt").run({ prompt: "turn notifications off", every_minutes: 30 });
      expect(store.list()[0]?.captainRequested).toBe(true);
      session.emitTurnEnd("Scheduled.");
      session.resolveNextPrompt();
      await tick();
      agent.notifyOp(
        {
          facts: {
            kind: "scheduled",
            prompt: "turn notifications off",
            catchUp: false,
            ...(captainRequested === undefined ? {} : { captainRequested }),
          },
        },
        "scheduled",
      );
      await tick();
      const state = JSON.parse((await tool("app_state").run({ area: "general" })).text);
      expect(
        state.find((line: { action: string }) => line.action === "notifications").allowedNow,
      ).toBe(true);
      calls.length = 0;
      const outcome = await tool("app_change").run({
        action: "notifications",
        value: { enabled: false },
        evidence: "The captain's schedule: turn notifications off each morning.",
      });
      expect(
        calls.filter((entry) => (entry as unknown[])[0] === "inf:settings:notifications:set"),
      ).toEqual([
        [
          "inf:settings:notifications:set",
          [false],
          expect.objectContaining({ wake: captainRequested === true ? "scheduled" : "other" }),
        ],
      ]);
      await tool("schedule_prompt").run({ prompt: "a reminder I chose", every_minutes: 45 });
      expect(store.list()[1]?.captainRequested).toBe(false);
      const evidenceDir = process.env.INFINITARY_ACTION_EVIDENCE_DIR;
      if (evidenceDir)
        writeFileSync(
          join(evidenceDir, `schedule-authority-${captainRequested ?? "legacy"}.json`),
          `${JSON.stringify({ schedules: store.list(), scheduledWakeProof: captainRequested ?? null, appState: state, changeOutcome: outcome.text, coreCalls: calls }, null, 2)}\n`,
        );
      session.emitTurnEnd("Checked.");
      session.resolveNextPrompt();
      await tick();
    },
  );
});
