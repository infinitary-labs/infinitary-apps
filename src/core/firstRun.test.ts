import { FIRST_CREWMATE_ANSWER, FIRST_CREWMATE_TITLE } from "@shared/firstCrewmateNote";
import { WELCOME_ANSWER, WELCOME_NOTE, WELCOME_TITLE } from "@shared/welcome";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crewFacts,
  FirstRunService,
  type FirstRunStep,
  hasPriorActivity,
  presentFirstCrewmateNote,
} from "./firstRun";
import { CardService } from "./orchestrator/cardService";
import { CardStore } from "./storage/cardStore";
import { openInMemoryDatabase } from "./storage/db";
import { SettingsStore } from "./storage/settingsStore";
import { seedTask } from "./tasks/seedTask";
import { TaskService } from "./tasks/taskService";

const closeFixtures = new Set<() => void>();

function setup(initialOpen = true) {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const tasks = new TaskService({ db });
  const cardStore = new CardStore(db);
  let open = initialOpen;
  let usable = !open;
  let activity = false;
  let clock = 1000;
  const steps: FirstRunStep[] = [];
  const published: string[][] = [];
  const makeCards = () =>
    new CardService({
      now: () => clock,
      tasks,
      cardStore,
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: (cards) => published.push(cards.map((card) => card.id)),
    });
  let cards = makeCards();
  const makeService = () =>
    new FirstRunService({
      settings,
      gateOpen: () => open,
      usable: () => usable,
      hasActivity: () =>
        activity || hasPriorActivity({ tasks, cards: cardStore, repos: { list: () => [] } }),
      ...crewFacts(tasks),
      createWelcome: (consume) => {
        cards.addRecordedFirstmateNote(WELCOME_NOTE, consume, {
          replies: false,
          width: "regular",
        });
      },
      createFirstCrewmateNote: (record, welcomeCardId) =>
        presentFirstCrewmateNote(cards)(record, welcomeCardId),
      onStep: (step) => steps.push(step),
      now: () => clock,
    });
  let service = makeService();
  const close = () => {
    cards.dispose();
    db.close();
    closeFixtures.delete(close);
  };
  closeFixtures.add(close);
  return {
    close,
    db,
    settings,
    tasks,
    cardStore,
    steps,
    published,
    service: () => service,
    cards: () => cards,
    ready: () => {
      open = false;
      usable = true;
    },
    unavailable: () => {
      usable = false;
    },
    reopen: () => {
      open = true;
      usable = false;
    },
    activity: () => {
      activity = true;
    },
    tick: () => {
      clock++;
    },
    restart: () => {
      cards.dispose();
      cards = makeCards();
      service = makeService();
    },
  };
}

afterEach(() => {
  for (const close of closeFixtures) close();
  vi.restoreAllMocks();
});

describe("immediate welcome", () => {
  it("persists pending on fresh gated setup, then commits one Firstmate note and completed answer before returning ready", () => {
    const f = setup();
    expect(f.service().view()).toMatchObject({
      gateOpen: true,
      welcomeState: "pending",
      welcomedAt: null,
    });
    expect(f.published).toEqual([]);
    f.ready();
    const order: string[] = [];
    f.tasks.onChange(() => {
      expect(f.cardStore.listOpen()).toHaveLength(1);
      expect(f.settings.getFirstRun().welcomeState).toBe("consumed");
      order.push("committed");
    });
    const view = f.service().view();
    order.push("ready");
    expect(order).toEqual(["committed", "ready"]);
    expect(view).toMatchObject({ gateOpen: false, welcomeState: "consumed", welcomedAt: 1000 });
    expect(f.published).toEqual([[view.welcomeCardId]]);
    expect(f.cards().snapshot()[0]).toMatchObject({
      id: view.welcomeCardId,
      title: WELCOME_TITLE,
      author: "firstmate",
      actions: [],
      status: "ready",
      replies: false,
      width: "regular",
    });
    // Its record keeps the welcome in words, not its picture and script.
    expect(f.tasks.capture.taskForCard(view.welcomeCardId as string)).toMatchObject({
      kind: "question",
      status: "done",
      outcome: WELCOME_ANSWER,
    });
    f.service().reconcile();
    f.reopen();
    f.service().view();
    f.ready();
    f.service().view();
    expect(f.tasks.list()).toHaveLength(1);
    expect(f.cardStore.listOpen()).toHaveLength(1);
    f.close();
  });

  it("recovers pending readiness changed while closed, restoring identity and thread without rewriting", () => {
    const f = setup();
    f.service().reconcile();
    f.ready();
    f.restart();
    const first = f.service().view();
    const id = first.welcomeCardId as string;
    f.cards().addMessage(id, "captain", "Where do I start?");
    f.cards().addMessage(id, "firstmate", "Choose a project.");
    f.restart();
    f.service().reconcile();
    expect(f.settings.getFirstRun()).toEqual(firstRunRecord(first));
    expect(
      f
        .cards()
        .thread(id)
        .messages.map((m) => m.text),
    ).toEqual(["Where do I start?", "Choose a project."]);
    expect(f.tasks.list()).toHaveLength(1);
    f.close();
  });

  it("does not recreate a dismissed or cleaned-up card", () => {
    const f = setup();
    f.service().reconcile();
    f.ready();
    const id = f.service().view().welcomeCardId as string;
    const card = f.cards().get(id);
    if (!card) throw new Error("no welcome");
    f.cards().pressNote(card);
    f.restart();
    f.service().reconcile();
    expect(f.cards().snapshot()).toEqual([]);
    // Simulate retention deleting the stored card, not the durable eligibility record.
    f.db.prepare("DELETE FROM cards WHERE id = ?").run(id);
    f.restart();
    f.service().reconcile();
    expect(f.cards().snapshot()).toEqual([]);
    expect(f.settings.getFirstRun()).toMatchObject({ welcomeState: "consumed", welcomeCardId: id });
    f.close();
  });

  it.each(["legacy without stamp", "legacy with stamp", "preconfigured", "prior activity"])(
    "skips %s conservatively",
    (kind) => {
      const f = setup(kind !== "preconfigured");
      if (kind.startsWith("legacy"))
        f.settings.setFirstRun({
          welcomedAt: kind === "legacy with stamp" ? 12 : null,
          firstTurnAt: null,
        });
      if (kind === "prior activity") f.activity();
      f.service().reconcile();
      f.ready();
      f.service().view();
      f.restart();
      f.service().view();
      expect(f.settings.getFirstRun().welcomeState).toBe("skipped");
      expect(f.cards().snapshot()).toEqual([]);
      expect(f.settings.getFirstRun().welcomedAt).toBe(kind === "legacy with stamp" ? 12 : null);
      f.close();
    },
  );

  it("keeps the welcome through the captain's own setup changes, which are bookkeeping, not use", () => {
    const f = setup();
    expect(f.service().view().welcomeState).toBe("pending");
    // Saving a connection, a crew slot and the Firstmate's model each leave
    // the action catalog's settled operation row on the board.
    for (const [id, title] of [
      ["saved", "custom connection saved"],
      ["slot", "custom/operator-model added to medium"],
      ["seat", "First mate model custom/operator-model"],
    ] as const)
      f.tasks.capture.fileOperation({
        id,
        title,
        outcome: title,
        tool: "app_change",
        actor: "captain",
      });
    expect(f.service().view().welcomeState).toBe("pending");
    f.ready();
    const view = f.service().view();
    expect(view).toMatchObject({ gateOpen: false, welcomeState: "consumed" });
    expect(f.cards().snapshot()).toMatchObject([{ id: view.welcomeCardId, title: WELCOME_TITLE }]);
    f.close();
    // Any other row is still prior use.
    const used = setup();
    seedTask(used.tasks, {
      id: "asked",
      title: "Earlier ask",
      kind: "question",
      status: "completed",
    });
    expect(used.service().view().welcomeState).toBe("skipped");
    used.close();
  });

  it("keeps the existing diagnostic beats independent and the first-turn stamp once-only", () => {
    const f = setup();
    f.service().view();
    f.service().view();
    expect(f.steps).toEqual(["gate_shown"]);
    f.ready();
    f.service().view();
    f.service().noteCaptainTurn();
    f.service().noteCaptainTurn();
    f.reopen();
    f.service().view();
    f.ready();
    f.service().view();
    expect(f.steps).toEqual(["gate_shown", "signed_in", "first_turn", "gate_shown"]);
    f.close();
    const configured = setup(false);
    configured.service().view();
    expect(configured.steps).toEqual([]);
    configured.close();
  });

  it("a pause-closed gate cannot qualify; serving recovery can, without inference", () => {
    const f = setup();
    f.service().view();
    f.ready();
    f.unavailable();
    expect(f.service().view()).toMatchObject({
      gateOpen: false,
      welcomeState: "pending",
      welcomedAt: null,
    });
    expect(f.cards().snapshot()).toEqual([]);
    f.ready();
    expect(f.service().view().welcomeState).toBe("consumed");
    f.close();
  });

  it("rolls back the card, answer, board sequence and consumption together before retry", () => {
    const f = setup();
    f.service().view();
    f.ready();
    const seq = f.tasks.boardSeq();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = f.settings.setFirstRun.bind(f.settings);
    vi.spyOn(f.settings, "setFirstRun").mockImplementation((record) => {
      set(record);
      if (record.welcomeState === "consumed") throw new Error("crash before commit");
    });
    expect(f.service().view()).toMatchObject({
      gateOpen: false,
      welcomeState: "pending",
      welcomedAt: null,
    });
    expect(f.cards().snapshot()).toEqual([]);
    expect(f.cardStore.listOpen()).toEqual([]);
    expect(f.tasks.list()).toEqual([]);
    expect(f.tasks.boardSeq()).toBe(seq);
    expect(f.published).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    f.restart();
    expect(f.service().view().welcomeState).toBe("consumed");
    expect(f.tasks.list()).toHaveLength(1);
    expect(f.cards().snapshot()).toHaveLength(1);
    f.close();
  });

  it("input accepted first terminally skips the uncreated welcome; creation first retains it", () => {
    const inputFirst = setup();
    inputFirst.service().view();
    inputFirst.service().noteCaptainTurn();
    inputFirst.ready();
    expect(inputFirst.service().view()).toMatchObject({
      firstTurnAt: 1000,
      welcomeState: "skipped",
      welcomedAt: null,
    });
    expect(inputFirst.cards().snapshot()).toEqual([]);
    inputFirst.tick();
    inputFirst.service().noteCaptainTurn();
    expect(inputFirst.settings.getFirstRun().firstTurnAt).toBe(1000);
    const welcomeFirst = setup();
    welcomeFirst.service().view();
    welcomeFirst.ready();
    const id = welcomeFirst.service().view().welcomeCardId;
    welcomeFirst.service().noteCaptainTurn();
    expect(welcomeFirst.service().view()).toMatchObject({
      welcomeState: "consumed",
      welcomeCardId: id,
      firstTurnAt: 1000,
    });
    expect(welcomeFirst.cards().snapshot()).toHaveLength(1);
    inputFirst.close();
    welcomeFirst.close();
  });
});

describe("crewmate state words", () => {
  it("leaves a profile without crew history to be taught, and records each word once", () => {
    const f = setup();
    expect(f.service().view()).toMatchObject({ workingWordAt: null, idleWordAt: null });
    // The welcome note's task is not a crewmate.
    f.ready();
    f.service().view();
    expect(f.service().view()).toMatchObject({ workingWordAt: null, idleWordAt: null });
    f.tick();
    expect(f.service().noteCrewWord("idle")).toMatchObject({
      workingWordAt: null,
      idleWordAt: 1001,
    });
    f.tick();
    f.service().noteCrewWord("idle");
    f.service().noteCrewWord("working");
    expect(f.settings.getFirstRun()).toMatchObject({ workingWordAt: 1002, idleWordAt: 1001 });
    f.close();
  });

  it("marks a profile that already has crew history as taught when it first reads the record", () => {
    const f = setup(false);
    seedTask(f.tasks, { id: "built-before", title: "Earlier work", status: "completed" });
    f.settings.setFirstRun({ welcomedAt: null, firstTurnAt: 5 });
    expect(f.service().view()).toMatchObject({ workingWordAt: 1000, idleWordAt: 1000 });
    f.close();
  });
});

// docs/first-launch.md, "The first crewmate's note" (INF-5532's approved plan).
describe("the first crewmate's note", () => {
  const openTitles = (f: ReturnType<typeof setup>) =>
    f
      .cards()
      .snapshot()
      .map((card) => card.title);

  it("puts the open welcome away and shows the note once, at a new person's first start", () => {
    const f = setup();
    f.service().view();
    f.ready();
    const welcome = f.service().view();
    expect(welcome).toMatchObject({ welcomeState: "consumed", firstCrewmateAt: null });
    expect(openTitles(f)).toEqual([WELCOME_TITLE]);
    seedTask(f.tasks, { id: "first", title: "First work", status: "running" });
    f.tick();
    f.service().noteCrewmateStarted();
    const record = f.settings.getFirstRun();
    expect(record.firstCrewmateAt).toBe(1001);
    expect(openTitles(f)).toEqual([FIRST_CREWMATE_TITLE]);
    expect(f.cards().snapshot()[0]).toMatchObject({
      id: record.firstCrewmateNoteId,
      author: "firstmate",
      actions: [],
      replies: false,
      width: "regular",
    });
    // Its record keeps the note in words, and the welcome is settled as put away.
    expect(f.tasks.capture.taskForCard(record.firstCrewmateNoteId as string)).toMatchObject({
      kind: "question",
      status: "done",
      outcome: FIRST_CREWMATE_ANSWER,
    });
    expect(f.cardStore.listOpen().map((card) => card.id)).toEqual([record.firstCrewmateNoteId]);
    // A second start, a restart, and the note put away never bring it back.
    f.cards().takeDown(record.firstCrewmateNoteId as string, "read");
    f.tick();
    f.service().noteCrewmateStarted();
    f.restart();
    f.service().view();
    f.service().noteCrewmateStarted();
    expect(openTitles(f)).toEqual([]);
    expect(f.settings.getFirstRun()).toMatchObject({
      firstCrewmateAt: 1001,
      firstCrewmateNoteId: record.firstCrewmateNoteId,
    });
    f.close();
  });

  it("shows nothing to a profile without the welcome, or one that already had a crewmate", () => {
    const skipped = setup(false);
    expect(skipped.service().view()).toMatchObject({
      welcomeState: "skipped",
      firstCrewmateAt: null,
    });
    skipped.service().noteCrewmateStarted();
    expect(openTitles(skipped)).toEqual([]);
    expect(skipped.settings.getFirstRun()).toMatchObject({ firstCrewmateAt: 1000 });
    expect(skipped.settings.getFirstRun().firstCrewmateNoteId).toBeUndefined();
    skipped.close();

    const crewed = setup();
    crewed.service().view();
    crewed.ready();
    crewed.service().view();
    // A record from before this version, written once its welcome was consumed.
    const { firstCrewmateAt: _, ...older } = crewed.settings.getFirstRun();
    crewed.settings.setFirstRun(older);
    seedTask(crewed.tasks, { id: "built-before", title: "Earlier work", status: "completed" });
    expect(crewed.service().view().firstCrewmateAt).toBe(1000);
    crewed.service().noteCrewmateStarted();
    expect(openTitles(crewed)).toEqual([WELCOME_TITLE]);
    crewed.close();
  });
});

describe("the first finished task (kept for a view on an older version)", () => {
  it("counts no host note or app change, then records the first answered question once", () => {
    const f = setup();
    expect(f.service().view().welcomeState).toBe("pending");
    f.ready();
    // The welcome is a host note: a completed question that answers no message.
    expect(f.service().view().welcomeState).toBe("consumed");
    f.tasks.capture.fileOperation({
      id: "theme",
      title: "Light theme",
      outcome: "ok",
      tool: "app_change",
    });
    expect(f.service().view().firstTaskDoneAt).toBeUndefined();
    f.tasks.capture.openAsk({ id: "turn-1", text: "what time is it in Tokyo?" });
    f.tick();
    expect(f.service().view().firstTaskDoneAt).toBeUndefined();
    const answer = f.tasks.capture.fileQuestion({
      id: "tokyo",
      title: "Tokyo time",
      outcome: "9 AM",
    });
    f.tasks.capture.attachAsk("turn-1", answer.id, "tool:emit_card");
    expect(f.service().view().firstTaskDoneAt).toBe(1001);
    f.tick();
    seedTask(f.tasks, { id: "later", title: "Later work", status: "queued" });
    f.tasks.close("later", { status: "done", reason: "finished", actor: "host" });
    expect(f.service().view().firstTaskDoneAt).toBe(1001);
    f.close();
  });

  it("counts done work, never dropped work, and back-fills a profile that already has it", () => {
    const f = setup(false);
    seedTask(f.tasks, { id: "dropped", title: "Gave up", status: "cancelled" });
    expect(f.service().view().firstTaskDoneAt).toBeUndefined();
    seedTask(f.tasks, { id: "built", title: "Earlier work", status: "queued" });
    f.tasks.close("built", { status: "done", reason: "finished", actor: "host" });
    f.restart();
    expect(f.service().view().firstTaskDoneAt).toBe(1000);
    f.close();
  });
});

// docs/first-launch.md, "A finished crewmate": the rule the slot's
// `thirdCrewmateDoneAt` is decided by, now read by a bounded count instead
// of composing every task (INF-2338).
describe("the third finished crewmate", () => {
  it("counts only work a crewmate started that closed done, and records the third once", () => {
    const f = setup(false);
    // Work closed before a crewmate started it was nobody's, dropped work
    // did not finish, and a question the Firstmate answered had no crewmate.
    seedTask(f.tasks, { id: "unstarted", title: "Closed before it started", status: "queued" });
    f.tasks.close("unstarted", { status: "done", reason: "finished", actor: "host" });
    seedTask(f.tasks, { id: "dropped", title: "Gave up", status: "cancelled" });
    f.tasks.capture.openAsk({ id: "turn-1", text: "what time is it in Tokyo?" });
    const answer = f.tasks.capture.fileQuestion({
      id: "tokyo",
      title: "Tokyo time",
      outcome: "9 AM",
    });
    f.tasks.capture.attachAsk("turn-1", answer.id, "tool:emit_card");
    for (const n of [1, 2]) {
      seedTask(f.tasks, { id: `crew-${n}`, title: `Finished work ${n}`, status: "completed" });
      f.tasks.close(`crew-${n}`, { status: "done", reason: "merged", actor: "captain" });
    }
    expect(f.service().view().thirdCrewmateDoneAt).toBeUndefined();
    f.tick();
    seedTask(f.tasks, { id: "crew-3", title: "Finished work 3", status: "completed" });
    f.tasks.close("crew-3", { status: "done", reason: "merged", actor: "captain" });
    expect(f.service().view().thirdCrewmateDoneAt).toBe(1001);
    f.tick();
    seedTask(f.tasks, { id: "crew-4", title: "Finished work 4", status: "completed" });
    f.tasks.close("crew-4", { status: "done", reason: "merged", actor: "captain" });
    expect(f.service().view().thirdCrewmateDoneAt).toBe(1001);
    f.close();
  });
});

function firstRunRecord(view: ReturnType<FirstRunService["view"]>) {
  const { gateOpen: _open, untouched: _untouched, ...record } = view;
  return record;
}

describe("a connection's fresh check", () => {
  it("names the connection only while the gate is open", () => {
    const db = openInMemoryDatabase();
    let open = true;
    const freshCheck = {
      accountId: "acct_1",
      label: "Operator gateway",
      models: ["operator-model"],
    };
    const service = new FirstRunService({
      settings: new SettingsStore(db),
      gateOpen: () => open,
      freshCheck: () => freshCheck,
      usable: () => !open,
      hasActivity: () => true,
      hasCrewHistory: () => false,
      hasFinishedTask: () => false,
      thirdCrewmateDone: () => false,
      createWelcome: () => {},
      createFirstCrewmateNote: () => {},
    });
    expect(service.view()).toMatchObject({ gateOpen: true, freshCheck });
    open = false;
    const closed = service.view();
    expect(closed.gateOpen).toBe(false);
    expect(closed.freshCheck).toBeUndefined();
    db.close();
  });
});

// INF-4931's plan, step 1: a home may take this computer over in place only while "nothing has been
// done here" - a saved sign-in, a project, a card or a turn each count, though the gate is still up.
describe("an untouched profile", () => {
  it("is untouched only while the gate is up and nothing was saved or done here", () => {
    const fixture = setup();
    let accounts = false;
    const service = new FirstRunService({
      settings: fixture.settings,
      gateOpen: () => true,
      usable: () => false,
      hasActivity: () =>
        hasPriorActivity({
          tasks: fixture.tasks,
          cards: fixture.cardStore,
          repos: { list: () => [] },
        }),
      hasConnections: () => accounts,
      ...crewFacts(fixture.tasks),
      createWelcome: () => {},
    });
    expect(service.view().untouched).toBe(true);
    // A saved sign-in whose subscription cannot serve leaves the gate up, but it was done here.
    accounts = true;
    expect(service.view()).toMatchObject({ gateOpen: true, firstTurnAt: null });
    expect(service.view().untouched).toBeUndefined();
    accounts = false;
    // So does a task on the board.
    seedTask(fixture.tasks, { id: "first", title: "First work", status: "queued" });
    expect(service.view().untouched).toBeUndefined();
  });
});
