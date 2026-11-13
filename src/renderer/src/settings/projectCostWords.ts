import * as m from "@shared/i18n/messages.generated";

export const PROJECT_COST_WORDS = {
  get title() {
    return m.settingsProjectsCostTitle();
  },
  get description() {
    return m.settingsProjectsCostDescription();
  },
  get choices() {
    return [
      { value: "follow", label: m.settingsProjectsCostFollow() },
      { value: "amount", label: m.settingsProjectsCostOwn() },
      { value: "none", label: m.settingsProjectsCostNone() },
    ] as const;
  },
  get amount() {
    return m.settingsProjectsCostAmount();
  },
} as const;
