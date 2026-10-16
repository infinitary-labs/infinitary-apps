import type { Slot, SlotModelView } from "@shared/modelSlots";

export const USE_LEVEL_DEFAULT = "Auto";
export function reasoningLabel(model: SlotModelView, slot: Slot) {
  return `${model.providerLabel} ${model.label} at ${slot} reasoning`;
}
