/**
 * @startingPoint section="Quota" subtitle="One AI subscription: plan, quota windows, model buckets" viewport="700x420"
 */
export interface SubscriptionCardProps {
  /** Provider label: "Claude", "Codex", "Grok", "OpenRouter". */
  provider?: string;
  /** e.g. "Max 20x". */
  plan?: string;
  /** e.g. "kun@…com". */
  account?: string;
  /** Provider quota status. */
  status?: "fresh" | "stale" | "auth_required" | "rate_limited" | "error";
  windows?: Array<{ label?: string; percentRemaining?: number; pace?: "ahead" | "on_pace" | "behind" | "unknown"; resetText?: string }>;
  /** override: true marks a user-pinned model (shown with ✱ in accent). */
  models?: Array<{ label: string; bucket: "high" | "medium" | "low"; override?: boolean }>;
  /** When set, model rows become buttons that toggle the pin for that label. */
  onToggleModel?: (label: string) => void;
  width?: number | string;
  style?: React.CSSProperties;
}
