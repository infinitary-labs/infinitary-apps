import * as m from "@shared/i18n/messages.generated";
import type { Slot, SlotModelView } from "@shared/modelSlots";
import { levelList } from "./levelDrops";

export const REASONING_WORDS = {
  /** The reasoning choice that follows the level's own default. */
  get useLevelDefault() {
    return m.settingsReasoningAuto();
  },
} as const;
export function reasoningLabel(model: SlotModelView, slot: Slot) {
  return m.settingsReasoningLabel({
    provider: model.providerLabel,
    model: model.label,
    slot: levelList([slot]),
  });
}
