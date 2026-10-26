import type { Card, CardMessage } from "@shared/cards";
import { panelCommandId } from "@shared/keyboard";
import type { TaskView } from "@shared/tasks";
import { describe, expect, it, vi } from "vitest";
import { lendTaskTabs, taskTabsOf } from "../cards/taskTabs";
import { commandRefusal, type RefusalState, type WindowFacts } from "./commandRefusals";

/** The board as a card's head reads it: which task each card is about. */
const cardTasks = new Map<string, Partial<TaskView>>();
vi.mock("../cards/cardTask", () => ({
  cardTaskOf: (card: { id: string }) => cardTasks.get(card.id),
}));

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    author: "firstmate",
    priority: 10,
    title: id,
    meta: "firstmate",
    body: "",
    actions: [],
    status: "ready",
    createdAt: 1,
    ...overrides,
  };
}

const HOME: RefusalState = {
  view: "home",
  recording: false,
  pickingDictationKey: false,
  recordingKeys: false,
  firstRun: null,
  firstRunSettled: true,
  commandSearchOpen: false,
  cards: [card("a"), card("b")],
  cardIndex: 0,
  collapsedCardIds: [],
  heldBackCardIds: [],
  records: [],
  threads: {},
  releaseNotes: {
    version: "0.1.28",
    name: "stable 0.1.28",
    notes: [{ version: "0.1.28", name: "stable 0.1.28", cardId: "note", listed: true, shownAt: 1 }],
  },
  thisMac: null,
  devicesShown: true,
  pendingCardActions: {},
  lastTurn: { you: "Is it done?", reply: { text: "Not yet." } },
};
const CLEAR: WindowFacts = { dialogOpen: false };

describe("why a window command cannot run now", () => {
  // INF-1228, the captain's answer control=all: of a first mate started by a
  // command, the tabs nobody could open there open here; Automation, already
  // its own on any Mac that controls another, keeps its own rule.
  it("opens Usage and Integrations on a Mac that controls a first mate started by a command", () => {
    const view = {
      role: "view",
      name: "Mac mini",
      address: "192.168.1.30",
      joinedAt: 0,
      contact: "in-reach",
      readOnly: null,
      heardAt: null,
      caughtUp: 1,
    } as const;
    const windowed = { ...HOME, thisMac: view };
    const run = { ...HOME, thisMac: { ...view, startedByCommand: true } };
    for (const command of ["settings.usage", "usage.unit", "settings.integrations"] as const) {
      expect(commandRefusal(command, windowed, CLEAR)).toMatch(/ is on Mac mini$/);
      expect(commandRefusal(command, run, CLEAR)).toBeNull();
    }
    expect(commandRefusal("settings.automation", run, CLEAR)).toBe(
      commandRefusal("settings.automation", windowed, CLEAR),
    );
  });

  it("refuses Try again where Devices is not offered, as on a Mac that controls another", () => {
    expect(commandRefusal("devices.try-again", HOME, CLEAR)).toBeNull();
    expect(commandRefusal("devices.try-again", { ...HOME, devicesShown: false }, CLEAR)).toBe(
      "Devices is on the computer where your first mate lives",
    );
  });

  it("lets every command run on a home screen with cards, but the arrow past the stack's end", () => {
    for (const id of [
      "commands.search",
      "focus.main-message",
      "focus.card-reply",
      "focus.card-body",
      "regions.next",
      "regions.previous",
      "cards.next",
      "cards.close",
      "cards.maximize",
      "settings.open",
      "settings.keyboard",
      "whats-new.show",
      "size.larger",
    ] as const)
      expect(commandRefusal(id, HOME, CLEAR)).toBeNull();
    expect(commandRefusal("cards.previous", HOME, CLEAR)).toBe("This is the first card");
    expect(commandRefusal("cards.next", { ...HOME, cardIndex: 1 }, CLEAR)).toBe(
      "This is the last card",
    );
  });

  it("holds every shell command while the dictation key is picked, and all but its own while search is open", () => {
    const picking = { ...HOME, pickingDictationKey: true, view: "settings" as const };
    expect(commandRefusal("commands.search", picking, CLEAR)).toBe(
      "Settings is waiting for a dictation key",
    );
    const searching = { ...HOME, commandSearchOpen: true };
    expect(commandRefusal("focus.main-message", searching, CLEAR)).toBe("Command search is open");
    expect(commandRefusal("commands.search", searching, { ...CLEAR, dialogOpen: true })).toBeNull();
    // The size keys belong to the main process, which never asks.
    expect(commandRefusal("size.reset", picking, CLEAR)).toBeNull();
  });

  it("holds every shell command while Keyboard settings records a key, and opens it from Settings", () => {
    const recordingKeys = { ...HOME, recordingKeys: true, view: "settings" as const };
    expect(commandRefusal("settings.keyboard", recordingKeys, CLEAR)).toBe(
      "Settings is recording a key",
    );
    expect(commandRefusal("commands.search", recordingKeys, CLEAR)).toBe(
      "Settings is recording a key",
    );
    expect(commandRefusal("settings.keyboard", { ...HOME, view: "settings" }, CLEAR)).toBeNull();
  });

  it("keeps an open dialog's focus until Escape closes it", () => {
    const dialog = { ...CLEAR, dialogOpen: true };
    expect(commandRefusal("commands.search", HOME, dialog)).toBe("Close the open dialog first");
    expect(commandRefusal("cards.next", HOME, dialog)).toBe("Close the open dialog first");
  });

  it("says why the reply cannot take focus: no card, a card that takes none, a recording", () => {
    expect(commandRefusal("focus.card-reply", { ...HOME, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
    const host = { ...HOME, cards: [card("h", { author: "host" })] };
    expect(commandRefusal("focus.card-reply", host, CLEAR)).toBe("This card takes no reply");
    const record = { ...HOME, records: [{ taskId: "t1" }] };
    expect(commandRefusal("focus.card-reply", record, CLEAR)).toBe("This card takes no reply");
    expect(commandRefusal("focus.card-reply", { ...HOME, recording: true }, CLEAR)).toBe(
      "A recording is running",
    );
    // From Settings it goes home first, so Settings is no reason.
    expect(commandRefusal("focus.card-reply", { ...HOME, view: "settings" }, CLEAR)).toBeNull();
  });

  it("goes to the shown entry's body from home or Settings, whatever the entry is", () => {
    expect(commandRefusal("focus.card-body", { ...HOME, view: "settings" }, CLEAR)).toBeNull();
    expect(commandRefusal("focus.card-body", { ...HOME, records: [{ taskId: "t1" }] }, CLEAR)).toBe(
      null,
    );
    expect(commandRefusal("focus.card-body", { ...HOME, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
    expect(commandRefusal("focus.card-body", { ...HOME, recording: true }, CLEAR)).toBe(
      "A recording is running",
    );
  });

  it("moves between a task card's tabs only while its strip is drawn with somewhere to go", () => {
    const record = { ...HOME, records: [{ taskId: "t1" }] };
    expect(commandRefusal("cards.next-tab", { ...HOME, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
    // A task with no browser draws no strip.
    expect(commandRefusal("cards.next-tab", record, CLEAR)).toBe("This card has no tabs");
    const unlend = lendTaskTabs({
      taskId: "t1",
      shown: "info",
      tabs: taskTabsOf({
        state: "open",
        site: "localhost:5173",
        url: "http://localhost:5173/",
        title: "Settings",
        session: "run-1",
        generation: 1,
      }),
      selected: 0,
      enabled: () => true,
      go: () => {},
    });
    try {
      expect(commandRefusal("cards.next-tab", record, CLEAR)).toBeNull();
      expect(commandRefusal("cards.show-browser", record, CLEAR)).toBeNull();
      expect(commandRefusal("cards.show-info", record, CLEAR)).toBe("That tab is already shown");
      // A card with no Crewmate tab says so, rather than that it is shown.
      expect(commandRefusal("cards.show-crewmate", record, CLEAR)).toBe(
        "This card has no such tab",
      );
      expect(commandRefusal("cards.next-tab", { ...record, view: "settings" }, CLEAR)).toBe(
        "Settings is open",
      );
    } finally {
      unlend();
    }
  });

  it("opens a task's tabs from a card about it, and refuses on a card about no task (INF-358)", () => {
    cardTasks.set("a", { id: "t1", key: "SCR-1", startedAt: null });
    cardTasks.set("b", { id: "t2", key: "SCR-2", startedAt: 5 });
    try {
      expect(commandRefusal("cards.show-info", HOME, CLEAR)).toBeNull();
      expect(commandRefusal("cards.show-browser", HOME, CLEAR)).toBeNull();
      // No crewmate has run the task: it has no Crewmate tab to show.
      expect(commandRefusal("cards.show-crewmate", HOME, CLEAR)).toBe("This card has no such tab");
      expect(commandRefusal("cards.show-crewmate", { ...HOME, cardIndex: 1 }, CLEAR)).toBeNull();
      // Next and Previous tab stay the strip's own.
      expect(commandRefusal("cards.next-tab", HOME, CLEAR)).toBe("This card has no tabs");
      const none = { ...HOME, cards: [card("c")] };
      expect(commandRefusal("cards.show-info", none, CLEAR)).toBe("This card is not about a task");
      expect(commandRefusal("cards.show-info", { ...HOME, view: "settings" }, CLEAR)).toBe(
        "Settings is open",
      );
    } finally {
      cardTasks.clear();
    }
  });

  it("goes to a card's buttons only when it has some to press", () => {
    const decision = card("d", { actions: [{ id: "go", label: "Go", default: true }] });
    expect(commandRefusal("focus.card-actions", { ...HOME, cards: [decision] }, CLEAR)).toBeNull();
    expect(
      commandRefusal("focus.card-actions", { ...HOME, cards: [decision], view: "settings" }, CLEAR),
    ).toBeNull();
    expect(commandRefusal("focus.card-actions", HOME, CLEAR)).toBe("This card has no buttons");
    const record = { ...HOME, cards: [decision], records: [{ taskId: "t1" }] };
    expect(commandRefusal("focus.card-actions", record, CLEAR)).toBe("This card has no buttons");
    expect(commandRefusal("focus.card-actions", { ...HOME, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
  });

  it("shows or hides a thread only where the shown card has one", () => {
    const said: CardMessage = { id: 1, cardId: "a", who: "captain", text: "why", at: 1 };
    const threaded = { ...HOME, threads: { a: [said] } };
    expect(commandRefusal("cards.thread", threaded, CLEAR)).toBeNull();
    expect(commandRefusal("cards.thread", HOME, CLEAR)).toBe("This card has no thread yet");
    expect(commandRefusal("cards.thread", { ...threaded, threads: { a: [] } }, CLEAR)).toBe(
      "This card has no thread yet",
    );
    const host = { ...threaded, cards: [card("a", { author: "host" })] };
    expect(commandRefusal("cards.thread", host, CLEAR)).toBe("This card takes no reply");
    const record = { ...threaded, records: [{ taskId: "t1" }] };
    expect(commandRefusal("cards.thread", record, CLEAR)).toBe("This card takes no reply");
    expect(commandRefusal("cards.thread", { ...threaded, recording: true }, CLEAR)).toBe(
      "A recording is running",
    );
    expect(commandRefusal("cards.thread", { ...threaded, view: "settings" }, CLEAR)).toBe(
      "Settings is open",
    );
    expect(commandRefusal("cards.thread", { ...threaded, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
  });

  it("keeps the cards' commands to the home screen, where the cards are", () => {
    const settings = { ...HOME, view: "settings" as const };
    expect(commandRefusal("cards.close", settings, CLEAR)).toBe("Settings is open");
    expect(commandRefusal("cards.next", settings, CLEAR)).toBe("Settings is open");
    expect(commandRefusal("settings.open", settings, CLEAR)).toBe("Settings is already open");
    expect(commandRefusal("cards.close", { ...HOME, cards: [] }, CLEAR)).toBe("No card is shown");
    expect(commandRefusal("cards.maximize", settings, CLEAR)).toBe("Settings is open");
    expect(commandRefusal("cards.maximize", { ...HOME, cards: [] }, CLEAR)).toBe(
      "No card is shown",
    );
  });

  it("moves between the window's parts from home or Settings, but not during a recording", () => {
    for (const id of ["regions.next", "regions.previous"] as const) {
      expect(commandRefusal(id, { ...HOME, view: "settings" }, CLEAR)).toBeNull();
      expect(commandRefusal(id, { ...HOME, cards: [] }, CLEAR)).toBeNull();
      expect(commandRefusal(id, { ...HOME, recording: true }, CLEAR)).toBe(
        "A recording is running",
      );
      expect(commandRefusal(id, HOME, { ...CLEAR, dialogOpen: true })).toBe(
        "Close the open dialog first",
      );
    }
  });

  it("shows what's new from home or Settings once a release note was shown, and says so before", () => {
    expect(commandRefusal("whats-new.show", { ...HOME, view: "settings" }, CLEAR)).toBeNull();
    expect(commandRefusal("whats-new.show", { ...HOME, cards: [] }, CLEAR)).toBeNull();
    const none = { version: "0.1.28", name: "stable 0.1.28", notes: [] };
    expect(commandRefusal("whats-new.show", { ...HOME, releaseNotes: none }, CLEAR)).toBe(
      "No release notes yet",
    );
    // Before the notes are read, it claims none.
    expect(commandRefusal("whats-new.show", { ...HOME, releaseNotes: null }, CLEAR)).toBe(
      "No release notes yet",
    );
  });

  it("gives the main message's own reasons", () => {
    const firstRun = { welcomedAt: null, firstTurnAt: null, gateOpen: true };
    expect(commandRefusal("focus.main-message", { ...HOME, firstRun }, CLEAR)).toBe(
      "Connect a subscription first",
    );
    expect(commandRefusal("focus.main-message", { ...HOME, recording: true }, CLEAR)).toBe(
      "A recording is running",
    );
    // Before the first read of the gate settles, nobody knows yet whether it is up.
    expect(commandRefusal("focus.main-message", { ...HOME, firstRunSettled: false }, CLEAR)).toBe(
      "Infinitary is still starting",
    );
  });
});

describe("why a panel's command cannot run now", () => {
  const id = panelCommandId("reading", "find");
  const facts: WindowFacts = {
    ...CLEAR,
    panelCommand: (_id, recording) => (recording ? "A recording is running" : null),
  };

  it("holds it with every other command, then asks its panel", () => {
    expect(commandRefusal(id, HOME, facts)).toBeNull();
    expect(commandRefusal(id, { ...HOME, commandSearchOpen: true }, facts)).toBe(
      "Command search is open",
    );
    expect(commandRefusal(id, { ...HOME, recordingKeys: true }, facts)).toBe(
      "Settings is recording a key",
    );
    expect(commandRefusal(id, { ...HOME, recording: true }, facts)).toBe("A recording is running");
    expect(commandRefusal(id, HOME, { ...CLEAR, dialogOpen: true })).toBe(
      "Close the open dialog first",
    );
  });
});
