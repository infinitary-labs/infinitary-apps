import type { Card, CardMessage } from "@shared/cards";
import type { ThisMac } from "@shared/devices";
import type { ReleaseNotesView } from "@shared/releaseTracking";
import type { TaskBoard, TaskView } from "@shared/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catchUpOf, changesOffWords } from "../devices/viewWords";
import { onResync } from "../plugins/reads/resync";
import { useShellStore } from "./store";
import { card, DECIDE, resetShell, settle } from "./storeTestKit";

/**
 * A window that controls the first mate on another computer (docs/view.md):
 * what it takes down when changes come back on, and what it reads again when
 * that computer could not replay what it missed. Guardrails for INF-2625's
 * renderer piece, which moves this code out of store.ts: they hold what a
 * person sees before and after the move.
 */

const state = () => useShellStore.getState();

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

const NOTES: ReleaseNotesView = {
  version: "0.8.2-alpha.628",
  name: "alpha 0.8.2-alpha.628",
  notes: [],
};

/** What the window asks once and follows by push, each answering as the core does. */
function onceReads() {
  return {
    releaseNotes: { list: vi.fn(async () => NOTES) },
    devices: { shown: vi.fn(async () => ({ shown: true })) },
    secrets: { shown: vi.fn(async () => ({ shown: true })) },
  };
}

function line(cardId: string, text: string): CardMessage {
  return { id: 7, cardId, who: "firstmate", text, at: 3_000 };
}

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
    resetShell();
  });

  it("takes down every line that said changes were off and keeps the words typed", () => {
    const lost = view("lost");
    const list = vi.fn(async () => []);
    vi.stubGlobal("window", { infinitary: { cards: { list }, ...onceReads() } });
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

  // Review INF-3481 (f9): an ask made while that computer was away was refused,
  // so Devices and its commands stayed hidden until the window reloaded.
  // INF-3808: the same refused notes read held the Version row at "Reading the version…".
  it("asks again what it asked once - the notes, Devices and Secrets - once that computer is back in reach", async () => {
    const reads = onceReads();
    vi.stubGlobal("window", { infinitary: reads });
    useShellStore.setState({
      thisMac: view("lost"),
      releaseNotes: null,
      devicesShown: false,
      secretsShown: false,
    });

    state().applyThisMac({ ...view("lost"), heardAt: 1_800 });
    expect(reads.devices.shown).not.toHaveBeenCalled();

    state().applyThisMac(view("in-reach"));
    await settle();
    expect(reads.devices.shown).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ releaseNotes: NOTES, devicesShown: true, secretsShown: true });

    state().applyThisMac({ ...view("in-reach"), heardAt: 2_500 });
    expect(reads.devices.shown).toHaveBeenCalledTimes(1);
    expect(reads.releaseNotes.list).toHaveBeenCalledTimes(1);
    expect(reads.secrets.shown).toHaveBeenCalledTimes(1);
  });

  // INF-3808: on the first mate's own computer a drop the link dialed through
  // replays every push, so nothing read everything again, and a notes read the
  // drop refused was never asked again.
  it("asks what it asked once again on the first mate's own computer each time its link comes back", async () => {
    const reads = onceReads();
    vi.stubGlobal("window", { infinitary: reads });
    let resynced = 0;
    const stop = onResync(() => {
      resynced += 1;
    });
    useShellStore.setState({
      thisMac: { role: "home", left: null },
      releaseNotes: null,
      devicesShown: false,
      secretsShown: false,
    });

    state().applyThisMac({ role: "home", left: null, linkBack: 1 });
    await settle();
    expect(state()).toMatchObject({ releaseNotes: NOTES, devicesShown: true, secretsShown: true });
    // Only the one-time reads: a replayed drop reads nothing else again.
    expect(resynced).toBe(0);

    state().applyThisMac({ role: "home", left: null, linkBack: 1 });
    expect(reads.releaseNotes.list).toHaveBeenCalledTimes(1);
    state().applyThisMac({ role: "home", left: null, linkBack: 2 });
    expect(reads.releaseNotes.list).toHaveBeenCalledTimes(2);
    stop();
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
    stackThere = [
      card({ id: "card-b", title: "Merge the reply fix", status: "ready", actions: DECIDE }),
    ];
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
      cards: [card({ id: "card-a", title: "Pick a welcome", status: "ready", actions: DECIDE })],
      cardsSnapshotLoaded: true,
      threads: { "card-a": [] },
      firstmateBusy: true,
    });
  });

  afterEach(() => {
    stopListening();
    vi.unstubAllGlobals();
    resetShell();
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

  // INF-4207 piece 2: live waits until what was missed is applied.
  it("says it reads everything again until the reads answer, and only then live", async () => {
    useShellStore.setState({ rereadThrough: 2 });
    let answer: (cards: Card[]) => void = () => {};
    infinitary.cards.list.mockImplementation(
      () =>
        new Promise<Card[]>((resolve) => {
          answer = resolve;
        }),
    );
    const catchUp = () => {
      const mac = state().thisMac;
      return mac?.role === "view" ? catchUpOf(mac, state().rereadThrough) : "not a view";
    };

    state().applyThisMac(view("in-reach", 3));
    await settle();
    expect(catchUp()).toBe("reload");
    answer(stackThere);
    await settle();
    expect(catchUp()).toBe(null);
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
    state().applyCards([
      card({ id: "card-c", title: "A newer card", status: "ready", actions: DECIDE }),
    ]);
    answer(stackThere);
    await settle();

    expect(state().cards.map((c) => c.id)).toEqual(["card-c"]);
    expect(state().cardsSnapshotLoaded).toBe(true);
  });

  // The window on the first mate's own computer missed pushes the local door
  // could not replay, or lost the door (docs/view.md, "The window on the first
  // mate's own computer"): it reads everything again as a view does.
  it("reads everything again on the first mate's own computer when its window caught up again", async () => {
    useShellStore.setState({ thisMac: { role: "home", left: null } });

    state().applyThisMac({ role: "home", left: null, caughtUp: 1 });

    expect(resynced).toBe(1);
    await settle();
    expect(state().cards.map((c) => c.id)).toEqual(["card-b"]);
    state().applyThisMac({ role: "home", left: null, caughtUp: 1 });
    expect(resynced).toBe(1);
  });

  it("reads nothing again when the other computer has not caught up since", () => {
    state().applyThisMac({ ...view("in-reach", 2), heardAt: 2_500 });

    expect(infinitary.cards.list).not.toHaveBeenCalled();
    expect(resynced).toBe(0);
    expect(state().firstmateBusy).toBe(true);
  });
});
