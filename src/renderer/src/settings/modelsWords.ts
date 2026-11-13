import * as m from "@shared/i18n/messages.generated";
import type { Slot } from "@shared/modelSlots";
import { levelList } from "./levelDrops";

/** The Models section's words (`ModelsSection.tsx`, `DecisionsGroup.tsx`). */
export const MODELS_WORDS = {
  /** The header summary while no levels are chosen. */
  get startingLevelsSummary() {
    return m.settingsModelsStartingLevelsSummary();
  },
  get notInUse() {
    return m.settingsModelsNotInUse();
  },
  /** The Decisions row's menu item that opens the OpenRouter picker, offered while OpenRouter has models. */
  get useOpenRouterDecisionModel() {
    return m.settingsDecisionsUseOpenRouter();
  },
  /** The consent dialog's rows for a decision model's approval, in the order `DecisionConsentText` holds them. */
  get decisionDisclosureLabels(): readonly [string, string, string] {
    return [
      m.settingsDecisionsDisclosureShared(),
      m.settingsDecisionsDisclosureChoice(),
      m.settingsDecisionsDisclosureCost(),
    ];
  },
} as const;

/**
 * The Models card's reset at its foot: the first press arms it, the second
 * resets, and Cancel puts it back unpressed, as the provider row's reset in
 * Subscriptions offers.
 */
export const STARTING_LEVELS_RESET = {
  get reset() {
    return m.settingsModelsReset();
  },
  get confirm() {
    return m.settingsModelsResetConfirm();
  },
  get cancel() {
    return m.settingsModelsResetCancel();
  },
  get note() {
    return m.settingsModelsResetNote();
  },
} as const;

/** The Decisions group's Uses list (`src/shared/decisionUses.ts`), also read by its keyboard journey. */
export const DECISION_USES_WORDS = {
  get group() {
    return m.settingsDecisionsUses();
  },
  get locked() {
    return m.settingsDecisionsUsesLocked();
  },
  /** Under a use the answering model's approval predates. */
  needsApproval: (model: string) => m.settingsDecisionsUsesNeedsApproval({ model }),
  /** The consent dialog's title for that one-time OK, quoting the use's name as Settings shows it. */
  allowTitle: (use: string, model: string) => m.settingsDecisionsUsesAllowTitle({ use, model }),
  get allow() {
    return m.settingsDecisionsUsesAllow();
  },
  get turnOn() {
    return m.settingsDecisionsUsesTurnOn();
  },
  /** A turn-on control's title, naming what it turns on. */
  turnOnNamed: (name: string) => m.settingsDecisionsUsesTurnOnNamed({ name }),
} as const;

/** What a pill's × says on rest and in its description: it leaves the other levels alone. */
export function removeFromLevelOnly(level: Slot): string {
  return m.settingsLevelsRemoveFromLevelOnly({ level: levelList([level]) });
}
