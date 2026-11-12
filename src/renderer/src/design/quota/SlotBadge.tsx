import * as m from "@shared/i18n/messages.generated";
import type { Slot } from "@shared/modelSlots";
import type React from "react";

export type IntelligenceBucket = Slot;

export type SlotBadgeProps = {
  slot?: Slot;
  style?: React.CSSProperties;
};

/** @deprecated Use SlotBadgeProps. */
export type BucketBadgeProps = {
  bucket?: Slot;
  style?: React.CSSProperties;
};

/**
 * The celestial scale, strongest first: supernova (lava) · sun · earth ·
 * moon. `premium` is the slot routing reaches only because the user asked
 * for it, so it takes the hot family's lava end - an opt-in choice should
 * not look like a routed one.
 */
const slotMeta: Record<Slot, { readonly label: string; color: string; bars: number }> = {
  premium: {
    get label() {
      return m.uiSlotPremium();
    },
    color: "var(--slot-premium)",
    bars: 4,
  },
  high: {
    get label() {
      return m.uiSlotHigh();
    },
    color: "var(--slot-high)",
    bars: 3,
  },
  medium: {
    get label() {
      return m.uiSlotMedium();
    },
    color: "var(--slot-medium)",
    bars: 2,
  },
  low: {
    get label() {
      return m.uiSlotLow();
    },
    color: "var(--slot-low)",
    bars: 1,
  },
};

export function SlotBadge({ slot = "medium", style }: SlotBadgeProps) {
  const b = slotMeta[slot] || slotMeta.medium;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        letterSpacing: "var(--tracking-label)",
        textTransform: "uppercase",
        color: b.color,
        ...style,
      }}
    >
      <span style={{ display: "inline-flex", gap: 2, alignItems: "flex-end" }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: 4 + i * 2,
              borderRadius: 1,
              background: i < b.bars ? b.color : "var(--bg-3)",
            }}
          />
        ))}
      </span>
      {b.label}
    </span>
  );
}

/** @deprecated Use SlotBadge. */
export function BucketBadge({ bucket = "medium", style }: BucketBadgeProps) {
  return <SlotBadge slot={bucket} style={style} />;
}
