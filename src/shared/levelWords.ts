import * as m from "./i18n/messages.generated.ts";
import type { Slot } from "./modelSlots.ts";

/** Board order, strongest first, as `SLOTS` holds it. */
const BOARD_ORDER: readonly Slot[] = ["premium", "high", "medium", "low"];

/**
 * The one wording of a level (docs/routing.md, "A level's words"). A level
 * names how hard a task is - Hard, Normal, Simple - so it is never read as
 * the reasoning, whose words are Low, Medium and High; Premium names models,
 * since no work is sorted into it on its own. The saved values (premium,
 * high, medium, low) never change and never reach a person.
 */

/** A level's word as a label, in the language the app speaks: Premium, Hard, Normal, Simple. */
export function levelWord(slot: Slot): string {
  switch (slot) {
    case "premium":
      return m.uiSlotPremium();
    case "high":
      return m.uiSlotHigh();
    case "medium":
      return m.uiSlotMedium();
    case "low":
      return m.uiSlotLow();
  }
}

/** A level's word inside an English sentence. */
const LEVEL_NAME: Record<Slot, string> = {
  premium: "premium",
  high: "hard",
  medium: "normal",
  low: "simple",
};

export function levelName(slot: Slot): string {
  return LEVEL_NAME[slot];
}

export function levelModels(slot: Slot): string {
  return slot === "premium" ? "premium models" : `models for ${LEVEL_NAME[slot]} tasks`;
}

export function levelModel(slot: Slot): string {
  return slot === "premium" ? "a premium model" : `a model for ${LEVEL_NAME[slot]} tasks`;
}

/**
 * The levels in board order as one phrase about the work they take:
 * "hard tasks", "hard and normal tasks", "premium, hard and simple tasks" -
 * a premium task is one the captain asked premium for.
 */
export function levelList(slots: readonly Slot[]): string {
  const names = BOARD_ORDER.filter((slot) => slots.includes(slot)).map((slot) => LEVEL_NAME[slot]);
  return names.length === 0 ? "" : `${joined(names)} tasks`;
}

function joined(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * A level as the first mate reads it: the value its tools take, then the
 * word the captain reads, "high (Hard)", so what it says matches the screen.
 * Premium reads the same both ways.
 */
export function levelForFirstmate(slot: Slot): string {
  if (slot === "premium") return slot;
  const name = LEVEL_NAME[slot];
  return `${slot} (${name.charAt(0).toUpperCase()}${name.slice(1)})`;
}
