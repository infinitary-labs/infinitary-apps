// Pointing at the crew's measures (FI3-398; ./hover.ts): pure numbers, so
// the crew hover e2e reads the summary's beat from them.

export const CREW_HOVER = {
  /** The pointer is on a crewmate within its glyph's half-size plus this, px... */
  padPx: 8,
  /** ...and never within less than this, px. */
  minPx: 18,
  /** It stays on that crewmate out to this many times the acquire radius. */
  release: 1.6,
  /**
   * The stage slows this far outside an occupied orbit or from a crewmate,
   * px: past the reach of the largest glyph, so it slows just before the
   * pointer lands.
   */
  zoneMarginPx: 28,
  /** The summary opens this long after the pointer lands, ms. */
  dwellMs: 130,
  /** The corner brackets stand this far outside the glyph, px. */
  bracketPadPx: 4,
  /** Clear air between the crewmate and its summary, where the hairline runs, px. */
  leadPx: 14,
  /** The summary is never wider than this, px; a longer line ends in an ellipsis. */
  maxWidthPx: 360,
};
