import { type AppCostLimitView, formatUsd } from "@shared/costLimit";
import { formatNumber } from "@shared/i18n/format";

/** Settings → Intelligence's cost limit row (`CostLimitRow.tsx`; docs/usage.md, "The cost limit"). */
export const COST_LIMIT_WORDS = {
  title: "Ask before a task spends more than",
  switchLabel: "Ask before a task spends more",
  amountLabel: "Most a task spends before it asks, in dollars",
} as const;

/** What the row says under its title: what the limit does, and what it would have asked about. */
export function costLimitDescription(view: AppCostLimitView | null): string {
  if (!view)
    return "A task and the work under it stop at a safe point and ask you before they spend more.";
  if (!("usd" in view.limit))
    return "Tasks never stop to ask about cost. Turn this on to have a task ask you before it spends more.";
  const { asked, tasks, days } = view.recent;
  const recent =
    tasks === 0
      ? ""
      : ` In the last ${days} days, ${formatNumber(asked)} of ${formatNumber(tasks)} tasks would have asked.`;
  return `A task and the work under it stop at a safe point and ask you once their estimated spend passes ${formatUsd(view.limit.usd)}, as Settings → Usage estimates it.${recent}`;
}
