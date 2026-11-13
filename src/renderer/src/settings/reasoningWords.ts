import { levelList } from "@shared/levelWords";
import type { Slot, SlotModelView } from "@shared/modelSlots";

export const USE_LEVEL_DEFAULT = "Auto";
export function reasoningLabel(model: SlotModelView, slot: Slot) {
  return `${model.providerLabel} ${model.label} reasoning for ${levelList([slot])}`;
}
