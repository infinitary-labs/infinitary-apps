import type { PanelProps, PanelQuotaProvider, PanelQuotaSnapshot } from "@firstmate/contracts";
import { Empty, MicroLabel, QuotaMicroMeter } from "@firstmate/ui";
import { useEffect, useState } from "react";
import { age, rowsOf } from "./quota";

/**
 * The `quota` skill's fixture: the app's own reading through the
 * `quota.snapshot` read, one line per window through the app's own
 * instrument, under a label naming the provider and the account. The
 * honesty rules are the point - an unread window is "–" and never 0%, a
 * carried-forward reading dims and says its age, and a row with no window
 * renders what the sensor said about that read.
 */
function Windows({ provider, now }: { provider: PanelQuotaProvider; now: number }) {
  if (provider.windows.length === 0) {
    return (
      <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {provider.status === "auth_required" ? "Sign in again" : provider.detail}
      </span>
    );
  }
  return (
    <>
      {provider.windows.map((window) => (
        <QuotaMicroMeter
          key={window.id}
          label={window.label}
          percentRemaining={window.percentRemaining}
          pace={window.pace}
          resetText={window.resetText}
          stale={provider.stale}
        />
      ))}
      {provider.stale && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
          {age(provider.measuredAt, now)}
        </span>
      )}
    </>
  );
}

export default function Panel({ reads }: PanelProps) {
  const [snapshot, setSnapshot] = useState<PanelQuotaSnapshot>(null);
  const [readAt, setReadAt] = useState(() => Date.now());
  useEffect(
    () =>
      reads.subscribe("quota.snapshot", (value) => {
        setSnapshot(value);
        setReadAt(Date.now());
      }),
    [reads],
  );
  const providers = rowsOf(snapshot);
  if (providers.length === 0) return <Empty>No subscriptions to show</Empty>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {providers.map((provider) => (
        <div
          key={`${provider.provider}-${provider.accountLabel ?? ""}`}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
        >
          <MicroLabel>
            {provider.accountLabel
              ? `${provider.label} · ${provider.accountLabel}`
              : provider.label}
          </MicroLabel>
          <Windows provider={provider} now={readAt} />
        </div>
      ))}
    </div>
  );
}
