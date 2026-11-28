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

  it("takes half the screen, never less than a regular card at the Size setting, nor more than the screen", () => {
    // INF-7215's plan, the captain's pick "Half": a 27-inch 2560-point display,
    // a 16-inch MacBook Pro's 1728 and a 13-inch MacBook Air's 1470, at each
    // Size the captain may pick; 592 x zoom is a 560-point card and its air.
    const widths: [number, number, number][] = [
      [2560, 1, 1280],
      [2560, 1.1, 1280],
      [2560, 1.25, 1280],
      [1728, 1, 864],
      [1728, 1.1, 864],
      [1728, 1.25, 864],
      [1470, 1, 735],
      [1470, 1.1, 735],
      [1470, 1.25, 740],
      [1100, 1.5, 888],
      [700, 1.5, 700],
    ];
    for (const [screen, zoom, width] of widths)
      expect(
        overlayBounds({ x: 0, y: 25, width: screen, height: 900 }, false, false, zoom).width,
        `${screen} points at ${zoom * 100}%`,
      ).toBe(width);
  });

  it("puts the card 24 points from the right edge, the full work area tall", () => {
    const bounds = overlayBounds(display);
    // The card hugs the panel's trailing edge, 16 points of the stage's air in (overlay.css).
    expect(display.x + display.width - (bounds.x + bounds.width - 16)).toBe(24);
    expect(bounds.y).toBe(25);
    expect(bounds.height).toBe(920);
  });

  it("puts it 24 points from the left edge in a right-to-left language", () => {
    const bounds = overlayBounds({ x: -1440, y: 0, width: 1440, height: 900 }, true);
    expect(bounds.x + 16 - -1440).toBe(24);
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
