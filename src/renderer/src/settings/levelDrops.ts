import { formatList } from "../../../shared/i18n/format";
import * as m from "../../../shared/i18n/messages.generated";
import { levelWord } from "../../../shared/levelWords";
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

/** The task difficulty wording in the selected language, in board order. */
export function levelList(slots: readonly Slot[]): string {
  const names = SLOTS.filter((slot) => slots.includes(slot)).map((slot) =>
    levelWord(slot).toLocaleLowerCase(),
  );
  return names.length === 0 ? "" : m.settingsLevelTasks({ levels: formatList(names) });
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
    return {
      kind: "remove-all",
      label: m.settingsLevelsDropRemove({ levels: levelList(model.slots) }),
    };
  }
  if (model.slots.includes(to))
    return { kind: "none", label: m.settingsLevelsDropAlready({ level: levelList([to]) }) };
  if (from === "off")
    return { kind: "add", to, label: m.settingsLevelsDropUse({ level: levelList([to]) }) };
  if (keepBoth)
    return { kind: "add", to, label: m.settingsLevelsDropAlso({ level: levelList([to]) }) };
  return { kind: "move", from, to, label: m.settingsLevelsDropMove({ level: levelList([to]) }) };
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

/**
 * The always-use banner while Dynamic routing is on: every crew task goes to
 * `first`, or to `second` when `first` cannot take the work.
 */
export function alwaysUseBanner(first: string, second?: string): string {
  return second === undefined
    ? m.settingsLevelsAlwaysUseBanner({ first })
    : m.settingsLevelsAlwaysUseBannerTwo({ first, second });
}

/** What the panel's Remove from all levels takes the model out of. */
export function removeAllLine(model: Pick<SlotModelView, "slots">): string {
  return model.slots.length > 0
    ? m.settingsLevelsRemoveAllLine({ levels: levelList(model.slots) })
    : m.settingsLevelsRemoveAllNone();
}

/**
 * What a new model's "new" says, on its pill wherever the pill sits and in
 * its panel: where the model is used now. An arrival the starter levels
 * placed is already in use there; one they did not place waits for a level.
 */
export function newModelNote(model: Pick<SlotModelView, "slots">): string {
  return model.slots.length > 0
    ? m.settingsLevelsNewUsedAt({ levels: levelList(model.slots) })
    : m.settingsLevelsNewNotInUse();
}

/** One line on where a model is used, for its panel. */
export function usedLine(model: Pick<SlotModelView, "slots" | "isNew">): string {
  if (model.isNew) return newModelNote(model);
  return model.slots.length > 0
    ? m.settingsLevelsUsedAt({ levels: levelList(model.slots) })
    : m.settingsLevelsUsedNone();
}
