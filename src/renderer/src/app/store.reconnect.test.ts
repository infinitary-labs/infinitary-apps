import type { Card, CardMessage } from "@shared/cards";
import type { ThisMac } from "@shared/devices";
import type { TaskBoard, TaskView } from "@shared/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesOffWords } from "../devices/viewWords";
import { onResync } from "../plugins/reads/resync";
import { useShellStore } from "./store";

/**
 * A window that controls the first mate on another computer (docs/view.md):
 * what it takes down when changes come back on, and what it reads again when
 * that computer could not replay what it missed. Guardrails for INF-2625's
 * renderer piece, which moves this code out of store.ts: they hold what a
 * person sees before and after the move.
 */

const state = () => useShellStore.getState();

/** Lets every read the store started answer, and what it did with each answer run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** This window, controlling the computer named Studio, in `contact` and caught up `caughtUp` times. */
function view(contact: "in-reach" | "lost", caughtUp = 0): Extract<ThisMac, { role: "view" }> {
  return {
    role: "view",
    name: "Studio",
    address: "studio.local",
    joinedAt: 1_000,
    contact,
    readOnly: null,
    heardAt: contact === "in-reach" ? 2_000 : 1_500,
    caughtUp,
  };
}

function card(id: string, title: string): Card {
  return {
    id,
    author: "firstmate",
    priority: 10,
    title,
    meta: "firstmate",
    body: `<p>${title}</p>`,
    actions: [{ id: "go", label: "Go", default: true }],
    status: "ready",
    createdAt: 1_000,
  };
}

function line(cardId: string, text: string): CardMessage {
  return { id: 7, cardId, who: "firstmate", text, at: 3_000 };
}

/** An active crewmate's task, as the board lists it. */
function task(id: string, activity: TaskView["activity"]): TaskView {
  return {
    id,
    key: `INF-${id}`,
    projectId: "infinitary",
    parentId: null,
    kind: "work",
    title: "Fix the reply row",
    goal: null,
    priority: 2,
    status: "active",
    activity,
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 1",
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_000,
    closedAt: null,
  };
}

const board = (tasks: TaskView[]): TaskBoard => ({
  seq: 4,
  at: 3_000,
  projects: [],
  tasks,
  links: [],
});

describe("changes coming back on for a window controlling another computer (docs/view.md)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState(useShellStore.getInitialState(), true);
  });

  it("takes down every line that said changes were off and keeps the words typed", () => {
    const lost = view("lost");
    const list = vi.fn(async () => []);
    vi.stubGlobal("window", { infinitary: { cards: { list } } });
    useShellStore.setState({
      thisMac: lost,
      inputText: "ship it",
      replyDrafts: { "card-a": "yes, go" },
      composerNotice: "away",
      replyNotices: { "card-a": "away", "card-b": "files-preparing" },
      cardActionErrors: { "card-a": changesOffWords(lost), "card-b": "The card is gone." },
    });

    state().applyThisMac(view("in-reach"));

    expect(state()).toMatchObject({
      thisMac: view("in-reach"),
      inputText: "ship it",
      replyDrafts: { "card-a": "yes, go" },
      composerNotice: null,
      replyNotices: { "card-b": "files-preparing" },
      cardActionErrors: { "card-b": "The card is gone." },
    });
    // Back in reach on the same catch-up: nothing is read again.
    expect(list).not.toHaveBeenCalled();
  });

  it("leaves the lines in place while changes stay off", () => {
    const lost = view("lost");
    useShellStore.setState({
      thisMac: lost,
      composerNotice: "away",
      replyNotices: { "card-a": "away" },
      cardActionErrors: { "card-a": changesOffWords(lost) },
    });

    state().applyThisMac({ ...lost, heardAt: 1_800 });

    expect(state()).toMatchObject({
      composerNotice: "away",
      replyNotices: { "card-a": "away" },
      cardActionErrors: { "card-a": changesOffWords(lost) },
    });
  });
});

describe("reading everything again after a gap (docs/view.md)", () => {
  let infinitary: {
    cards: { list: ReturnType<typeof vi.fn>; thread: ReturnType<typeof vi.fn> };
    releaseNotes: { list: ReturnType<typeof vi.fn> };
    tasks: { board: ReturnType<typeof vi.fn> };
    app: { firstRun: ReturnType<typeof vi.fn> };
    conversation: { lastTurn: ReturnType<typeof vi.fn> };
  };
  let stackThere: Card[];
  let resynced: number;
  let stopListening: () => void;

  beforeEach(() => {
    stackThere = [card("card-b", "Merge the reply fix")];
    infinitary = {
      cards: {
        list: vi.fn(async () => stackThere),
        thread: vi.fn(async (cardId: string) => ({
          cardId,
          messages: [line(cardId, "Read again after the gap.")],
        })),
      },
      releaseNotes: { list: vi.fn(async () => null) },
      tasks: {
        board: vi.fn(async () => board([task("t-busy", "running"), task("t-idle", "idle")])),
      },
      app: { firstRun: vi.fn(async () => Promise.reject(new Error("unreadable"))) },
      conversation: { lastTurn: vi.fn(async () => null) },
    };
    vi.stubGlobal("window", { infinitary });
    resynced = 0;
    stopListening = onResync(() => {
      resynced += 1;
    });
    useShellStore.setState({
      thisMac: view("in-reach", 2),
      cards: [card("card-a", "Pick a welcome")],
      cardsSnapshotLoaded: true,
      threads: { "card-a": [] },
      firstmateBusy: true,
    });
  });

  afterEach(() => {
    stopListening();
    vi.unstubAllGlobals();
    useShellStore.setState(useShellStore.getInitialState(), true);
  });

  it("reads the stack, every thread it read, the board and every panel's reads again, and the turn that ended away stops showing", async () => {
    state().applyThisMac(view("in-reach", 3));

    expect(state()).toMatchObject({ firstmateBusy: false, cardsSnapshotLoaded: false });
    expect(resynced).toBe(1);
    await settle();

    expect(state().cards.map((c) => c.id)).toEqual(["card-b"]);
    expect(state().cardsSnapshotLoaded).toBe(true);
    expect(infinitary.cards.thread).toHaveBeenCalledWith("card-a");
    expect(state().threads["card-a"]?.map((m) => m.text)).toEqual(["Read again after the gap."]);
    expect(state().crewActivity).toEqual({ "t-busy": "running", "t-idle": "idle" });
    expect(infinitary.releaseNotes.list).toHaveBeenCalledTimes(1);
    expect(infinitary.app.firstRun).toHaveBeenCalledTimes(1);
    expect(infinitary.conversation.lastTurn).toHaveBeenCalledTimes(1);
    // An unreadable first-run answer still settles the input.
    expect(state().firstRunSettled).toBe(true);
  });

  it("keeps a stack that changed while its read was out", async () => {
    let answer: (cards: Card[]) => void = () => {};
    infinitary.cards.list.mockImplementation(
      () =>
        new Promise<Card[]>((resolve) => {
          answer = resolve;
        }),
    );

    state().applyThisMac(view("in-reach", 3));
    state().applyCards([card("card-c", "A newer card")]);
    answer(stackThere);
    await settle();

    expect(state().cards.map((c) => c.id)).toEqual(["card-c"]);
    expect(state().cardsSnapshotLoaded).toBe(true);
  });

  it("reads nothing again when the other computer has not caught up since", () => {
    state().applyThisMac({ ...view("in-reach", 2), heardAt: 2_500 });

    expect(infinitary.cards.list).not.toHaveBeenCalled();
    expect(resynced).toBe(0);
    expect(state().firstmateBusy).toBe(true);
  });
});
