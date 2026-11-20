import type { Card } from "@shared/cards";
import type { FrameAnswers } from "@shared/plugins/bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savedCardAnswers } from "./savedCardAnswers";
import { useShellStore } from "./store";

/**
 * INF-2710: the captain chose "Keep picks across restarts" - a card's unsent
 * picks are saved on this computer until the card closes. The journey
 * (tests/e2e/card-minimize.spec.ts) shows them coming back after a restart;
 * this file holds what the saved copy keeps as the shell's readings change.
 */

const state = () => useShellStore.getState();

/** The window's own storage, as the next window would read it. */
function windowStorage() {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** The plan card the reset was found on, with its six questions. */
const plan: Card = {
  id: "card-bc46286c-large-files-plan",
  taskId: "large-files",
  author: "crewmate",
  meta: "crewmate 1",
  priority: 20,
  title: "Plan: restructure the 39 files over 2,000 lines in 29 pieces",
  body: "<p>Six questions.</p>",
  actions: [
    { id: "save-defer", label: "Save and defer" },
    { id: "abandon", label: "Abandon" },
    { id: "approve-build", label: "Approve and build", default: true },
  ],
  status: "ready",
  createdAt: 1_000,
};

/** The captain's own picks on it: every recommendation, so none reads as changed. */
const picked: FrameAnswers = {
  answered: 6,
  of: 6,
  changed: 0,
  picked: 6,
  answers: [
    {
      name: "direction",
      values: ["owners"],
      labels: ["Split along owners and delete as it goes"],
      changed: false,
    },
    {
      name: "scope",
      values: ["all"],
      labels: ["Yes: tests, journeys and stand-ins split too"],
      changed: false,
    },
    {
      name: "target",
      values: ["one-job"],
      labels: ["One job per file, with 2,000 lines as the ceiling"],
      changed: false,
    },
    {
      name: "size_check",
      values: ["yes"],
      labels: ["Yes: it refuses a file over 2,000 lines unless it is on a list that only shrinks"],
      changed: false,
    },
    {
      name: "coverage",
      values: ["add"],
      labels: [
        "Add the coverage package once, with a script that measures named files and sets no threshold",
      ],
      changed: false,
    },
    { name: "test_changes", values: ["approve"], labels: ["Yes, these three"], changed: false },
  ],
};

/** The same card with every pick taken back. */
const cleared: FrameAnswers = {
  answered: 3,
  of: 6,
  changed: 0,
  picked: 0,
  answers: picked.answers.map((answer) => ({ name: answer.name, values: [], changed: false })),
};

let storage: ReturnType<typeof windowStorage>;

beforeEach(() => {
  storage = windowStorage();
  vi.stubGlobal("localStorage", storage);
  state().applyCards([plan]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useShellStore.setState(useShellStore.getInitialState(), true);
});

describe("a card's saved picks", () => {
  it("reach the next window, and leave with the card when it closes", () => {
    state().setCardAnswers(plan.id, picked);
    expect(savedCardAnswers(storage)).toEqual({ [plan.id]: picked });

    state().applyCards([]);
    expect(savedCardAnswers(storage)).toEqual({});
  });

  it("are dropped when the captain takes every pick back", () => {
    state().setCardAnswers(plan.id, picked);
    state().setCardAnswers(plan.id, cleared);
    expect(savedCardAnswers(storage)).toEqual({});
  });
});
