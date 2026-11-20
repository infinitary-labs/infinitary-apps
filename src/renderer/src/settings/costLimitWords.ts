import { type AppCostLimitView, formatUsd } from "@shared/costLimit";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/** Settings → Intelligence's cost limit row (`CostLimitRow.tsx`; docs/usage.md, "The cost limit"). */
export const COST_LIMIT_WORDS = {
  get title() {
    return m.settingsCostLimitTitle();
  },
  get switchLabel() {
    return m.settingsCostLimitSwitchLabel();
  },
  get amountLabel() {
    return m.settingsCostLimitAmountLabel();
  },
} as const;

/** What the row says under its title: what the limit does, and what it would have asked about. */
export function costLimitDescription(view: AppCostLimitView | null): string {
  if (!view) return m.settingsCostLimitDescriptionUnread();
  if (!("usd" in view.limit)) return m.settingsCostLimitDescriptionOff();
  const { asked, tasks, days } = view.recent;
  const limit = formatUsd(view.limit.usd);
  if (tasks === 0) return m.settingsCostLimitDescription({ limit });
  return m.settingsCostLimitDescriptionRecent({
    limit,
    days: String(days),
    asked: formatNumber(asked),
    tasks: formatNumber(tasks),
  });
}
