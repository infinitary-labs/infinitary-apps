import { describe, expect, it } from "vitest";
import {
  CARD_OVERLAY_DEFAULT_KEY,
  OVERLAY_EDGE,
  OVERLAY_WIDTH,
  overlayBounds,
  overlayKeyAllowed,
  overlayRunsCommand,
} from "./cardOverlay";

// Intent: INF-7063's plan - "Draw just the stack: a 560-point card, 24 points
// from the trailing edge"; a summon key no game's movement or a field presses;
// "Keep the peeks, pager, replies, fields, thread and host choices", and no key
// that reaches past the card.

describe("overlayKeyAllowed", () => {
  it("takes the default key and any chord with Control, Option or Command", () => {
    expect(overlayKeyAllowed(CARD_OVERLAY_DEFAULT_KEY)).toBe(true);
    expect(overlayKeyAllowed({ key: "g", alt: true })).toBe(true);
    expect(overlayKeyAllowed({ key: "F5", meta: true })).toBe(true);
  });

  it("refuses a plain or Shift-only key, and Escape, Tab, Return, Space and Delete", () => {
    expect(overlayKeyAllowed({ key: "o" })).toBe(false);
    expect(overlayKeyAllowed({ key: "W", shift: true })).toBe(false);
    for (const key of ["Escape", "Tab", "Enter", " ", "Backspace"])
      expect(overlayKeyAllowed({ key, ctrl: true })).toBe(false);
  });
});

describe("overlayBounds", () => {
  const display = { x: 0, y: 25, width: 1512, height: 920 };

  it("puts the card 24 points from the right edge, the full work area tall", () => {
    const bounds = overlayBounds(display);
    // The card is 560 wide, centred in the panel: its right edge is the panel's less half the spare width.
    const cardRight = bounds.x + bounds.width - (bounds.width - 560) / 2;
    expect(display.x + display.width - cardRight).toBe(24);
    expect(bounds.y).toBe(25);
    expect(bounds.height).toBe(920);
  });

  it("puts it 24 points from the left edge in a right-to-left language", () => {
    const bounds = overlayBounds({ x: -1440, y: 0, width: 1440, height: 900 }, true);
    const cardLeft = bounds.x + (bounds.width - 560) / 2;
    expect(cardLeft - -1440).toBe(24);
  });

  it("stays inside a display narrower than the panel", () => {
    const bounds = overlayBounds({ x: 0, y: 0, width: 500, height: 700 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 500, height: 700 });
    expect(OVERLAY_WIDTH).toBeGreaterThan(500);
    expect(OVERLAY_EDGE).toBe(24);
  });

  it("takes the display's whole work area for a card made large", () => {
    // The plan's deliberate expansion: wide content gets the display, not the 560-point panel.
    expect(overlayBounds(display, false, true)).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
    expect(overlayBounds(display, true, true)).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });
});

describe("overlayRunsCommand", () => {
  it("runs the shown card's keys and none that reach past the card", () => {
    expect(overlayRunsCommand("cards.next")).toBe(true);
    expect(overlayRunsCommand("focus.card-actions")).toBe(true);
    expect(overlayRunsCommand("cards.show-activity")).toBe(false);
    expect(overlayRunsCommand("focus.main-message")).toBe(false);
  });
});
