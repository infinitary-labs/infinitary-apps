import type { Card } from "@shared/cards";
import { expect } from "vitest";
import { useShellStore } from "./store";

/**
 * What the window store's test files share (store.test.ts and one file per
 * slice beside its module): a card and its gesture, a picture, and the one
 * reset back to the store's first state. Tests only; no app code imports it.
 */

/** The metadata every card gesture carries beside it: a fresh id of its own. */
export const gesture = (extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{32}$/), ...extra });

/** A card with an action is a decision; the store collapses only action-less notes. */
export const DECIDE: Card["actions"] = [{ id: "go", label: "Go", default: true }];

export function card(overrides: Partial<Card> & Pick<Card, "id" | "status">): Card {
  return {
    author: "firstmate",
    priority: 10,
    title: "Card",
    meta: "firstmate",
    body: "",
    actions: [],
    createdAt: 0,
    ...overrides,
  };
}

/** A pasted or dropped picture, named by its id. */
export const picture = (id: string) => ({
  id,
  preview: `data:image/png;base64,${id}`,
  mimeType: "image/png" as const,
  data: id,
});

/** Puts the whole store back as it was created: every slice's state and actions. */
export function resetShell(): void {
  useShellStore.setState(useShellStore.getInitialState(), true);
}
