import { describe, expect, it } from "vitest";
import {
  CARD_DRAG_MIN,
  CARD_SIZES,
  type CardPlacement,
  cardPlacement,
  cardWidthFor,
  centeredRailsWidth,
  maximizedPlacement,
  requestedCardWidth,
  requestPlacement,
  shownCardSize,
} from "./cardGeometry";
import {
  CARD_MIN,
  cardWidth,
  THREAD_MAX,
  THREAD_MIN,
  THREAD_STAGE_MARGIN,
  threadPlacement,
} from "./threadGeometry";

/**
 * The binding evidence for the shell half of cards-as-threads phase 1: the
 * R3.1 ladder table, at the four window sizes the captain reviewed, with
 * both docks, one dock and none.
 *
 * An expanded docked rail is max(300px, 20vw); a collapsed header reserves
 * no card clearance. The shell reserves twice the larger expanded rail.
 */
const RAIL = (windowWidth: number) => Math.max(300, 0.2 * windowWidth);

const BOTH = (w: number) => RAIL(w) * 2;
const ONE = (w: number) => RAIL(w) * 2;
const NONE = () => 0;

describe("where a card's thread goes (R3.1)", () => {
  const table: {
    window: number;
    rails: (w: number) => number;
    docks: string;
    folded: boolean;
    card: number;
    thread: number;
  }[] = [
    // 960x640, the window minimum: folds with any dock up, fits with none.
    { window: 960, rails: BOTH, docks: "both", folded: true, card: 560, thread: 360 },
    { window: 960, rails: ONE, docks: "one", folded: true, card: 560, thread: 360 },
    { window: 960, rails: NONE, docks: "none", folded: false, card: 560, thread: 360 },
    // 1200x800: either expanded side needs symmetric clearance, so folds.
    { window: 1200, rails: BOTH, docks: "both", folded: true, card: 560, thread: 360 },
    { window: 1200, rails: ONE, docks: "one", folded: true, card: 560, thread: 360 },
    { window: 1200, rails: NONE, docks: "none", folded: false, card: 560, thread: 360 },
    // 1440x900, a 13" full screen: both docks fit, the card gives up 88px.
    { window: 1440, rails: BOTH, docks: "both", folded: false, card: 472, thread: 336 },
    { window: 1440, rails: ONE, docks: "one", folded: false, card: 472, thread: 336 },
    { window: 1440, rails: NONE, docks: "none", folded: false, card: 560, thread: 360 },
    // 1728x1000, a 16": everything fits at full size.
    { window: 1728, rails: BOTH, docks: "both", folded: false, card: 560, thread: 360 },
    { window: 1728, rails: ONE, docks: "one", folded: false, card: 560, thread: 360 },
    { window: 1728, rails: NONE, docks: "none", folded: false, card: 560, thread: 360 },
  ];

  for (const row of table) {
    it(`${row.window}px with ${row.docks}: ${row.folded ? "folds, " : ""}${row.card} + ${row.thread}`, () => {
      expect(threadPlacement(row.window, row.rails(row.window))).toEqual({
        home: "beside",
        folded: row.folded,
        card: row.card,
        thread: row.thread,
      });
    });
  }

  it("never leaves the card under its floor on any rung of the table", () => {
    for (const row of table) {
      const placed = threadPlacement(row.window, row.rails(row.window));
      expect(placed.card).toBeGreaterThanOrEqual(CARD_MIN);
    }
  });

  it("holds the thread column between its two bounds", () => {
    for (let width = 700; width <= 2560; width += 7) {
      const placed = threadPlacement(width, 0);
      if (placed.home !== "beside") continue;
      expect(placed.thread).toBeGreaterThanOrEqual(THREAD_MIN);
      expect(placed.thread).toBeLessThanOrEqual(THREAD_MAX);
    }
  });

  it("reaches the in-place rung only below a 720px stage, which the app's 960px minimum forbids", () => {
    // 700x560 is the prototype's below-the-minimum preset; the app cannot
    // open a window this narrow (src/main/app.ts sets the minimum).
    expect(threadPlacement(700, 0).home).toBe("in-place");
    expect(threadPlacement(720, 0).home).toBe("beside");
    // At the real minimum, with both docks up, folding always saves it.
    expect(threadPlacement(960, BOTH(960)).home).toBe("beside");
  });

  it("gives an in-place card the width a card with no thread has", () => {
    const placed = threadPlacement(700, 0);
    expect(placed).toEqual({ home: "in-place", folded: false, card: cardWidth(700), thread: 0 });
  });
});

/**
 * A card as wide as its content (the captain's Q5 to Q7 A of 2026-09-28,
 * proposal 2 of `fm3000-card-decisions-width-s1`): the report's window/dock
 * table, walked with the rails the shell really docks. The report drew it
 * with 300px rails; at 1728 a rail is 20vw (345.6px), so the docked stage
 * there is 1036.8 and a full card 1004.8.
 */
describe("how wide a card is on the stage (Q5 to Q7)", () => {
  it("defaults to wide without folding docked panels, and uses each card's own width", () => {
    expect(requestedCardWidth({})).toBe(800);
    expect(cardPlacement(1200, 600, {})).toEqual({ folded: false, card: 568 });
    expect(cardPlacement(1512, 604.8, {})).toEqual({ folded: false, card: 800 });
    expect(cardPlacement(1200, 600, { width: "regular" })).toEqual({ folded: false, card: 560 });
    expect(cardPlacement(960, 600, {})).toEqual({ folded: true, card: 800 });
  });
  const regular = { width: "regular" as const };
  const wide = { width: "wide" as const };
  const full = { width: "full" as const };

  const table: {
    window: number;
    rails: (w: number) => number;
    docks: string;
    regular: CardPlacement;
    wide: CardPlacement;
    full: CardPlacement;
  }[] = [
    {
      window: 960,
      rails: BOTH,
      docks: "both",
      regular: { folded: true, card: 560 },
      wide: { folded: true, card: 800 },
      full: { folded: true, card: 928 },
    },
    {
      window: 960,
      rails: NONE,
      docks: "none",
      regular: { folded: false, card: 560 },
      wide: { folded: false, card: 800 },
      full: { folded: false, card: 928 },
    },
    {
      window: 1200,
      rails: BOTH,
      docks: "both",
      regular: { folded: false, card: 560 },
      wide: { folded: true, card: 800 },
      full: { folded: true, card: 1040 },
    },
    {
      window: 1200,
      rails: ONE,
      docks: "one",
      regular: { folded: false, card: 560 },
      wide: { folded: true, card: 800 },
      full: { folded: true, card: 1040 },
    },
    {
      window: 1440,
      rails: BOTH,
      docks: "both",
      regular: { folded: false, card: 560 },
      wide: { folded: false, card: 800 },
      full: { folded: false, card: 808 },
    },
    {
      window: 1728,
      rails: BOTH,
      docks: "both",
      regular: { folded: false, card: 560 },
      wide: { folded: false, card: 800 },
      full: { folded: false, card: 1004.8 },
    },
  ];

  for (const row of table) {
    it(`${row.window}px with ${row.docks}: ${row.regular.card} / ${row.wide.folded ? "fold, " : ""}${row.wide.card} / ${row.full.folded ? "fold, " : ""}${row.full.card}`, () => {
      const rails = row.rails(row.window);
      expect(cardPlacement(row.window, rails, regular)).toEqual(row.regular);
      expect(cardPlacement(row.window, rails, wide)).toEqual(row.wide);
      expect(cardPlacement(row.window, rails, full)).toEqual(row.full);
    });
  }

  it("folds a regular card only when short of room, and never folds an empty dock", () => {
    for (let width = 960; width <= 2560; width += 11) {
      expect(cardPlacement(width, BOTH(width), regular).folded).toBe(
        width - BOTH(width) - THREAD_STAGE_MARGIN < CARD_SIZES.regular,
      );
      expect(cardPlacement(width, 0, wide).folded).toBe(false);
      expect(cardPlacement(width, 0, full).folded).toBe(false);
    }
  });

  it("restores docked panels at the exact boundary for the tab's return to regular", () => {
    // The edge tab uses a regular drag, not a special folding override.
    // Either expanded rail needs symmetric clearance, including fractional
    // demand from window scaling; no fixed window-width threshold is valid.
    for (const [left, right] of [
      [300, 300],
      [300, 0],
      [0, 300],
      [312.5, 0],
    ] as const) {
      const rails = centeredRailsWidth(left, right);
      const fits = rails + 560 + 32;
      expect(cardPlacement(fits - 1, rails, { dragged: 560 })).toEqual({
        folded: true,
        card: 560,
      });
      expect(cardPlacement(fits, rails, { dragged: 560 })).toEqual({
        folded: false,
        card: 560,
      });
    }
  });

  it("folds a wider card exactly when the docked stage cannot give it 720px", () => {
    // 720 + 32 of margin is the docked stage a wide card needs.
    expect(cardPlacement(752 + 600, 600, wide)).toEqual({ folded: false, card: 720 });
    expect(cardPlacement(751 + 600, 600, wide)).toEqual({ folded: true, card: 800 });
  });

  it("clamps every size to the stage less its margin, as 560 always was", () => {
    for (let stage = 360; stage <= 2560; stage += 13) {
      for (const card of [regular, wide, full]) {
        expect(cardWidthFor(card, stage)).toBeLessThanOrEqual(stage - THREAD_STAGE_MARGIN);
        expect(cardWidthFor(card, stage)).toBeLessThanOrEqual(CARD_SIZES.full);
      }
    }
    expect(cardWidthFor(full, 2560)).toBe(1040);
  });

  it("takes the captain's drag over the host's size, between 480 and full", () => {
    expect(requestedCardWidth({ width: "wide", dragged: 640 })).toBe(640);
    // Narrower than the facts is his to choose; the hint alone could not.
    expect(requestedCardWidth({ width: "full", dragged: 500 })).toBe(500);
    expect(requestedCardWidth({ dragged: 200 })).toBe(CARD_DRAG_MIN);
    expect(requestedCardWidth({ dragged: 5000 })).toBe(CARD_SIZES.full);
    // A drag the docked stage can hold never folds it; one past it does, and
    // a drag back to regular unfolds.
    expect(cardPlacement(1440, BOTH(1440), { dragged: 700 })).toEqual({ folded: false, card: 700 });
    expect(cardPlacement(1200, BOTH(1200), { dragged: 700 })).toEqual({ folded: true, card: 700 });
    expect(cardPlacement(1200, BOTH(1200), { dragged: 560 })).toEqual({ folded: false, card: 560 });
  });

  it("gives the thread pair the card's width in place of 560", () => {
    // 1728 with no docks: the stage has room for a wide card beside its thread.
    expect(threadPlacement(1728, 0, CARD_SIZES.wide)).toEqual({
      home: "beside",
      folded: false,
      card: 800,
      thread: 360,
    });
    // 1440 with both docks: the card column takes what the stage leaves,
    // wide or not - the ladder's arithmetic is unchanged.
    expect(threadPlacement(1440, BOTH(1440), CARD_SIZES.wide)).toEqual(
      threadPlacement(1440, BOTH(1440)),
    );
    // Regular is today's ladder exactly.
    expect(threadPlacement(1200, ONE(1200), CARD_SIZES.regular)).toEqual(
      threadPlacement(1200, ONE(1200)),
    );
  });

  it("reserves symmetric clearance for a lone rail without shifting the card", () => {
    expect(centeredRailsWidth(300, 0)).toBe(600);
    expect(centeredRailsWidth(0, 300)).toBe(600);
    expect(centeredRailsWidth(300, 320)).toBe(640);
    expect(centeredRailsWidth(0, 0)).toBe(0);
    expect(cardPlacement(1200, centeredRailsWidth(300, 0), {})).toEqual({
      folded: false,
      card: 568,
    });
    expect(cardPlacement(1200, centeredRailsWidth(0, 0), {})).toEqual({ folded: false, card: 800 });
  });

  it("never lets a lone card reach under a rail, down to the narrowest window", () => {
    // 960 with both docks: fold them so the regular card remains readable.
    const narrow = cardPlacement(960, BOTH(960), regular);
    expect(narrow).toEqual({ folded: true, card: 560 });
    for (let window = 960; window <= 2560; window += 7) {
      const rail = RAIL(window);
      for (const [left, right] of [
        [rail, rail],
        [rail, 0],
        [0, rail],
        [0, 0],
      ] as const) {
        for (const card of [regular, wide, full, { dragged: CARD_DRAG_MIN }, { dragged: 5000 }]) {
          const placed = cardPlacement(window, centeredRailsWidth(left, right), card);
          // A folded rail occupies nothing, so the stage is the window.
          const [l, r] = placed.folded ? [0, 0] : [left, right];
          const start = (window - placed.card) / 2;
          expect(start).toBeGreaterThanOrEqual(l + THREAD_STAGE_MARGIN / 2 - 1e-9);
          expect(start + placed.card).toBeLessThanOrEqual(
            window - r - THREAD_STAGE_MARGIN / 2 + 1e-9,
          );
        }
      }
    }
  });

  it("keeps centered thread pairs clear of either expanded rail", () => {
    for (let window = 960; window <= 2560; window += 7) {
      const rail = RAIL(window);
      for (const [left, right] of [
        [rail, 0],
        [0, rail],
        [rail, rail],
        [0, 0],
      ] as const) {
        const placed = threadPlacement(window, centeredRailsWidth(left, right), CARD_SIZES.wide);
        const start = (window - placed.card - placed.thread) / 2;
        expect(start).toBeGreaterThanOrEqual(
          (placed.folded ? 0 : left) + THREAD_STAGE_MARGIN / 2 - 1e-9,
        );
        expect(start + placed.card + placed.thread).toBeLessThanOrEqual(
          window - (placed.folded ? 0 : right) - THREAD_STAGE_MARGIN / 2 + 1e-9,
        );
      }
    }
  });

  it("tells the frame the size the card is shown at", () => {
    expect(shownCardSize(328)).toBe("regular");
    expect(shownCardSize(560)).toBe("regular");
    expect(shownCardSize(700)).toBe("wide");
    expect(shownCardSize(800)).toBe("wide");
    expect(shownCardSize(1004.8)).toBe("full");
  });
});

describe("how wide a maximized card is (FI3-1133, extent A)", () => {
  it("takes the window less 16 px each side, whatever width it asked for", () => {
    for (const window of [960, 1200, 1440, 1728, 2560])
      expect(maximizedPlacement(window, false)).toEqual({
        home: "none",
        card: window - THREAD_STAGE_MARGIN,
        thread: 0,
      });
  });

  it("keeps an open thread at its own width beside it, and the card takes the rest", () => {
    expect(maximizedPlacement(960, true)).toEqual({ home: "beside", card: 568, thread: 360 });
    expect(maximizedPlacement(1440, true)).toEqual({ home: "beside", card: 1048, thread: 360 });
    for (let window = 960; window <= 2560; window += 11) {
      const placed = maximizedPlacement(window, true);
      expect(placed.thread).toBeGreaterThanOrEqual(THREAD_MIN);
      expect(placed.thread).toBeLessThanOrEqual(THREAD_MAX);
      expect(placed.card + placed.thread).toBe(window - THREAD_STAGE_MARGIN);
    }
  });

  it("puts the thread in place where the two cannot both fit, as the stage does", () => {
    expect(maximizedPlacement(700, true)).toEqual({ home: "in-place", card: 668, thread: 0 });
  });
});

/**
 * The request docked beside a browser's page (the captain's approved
 * direction A on INF-4578: "the page keeps up to 1,040 px"; "Narrow window:
 * the column folds to its latest line, Command-backslash opens it"), at the
 * window sizes the thread ladder is walked at, with both docks and none.
 */
describe("where a browser's docked request goes", () => {
  const page = { width: "full" as const };
  const table: {
    window: number;
    docks: "both" | "none";
    open: boolean;
    folded: boolean;
    page: number;
    column: number;
  }[] = [
    // The window minimum: the page would keep under 720px beside it, so the column folds.
    { window: 960, docks: "none", open: false, folded: false, page: 928, column: 0 },
    { window: 960, docks: "both", open: false, folded: true, page: 928, column: 0 },
    // Beside it with no docks; with them, the docks fold so the pair fits.
    { window: 1200, docks: "none", open: true, folded: false, page: 808, column: 360 },
    { window: 1200, docks: "both", open: true, folded: true, page: 808, column: 360 },
    // From here the page keeps its whole 1,040px and the column is added beside it.
    { window: 1440, docks: "none", open: true, folded: false, page: 1040, column: 360 },
    { window: 1440, docks: "both", open: true, folded: true, page: 1040, column: 360 },
    { window: 1728, docks: "none", open: true, folded: false, page: 1040, column: 360 },
    { window: 1728, docks: "both", open: true, folded: true, page: 1040, column: 360 },
  ];
  for (const row of table) {
    it(`${row.window} wide with ${row.docks} docked`, () => {
      const rails = row.docks === "both" ? BOTH(row.window) : NONE();
      const at = requestPlacement(row.window, rails, page, undefined);
      expect(at).toEqual({
        open: row.open,
        folded: row.folded,
        page: row.page,
        column: row.column,
      });
    });
  }

  it("follows the captain's Command-backslash over the window's width", () => {
    expect(requestPlacement(960, 0, page, "open")).toEqual({
      open: true,
      folded: false,
      page: 568,
      column: 360,
    });
    expect(requestPlacement(960, BOTH(960), page, "open")).toEqual({
      open: true,
      folded: true,
      page: 568,
      column: 360,
    });
    expect(requestPlacement(1440, 0, page, "folded")).toEqual({
      open: false,
      folded: false,
      page: CARD_SIZES.full,
      column: 0,
    });
  });

  it("gives a maximized page the window less the column, folding it only where the page would be narrow", () => {
    expect(requestPlacement(1440, BOTH(1440), page, undefined, true)).toEqual({
      open: true,
      folded: false,
      page: 1440 - THREAD_STAGE_MARGIN - THREAD_MAX,
      column: THREAD_MAX,
    });
    expect(requestPlacement(960, 0, page, undefined, true)).toEqual({
      open: false,
      folded: false,
      page: 960 - THREAD_STAGE_MARGIN,
      column: 0,
    });
    expect(requestPlacement(960, 0, page, "open", true).open).toBe(true);
  });

  it("keeps a page the captain dragged narrower at that width beside the column", () => {
    expect(requestPlacement(1200, 0, { dragged: 700 }, undefined)).toEqual({
      open: true,
      folded: false,
      page: 700,
      column: 360,
    });
  });
});
