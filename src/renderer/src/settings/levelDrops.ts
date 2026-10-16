import { SLOTS, type Slot, type SlotModelView } from "../../../shared/modelSlots";

/**
 * What a drag on the Models board means (Settings → Intelligence → Models).
 * A model pill is picked up from one level, or from Not in use, and dropped
 * on another; the board says what the drop will do before it happens, and
 * this is the one place that decides it.
 */

/** Where a pill sits or lands: one of the four levels, or Not in use. */
export type LevelTarget = Slot | "off";

export type DropPlan =
  /** Leaves the level it was picked up from and joins the one it lands on. */
  | { kind: "move"; from: Slot; to: Slot; label: string }
  /** Joins the level it lands on and keeps every level it already has. */
  | { kind: "add"; to: Slot; label: string }
  /** Leaves every level at once: the drop on Not in use. */
  | { kind: "remove-all"; label: string }
  /** Nothing to do, said out loud so the drop is not a surprise. */
  | { kind: "none"; label: string };

/** The levels in board order, in words: "high", "high and medium", "premium, high and low". */
export function levelList(slots: readonly Slot[]): string {
  const ordered = SLOTS.filter((slot) => slots.includes(slot));
  if (ordered.length <= 1) return ordered[0] ?? "";
  return `${ordered.slice(0, -1).join(", ")} and ${ordered[ordered.length - 1]}`;
}

/**
 * What dropping `model` on `to` does when it was picked up from `from`.
 * A plain drag moves; `keepBoth` (⌥ held at the drop) adds instead, so the
 * model is used at both levels. Returns null over the place it came from.
 */
export function dropPlan(
  model: Pick<SlotModelView, "slots">,
  from: LevelTarget,
  to: LevelTarget,
  keepBoth: boolean,
): DropPlan | null {
  if (to === from) return null;
  if (to === "off") {
    return { kind: "remove-all", label: `Remove from ${levelList(model.slots)}` };
  }
  if (model.slots.includes(to)) return { kind: "none", label: `Already at ${to}` };
  if (from === "off") return { kind: "add", to, label: `Use at ${to}` };
  if (keepBoth) return { kind: "add", to, label: `Also use at ${to}` };
  return { kind: "move", from, to, label: `Move to ${to}` };
}

/**
 * The provider's name before a model's label on a pill, or nothing when the
 * label already starts with it ("Claude Opus 5.5" on Claude, "Grok 4.7" on
 * Grok). The same model on two providers is two offerings, so the name is
 * dropped only where it would repeat.
 */
export function providerPrefix(model: Pick<SlotModelView, "providerLabel" | "label">): string {
  return model.label.toLowerCase().startsWith(model.providerLabel.toLowerCase())
    ? ""
    : model.providerLabel;
}

/** How the always-use banner opens, before the model's name. */
export const ALWAYS_USE_LEAD = "All crew work goes to";

/** What the panel's Remove from all levels takes the model out of. */
export function removeAllLine(model: Pick<SlotModelView, "slots">): string {
  return model.slots.length > 0
    ? `It leaves ${levelList(model.slots)} at once.`
    : "It is not in any level.";
}

/** One line on where a model is used, for its panel. */
export function usedLine(model: Pick<SlotModelView, "slots" | "isNew">): string {
  if (model.slots.length > 0) return `Used at ${levelList(model.slots)}.`;
  return model.isNew
    ? "New here. It is not in use until you give it a level."
    : "Not in use. It is never picked on its own.";
}
