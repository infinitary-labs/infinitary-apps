import type { PanelProps } from "@firstmate/contracts";
import { MicroLabel } from "@firstmate/ui";
import { useEffect, useState } from "react";

/**
 * The `clock-timer-scratchpad` skill's fixture: state a panel derives rather
 * than stores. No server half, no store, no data source - and it is useful
 * when nothing is happening, so its presence is `always`.
 */
const ZONE = "Asia/Tokyo";

/** Hours and minutes only, so the panel repaints once a minute, not sixty times. */
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
});
const day = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "short" });

export default function Panel(_props: PanelProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <MicroLabel>{day.format(now)}</MicroLabel>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-lg)",
          color: "var(--fg-1)",
          lineHeight: "var(--leading-tight)",
        }}
      >
        {clock.format(now)}
      </span>
    </div>
  );
}
