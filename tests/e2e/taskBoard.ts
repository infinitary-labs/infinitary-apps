import type { FrameLocator, Locator, Page } from "@playwright/test";
import { drawnFrame } from "./frames";
import { SHOWN_ENTRY } from "./stack";

/**
 * The task board (docs/task-board.md): the Tasks panel's card, drawn in a
 * page of its own like any panel's card, read inside that page by its
 * stable hooks, never by its words - the shown entry, a tile by its task
 * key, a lane, a view and a lane's pages, and the tile that holds the
 * keyboard's focus. Every helper takes the panel whose card it is, so a
 * copy of the Tasks panel's folder added from elsewhere under another id
 * is read the same way.
 */

/** The app's own Tasks panel, whose card the board is. */
export const BOARD_PANEL = "now";

/** The board's card element on the stage, by its panel. */
const boardCardSelector = (panel: string) => `[data-panel-card="${panel}/board"]`;

/** The board's stack entry id, by its panel. */
export function boardEntryId(panel = BOARD_PANEL): string {
  return `panel-card:${panel}/board`;
}

/** The board's card while it is the shown entry: the app's own element around its page. */
export function boardCard(page: Page, panel = BOARD_PANEL): Locator {
  return page.locator(`${SHOWN_ENTRY} ${boardCardSelector(panel)}`);
}

/** Every task board card drawn on the stage, shown or not: there is never a second. */
export function boardsOnStage(page: Page, panel = BOARD_PANEL): Locator {
  return page.locator(`[data-card-layer] ${boardCardSelector(panel)}`);
}

/** The shown board's own page. */
export function boardPage(page: Page, panel = BOARD_PANEL): FrameLocator {
  return drawnFrame(page, `${SHOWN_ENTRY} ${boardCardSelector(panel)} iframe`);
}

/** The board itself, inside its page, while it is the shown entry. */
export function boardEntry(page: Page, panel = BOARD_PANEL): Locator {
  return boardPage(page, panel).locator("[data-task-board]");
}

/** The app's Hide in the shown board card's title row. */
export function hideBoard(page: Page): Locator {
  return page
    .locator(`${SHOWN_ENTRY} [data-panel-card-chrome]`)
    .getByRole("button", { name: "Hide", exact: true });
}

/** One tile on the shown board, by its task key. */
export function boardTile(page: Page, key: string, panel = BOARD_PANEL): Locator {
  return boardEntry(page, panel).locator(`[data-board-tile][data-board-key="${key}"]`);
}

/**
 * One of the board's views as its button: `board`, `backlog`, `landed`
 * (Done · 7d) or `earlier` (while Find has words); `aria-pressed` says
 * which is shown.
 */
export function boardViewTab(page: Page, view: string, panel = BOARD_PANEL): Locator {
  return boardEntry(page, panel).locator(`[data-board-view-tab="${view}"]`);
}

/** The count a view's button says: a lane's whole count, as text ("60", "3 · 1 new", "50+"). */
export function boardViewCount(page: Page, view: string, panel = BOARD_PANEL): Locator {
  return boardEntry(page, panel).locator(`[data-board-view-count="${view}"]`);
}

/** The view the shown board draws under Waiting on you: `board`, or the lane its list shows. */
export function boardView(page: Page, panel = BOARD_PANEL): Promise<string | null> {
  return boardEntry(page, panel).getAttribute("data-board-view");
}

/**
 * A lane's pages on the shown board: its range ("21–40 of 300"), its
 * Previous and Next, and Browse all or Show all where a lane opens its
 * list. A list draws Previous and Next above and below its rows; these are
 * the first of each.
 */
export function boardPager(page: Page, lane: string, panel = BOARD_PANEL) {
  const board = boardEntry(page, panel);
  return {
    range: board.locator(`[data-board-range="${lane}"]`),
    previous: board.locator(`[data-board-page-prev="${lane}"]`).first(),
    next: board.locator(`[data-board-page-next="${lane}"]`).first(),
    browse: board.locator(`[data-board-browse="${lane}"]`),
  };
}

/** The whole count a lane's head says, the tiles on its other pages included. */
export async function laneCount(page: Page, lane: string, panel = BOARD_PANEL): Promise<number> {
  return Number(
    await boardEntry(page, panel).locator(`[data-board-count="${lane}"]`).first().textContent(),
  );
}

/** The keys of the tiles drawn in one lane of the shown board, in order: one page of it. */
export function laneKeys(page: Page, lane: string, panel = BOARD_PANEL): Promise<string[]> {
  return boardEntry(page, panel)
    .locator(`[data-board-tile][data-board-lane="${lane}"]`)
    .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-board-key") ?? ""));
}

/** Whether the window's focus is in the shown board's page: its frame is the focused element. */
function boardHoldsFocus(page: Page, panel: string): Promise<boolean> {
  return page.evaluate(
    (selector) => {
      const frame = document.querySelector(selector);
      return frame !== null && document.activeElement === frame;
    },
    `${SHOWN_ENTRY} ${boardCardSelector(panel)} iframe`,
  );
}

/**
 * The key of the board tile that holds the keyboard's focus, or null when
 * focus is elsewhere: the window's focus is in the board's page, and the
 * tile holds it there.
 */
export async function focusedTileKey(page: Page, panel = BOARD_PANEL): Promise<string | null> {
  if ((await boardEntry(page, panel).count()) === 0 || !(await boardHoldsFocus(page, panel))) {
    return null;
  }
  return boardEntry(page, panel).evaluate(
    (board) =>
      board.ownerDocument.activeElement
        ?.closest("[data-board-tile]")
        ?.getAttribute("data-board-key") ?? null,
  );
}

/**
 * Whether `control`, in the shown board's page, holds the keyboard's focus:
 * the window's focus is in the board's page and the control holds it
 * there. Playwright's own focus check also asks the page whether its
 * window has the system's focus, which a hidden window's sandboxed frame
 * answers by how the last input reached it; this asks only where focus is.
 */
export async function boardFocusOn(
  page: Page,
  control: Locator,
  panel = BOARD_PANEL,
): Promise<boolean> {
  if ((await control.count()) === 0 || !(await boardHoldsFocus(page, panel))) return false;
  return control.evaluate((element) => element.ownerDocument.activeElement === element);
}

/**
 * Presses a control in the board's page as a click does, dispatched in the
 * page itself: Chromium hands a hidden window's focus to and from a native
 * click into a sandboxed frame unreliably, so a spec that reads where focus
 * lands after the press presses in the page.
 */
export async function pressInBoard(control: Locator): Promise<void> {
  await control.evaluate((element) => (element as HTMLElement).click());
}

/** The Tasks header's Open task board, expanded or collapsed. */
export function openBoardButton(page: Page, panel = BOARD_PANEL): Locator {
  return page.locator(`[data-side-panel="${panel}"] [data-panel-header-button="board"] button`);
}

/**
 * The board's moves (docs/task-board.md, "Moves"), read by the same stable
 * hooks: the live line, a lane or the Drop task tray as a drop, a tile's
 * confirmation and its ⋯ menu.
 */

/** The board's live line: what each move did, or why it was refused. */
export function boardLive(page: Page, panel = BOARD_PANEL): Locator {
  return boardEntry(page, panel).locator("[data-board-live]");
}

/** A lane of the shown board as a drop: `waiting`, a column, or `drop` for the tray. */
export function boardDrop(page: Page, target: string, panel = BOARD_PANEL): Locator {
  return boardEntry(page, panel).locator(`[data-board-drop="${target}"]`);
}

/** The confirmation a move asks on the tile where it landed, and its two buttons. */
export function boardConfirm(page: Page, key: string, panel = BOARD_PANEL) {
  const card = boardEntry(page, panel).locator(
    `[data-board-card]:has([data-board-tile][data-board-key="${key}"]) [data-board-confirm]`,
  );
  return {
    card,
    cancel: card.locator('[data-board-confirm-act="cancel"] button'),
    go: card.locator('[data-board-confirm-act="go"] button'),
  };
}

/** The open ⋯ menu of a tile, in the board's page, and one of its entries by id. */
export function boardMenu(page: Page, key: string, panel = BOARD_PANEL) {
  const menu = boardPage(page, panel).getByRole("menu", { name: `${key} actions` });
  return { menu, entry: (id: string) => menu.locator(`[data-menu-item="${id}"]`) };
}

/** A point in the board's own page, in its CSS pixels. */
type PagePoint = { x: number; y: number };

/** The middle of what shows of a lane or the tray inside the board's body, clear of its scrolling edges. */
function visibleMiddle(drop: Locator): Promise<PagePoint> {
  return drop.evaluate((target) => {
    const box = target.getBoundingClientRect();
    const body = target.ownerDocument.querySelector("[data-board-body]")?.getBoundingClientRect();
    if (!body) throw new Error("The board has no body");
    // The tray sits in the foot, outside the body: its own middle.
    if (target.hasAttribute("data-board-drop-tray")) {
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    const clear = 48;
    const left = Math.max(box.left, body.left + clear);
    const right = Math.min(box.right, body.right - clear);
    const top = Math.max(box.top, body.top + clear);
    const bottom = Math.min(box.bottom, body.bottom - clear);
    if (right <= left || bottom <= top) throw new Error("The drop does not show in the board");
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  });
}

/** One pointer event in the board's page, at a point of it, on whatever is there. */
function pointerAt(board: Locator, type: string, at: PagePoint): Promise<void> {
  return board.evaluate(
    (root, { type, at }) => {
      const doc = root.ownerDocument;
      const target = doc.elementFromPoint(at.x, at.y) ?? doc.body;
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: at.x,
          clientY: at.y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    },
    { type, at },
  );
}

/**
 * Drags a tile with the pointer onto a lane, or onto the Drop task tray
 * that shows once the tile is in the air, as a person's mouse does: a
 * press on the tile, a move past the drag's start, moves to the drop, and
 * a release there. The pointer's events are dispatched in the board's own
 * page (Chromium hands a hidden window's native pointer to a sandboxed
 * frame unreliably), so the page's focus stays where the captain's keys
 * put it. The tile is brought to the middle of the body first, so the drag
 * does not scroll it; `whileOver` runs with the tile held over the drop,
 * before it is let go.
 */
export async function dragTile(
  page: Page,
  key: string,
  target: string,
  options: { whileOver?: () => Promise<void>; panel?: string } = {},
): Promise<void> {
  const panel = options.panel ?? BOARD_PANEL;
  const board = boardEntry(page, panel);
  const tile = boardTile(page, key, panel);
  const start = await tile.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + Math.min(24, box.height / 2) };
  });
  await pointerAt(board, "pointerdown", start);
  // A press becomes a drag only once the pointer has travelled.
  await pointerAt(board, "pointermove", { x: start.x + 4, y: start.y + 4 });
  await pointerAt(board, "pointermove", { x: start.x + 8, y: start.y + 8 });
  const drop = boardDrop(page, target, panel);
  await drop.waitFor();
  const to = await visibleMiddle(drop);
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await pointerAt(board, "pointermove", {
      x: start.x + 8 + ((to.x - start.x - 8) * step) / steps,
      y: start.y + 8 + ((to.y - start.y - 8) * step) / steps,
    });
  }
  await options.whileOver?.();
  await pointerAt(board, "pointerup", to);
}
