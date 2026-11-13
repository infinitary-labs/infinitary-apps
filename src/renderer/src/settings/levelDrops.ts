import { levelList } from "../../../shared/levelWords";
import type { Slot, SlotModelView } from "../../../shared/modelSlots";

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

/** The levels in board order, as the work they take (`levelList`, the one wording). */
export { levelList };

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
    return { kind: "remove-all", label: `Stop using for ${levelList(model.slots)}` };
  }
  if (model.slots.includes(to)) return { kind: "none", label: `Already takes ${levelList([to])}` };
  if (from === "off") return { kind: "add", to, label: `Use for ${levelList([to])}` };
  if (keepBoth) return { kind: "add", to, label: `Also use for ${levelList([to])}` };
  return { kind: "move", from, to, label: `Move to ${levelList([to])}` };
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

/** INF-910 direction A: split display words only; stored and accessible labels stay intact. */
export function chipDisplayParts(model: Pick<SlotModelView, "providerLabel" | "label">): {
  provider: string;
  label: string;
} {
  const { providerLabel: provider, label } = model;
  const rest = label.slice(provider.length);
  const matches =
    provider.length > 0 &&
    label.slice(0, provider.length).toLowerCase() === provider.toLowerCase() &&
    !/^[\p{L}\p{N}_]/u.test(rest);
  return { provider, label: matches ? rest.trimStart() : label };
}

/** How the always-use banner opens, before the model's name. */
export const ALWAYS_USE_LEAD = "All crew work goes to";

/** What the panel's Remove from all levels takes the model out of. */
export function removeAllLine(model: Pick<SlotModelView, "slots">): string {
  return model.slots.length > 0
    ? `It stops taking ${levelList(model.slots)} at once.`
    : "It is not in any level.";
}

/**
 * What a new model's "new" says, on its pill wherever the pill sits and in
 * its panel: where the model is used now. An arrival the starter levels
 * placed is already in use there; one they did not place waits for a level.
 */
export function newModelNote(model: Pick<SlotModelView, "slots">): string {
  return model.slots.length > 0
    ? `New here - it takes ${levelList(model.slots)}.`
    : "New here - it is not in use until you give it a level.";
}

/** One line on where a model is used, for its panel. */
export function usedLine(model: Pick<SlotModelView, "slots" | "isNew">): string {
  if (model.isNew) return newModelNote(model);
  return model.slots.length > 0
    ? `Takes ${levelList(model.slots)}.`
    : "Not in use. It is never picked on its own.";
}
