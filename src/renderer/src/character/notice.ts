// The "new card" notice pulse (WI-18): one soft ring of light swelling out of
// the character and a brief lift of its ambient glow, played when a card
// lands on the stack unseen. The character sits dimmed behind the cards
// then, so the pulse reads as light through the acrylic - calm, one-shot,
// slow (the design's drift range), never a bounce.
//
// DOM-free and time-injected, like the machine.

/** How long one pulse runs, in ms. */
export const NOTICE_DURATION_MS = 1400;

export type NoticeFrame = {
  /** 0..1 strength of the pulse at this moment (0 = none). */
  strength: number;
  /** 0..1 how far the ring has travelled outward. */
  spread: number;
};

const NONE: NoticeFrame = { strength: 0, spread: 0 };

/**
 * The pulse at `elapsedMs` since it was requested: a quick rise (first
 * 18%), then a long eased fade while the ring keeps drifting outward.
 */
export function noticeFrame(elapsedMs: number): NoticeFrame {
  if (!(elapsedMs >= 0) || elapsedMs >= NOTICE_DURATION_MS) return NONE;
  const t = elapsedMs / NOTICE_DURATION_MS;
  const rise = 0.18;
  const strength = t < rise ? t / rise : (1 - (t - rise) / (1 - rise)) ** 2;
  const spread = 1 - (1 - t) ** 3;
  return { strength, spread };
}
