import type React from "react";
import { Badge, type BadgeTone } from "../core/Badge";
import { QuotaMeter, type QuotaPace } from "./QuotaMeter";
import { type IntelligenceBucket, SlotBadge } from "./SlotBadge";

export type SubscriptionStatus = "fresh" | "stale" | "auth_required" | "rate_limited" | "error";

export type SubscriptionWindow = {
  label: string;
  percentRemaining?: number;
  pace?: QuotaPace;
  resetText?: string;
};

export type SubscriptionModel = {
  label: string;
  slot: IntelligenceBucket;
  /** User pin: this model always wins routing for its slot. */
  override?: boolean;
};

export type SubscriptionCardProps = {
  provider: string;
  plan?: string;
  account?: string;
  status?: SubscriptionStatus;
  windows?: SubscriptionWindow[];
  models?: SubscriptionModel[];
  /** When set, model rows become buttons that toggle the pin for that label. */
  onToggleModel?: (label: string) => void;
  width?: number | string;
  style?: React.CSSProperties;
};

export function SubscriptionCard({
  provider,
  plan,
  account,
  status = "fresh",
  windows = [],
  models = [],
  onToggleModel,
  width = 340,
  style,
}: SubscriptionCardProps) {
  const stateTone: BadgeTone = status === "fresh" ? "ok" : status === "stale" ? "warn" : "danger";
  const stateLabel =
    status === "fresh" ? "live" : status === "stale" ? "stale" : status.replace("_", " ");
  return (
    <div
      style={{
        width,
        boxSizing: "border-box",
        background: "var(--surface-card)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-l)",
        boxShadow: "var(--shadow-2)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        ...style,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: "var(--text-md)", fontWeight: 600, color: "var(--fg-1)" }}>
            {provider}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {plan}
            {account ? ` · ${account}` : ""}
          </span>
        </div>
        <Badge tone={stateTone} dot mono>
          {stateLabel}
        </Badge>
      </div>
      {windows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {windows.map((w) => (
            <QuotaMeter key={w.label} {...w} />
          ))}
        </div>
      )}
      {models.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderTop: "1px solid var(--line-1)",
            paddingTop: 12,
          }}
        >
          {models.map((m) => (
            <div
              key={m.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              {onToggleModel ? (
                <button
                  type="button"
                  onClick={() => onToggleModel(m.label)}
                  title={m.override ? "Unpin model" : "Pin model"}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: m.override ? "var(--accent)" : "var(--fg-2)",
                  }}
                >
                  {m.label}
                  {m.override ? " ✱" : ""}
                </button>
              ) : (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: m.override ? "var(--accent)" : "var(--fg-2)",
                  }}
                >
                  {m.label}
                  {m.override ? " ✱" : ""}
                </span>
              )}
              <SlotBadge slot={m.slot} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
