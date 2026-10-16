import { writeFile } from "node:fs/promises";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { ActivityStore } from "../../src/core/storage/activityStore";
import { openDatabase } from "../../src/core/storage/db";
import { ACTIONS } from "../../src/shared/actions";
import { TURN_IMAGE_MAX_BYTES } from "../../src/shared/cards";
import { FILE_WORDS } from "../../src/shared/composer";
import { UI_SIZES, type UiSize } from "../../src/shared/preferences";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { HAS_APP_MENU } from "./desktop";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { intersects, minimumWindowSize, type Rect, resizeWindow, settled, within } from "./layout";
import {
  APP_CATALOG_PROMPT_MARKER,
  CARD_WIDTH_PROMPT_MARKER,
  EMIT_CARDS_PROMPT_MARKER,
  MOCK_CHOICE_CARD_TITLE,
  MOCK_LONG_ACTION_LABEL,
  SPAWN_PROMPT_MARKER,
  WIDTH_CARD_REGULAR_TEXT,
  WIDTH_CARD_TITLES,
} from "./mockProvider";
import { pastePictures, promptInput } from "./prompt";
import { feedLineOf, newestFeedLine } from "./rails";
import { cardReply, cardSurface, pager, showCard, shownEntry } from "./stack";
import { pressWindowKey } from "./windowKeys";

async function capture(launched: LaunchedApp, name: string) {
  await launched.page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const png = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("App window missing");
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  await writeFile(test.info().outputPath(name), Buffer.from(png, "base64"));
}

for (const size of UI_SIZES) {
  test(`Size ${size}% scales the window and gives a regular card room`, async () => {
    const launched = await launchApp({ withMockProvider: true });
    try {
      const { page, app } = launched;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await page.getByRole("radio", { name: `${size}%`, exact: true }).check();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
          ),
        )
        .toBe(size / 100);
      await expect(page.getByRole("radio", { name: `${size}%`, exact: true })).toBeChecked();
      await capture(launched, `appearance-${size}.png`);
      const restore = await resizeWindow(app, page, await minimumWindowSize(app));
      await page.getByRole("radio", { name: `${size}%`, exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("radio", { name: `${size}%`, exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await capture(launched, `appearance-minimum-${size}.png`);
      await resizeWindow(app, page, restore);
      // Other appearance writes must not reset the scale.
      await page.getByRole("radio", { name: "Light", exact: true }).check();
      await expect
        .poll(() => page.evaluate(() => window.infinitary.settings.getPreferences()))
        .toMatchObject({ appearance: { size, theme: "light" } });
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          page
            .locator("canvas")
            .first()
            .evaluate(
              (node) =>
                (node as HTMLCanvasElement).width -
                Math.round(node.getBoundingClientRect().width * devicePixelRatio),
            ),
        )
        .toBe(0);
      const sharpness = await page
        .locator("canvas")
        .first()
        .evaluate((node) => ({
          actual: (node as HTMLCanvasElement).width,
          expected: Math.round(node.getBoundingClientRect().width * devicePixelRatio),
        }));
      // Collapsed panel headers take no card room, so only expanded docks
      // have room to give back by folding. They expand before any card is
      // up: once one expanded dock folds the rails, the other is out of reach.
      await page.evaluate(() =>
        window.infinitary.settings.setLayout({
          collapsedPanels: { activity: false, now: false },
          hiddenPanels: {},
          placements: {},
        }),
      );
      await expect(page.locator('[data-side-panel="activity"]')).not.toHaveAttribute(
        "data-side-panel-collapsed",
        "",
      );
      const input = promptInput(page);
      await input.fill(`commission a crewmate: ${CARD_WIDTH_PROMPT_MARKER}`);
      await input.press("Enter");
      await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-side-panel="now"]')).not.toHaveAttribute(
        "data-side-panel-collapsed",
        "",
      );
      await showCard(page, WIDTH_CARD_TITLES.regular);
      await expect(cardBodyElement(page, WIDTH_CARD_TITLES.regular)).toHaveAttribute(
        "data-frame-drawn",
        "",
      );
      await expect(cardBody(page, WIDTH_CARD_TITLES.regular).locator("body")).toContainText(
        WIDTH_CARD_REGULAR_TEXT,
      );
      await capture(launched, `card-${size}.png`);
      await resizeWindow(app, page, await minimumWindowSize(app));
      await expect(input).toBeVisible();
      await expectControlsWhole(page, [
        shownEntry(page).getByRole("button", { name: "Close", exact: true }),
        cardReply(page).field,
      ]);
      await capture(launched, `minimum-${size}.png`);
      await writeFile(
        test.info().outputPath(`measurements-${size}.json`),
        JSON.stringify(
          {
            size,
            sharpness,
            preferences: await page.evaluate(() => window.infinitary.settings.getPreferences()),
            layout: await page.locator("[data-card-layer]").boundingBox(),
          },
          null,
          2,
        ),
      );
    } finally {
      await launched.close();
    }
  });
}

/** The feed line one size change Firstmate makes leaves. */
function firstmateSizeLine(page: Page, size: UiSize) {
  return feedLineOf(page, {
    type: "personalized",
    actor: "firstmate",
    text: ACTIONS["window-size"].done({ size }),
  });
}

/**
 * The one line a run of the captain's size steps leaves, ending at `size`
 * from wherever the run began (docs/orchestrator-contract.md, "Settled runs").
 */
function captainSizeLine(page: Page, size: UiSize): Locator {
  return UI_SIZES.filter((from) => from !== size)
    .map((from) =>
      feedLineOf(page, {
        type: "personalized",
        actor: "captain",
        text: ACTIONS["window-size"].settled?.({ size: from }, { size }) ?? "",
      }),
    )
    .reduce((either, line) => either.or(line));
}

const zoomFactor = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
  );

test("shortcuts, menu, picker and restart share the saved size", async () => {
  let launched = await launchApp();
  const userDataDir = launched.userDataDir;
  try {
    const { page, app } = launched;
    await pressWindowKey(app, "+", ["meta"]);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getPreferences()))
      .toMatchObject({ appearance: { size: 110 } });
    // Each step is the catalog's window-size change, so its run's line says where it went.
    await expect(captainSizeLine(page, 110)).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .first()
          .evaluate(
            (node) =>
              (node as HTMLCanvasElement).width -
              Math.round(node.getBoundingClientRect().width * devicePixelRatio),
          ),
      )
      .toBe(0);
    if (HAS_APP_MENU) {
      // Menu clicks use the same steps, not Chromium's independent zoom levels.
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById("appearance-size-in");
        if (!item) throw new Error("Size menu action missing");
        item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
      });
    } else {
      // A desktop whose window draws its own controls has no app menu: its
      // key takes the next step.
      await pressWindowKey(app, "+", ["meta"]);
    }
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getPreferences()))
      .toMatchObject({ appearance: { size: 125 } });
    await expect(captainSizeLine(page, 125)).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .first()
          .evaluate(
            (node) =>
              (node as HTMLCanvasElement).width -
              Math.round(node.getBoundingClientRect().width * devicePixelRatio),
          ),
      )
      .toBe(0);
    await capture(launched, "character-live-125.png");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radio", { name: "125%", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "150%", exact: true }).check();
    await expect.poll(() => zoomFactor(app)).toBe(1.5);
    await page.keyboard.press("Escape");
    await expect(captainSizeLine(page, 150)).toBeVisible();
  } finally {
    await launched.close();
  }
  launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    expect(await zoomFactor(app)).toBe(1.5);
    await pressWindowKey(app, "-", ["meta"]);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getPreferences()))
      .toMatchObject({ appearance: { size: 125 } });
    await pressWindowKey(app, "0", ["meta"]);
    await expect.poll(() => zoomFactor(app)).toBe(1);
    await expect(captainSizeLine(page, 100)).toBeVisible();
    await writeFile(
      test.info().outputPath("restart-shortcuts.json"),
      JSON.stringify(
        await page.evaluate(() => window.infinitary.settings.getPreferences()),
        null,
        2,
      ),
    );
  } finally {
    await launched.close();
  }
});

test("Firstmate changes the saved size when asked, with one trail and no card", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page, app } = launched;
    const input = promptInput(page);
    await input.fill(
      `${APP_CATALOG_PROMPT_MARKER}${JSON.stringify({ action: "window-size", value: { size: 125 } })}`,
    );
    await input.press("Enter");
    await expect.poll(() => zoomFactor(app)).toBe(1.25);
    await expect(firstmateSizeLine(page, 125)).toBeVisible();
    await waitForFirstmateIdle(page);
    await capture(launched, "firstmate-125.png");
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    expect(
      board.tasks.filter(
        (task) =>
          task.kind === "operation" && task.title === ACTIONS["window-size"].done({ size: 125 }),
      ),
    ).toHaveLength(1);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radio", { name: "125%", exact: true })).toBeChecked();
  } finally {
    await launched.close();
  }
});

/** The size choice, made where a person makes it: Settings → Appearance. */
async function chooseSize(page: Page, size: UiSize) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: `${size}%`, exact: true }).check();
  await page.keyboard.press("Escape");
}

/** The card-kinds crewmate's decision. */
const DECISION_TITLE = MOCK_CHOICE_CARD_TITLE;

/**
 * The shown card's controls, each whole inside the card, inside the window
 * and under nothing else (a trial click lands on it), with the card itself
 * clear of the top bar above it and the input below it.
 */
async function expectControlsWhole(page: Page, controls: Locator[]) {
  const card = cardSurface(page);
  for (const control of controls) await control.click({ trial: true });
  const boxes = await settled(async () => ({
    card: await card.boundingBox(),
    topbar: await page.locator("[data-topbar]").boundingBox(),
    input: await page.locator("[data-prompt-dock]").boundingBox(),
    window: await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
    controls: await Promise.all(controls.map((control) => control.boundingBox())),
  }));
  if (!boxes.card || !boxes.topbar || !boxes.input) throw new Error("The stage is not laid out");
  for (const [i, box] of boxes.controls.entries()) {
    if (!box) throw new Error(`${controls[i]} has no box`);
    expect(within(box, boxes.card), `${controls[i]} is cut off by the card`).toEqual([]);
    expect(within(box, boxes.window as Rect), `${controls[i]} is out of the window`).toEqual([]);
  }
  expect(boxes.card.y).toBeGreaterThanOrEqual(boxes.topbar.y + boxes.topbar.height);
  expect(boxes.card.y + boxes.card.height).toBeLessThanOrEqual(boxes.input.y);
}

/** The height the stage gives the shown card, once it holds still. */
const cardRoom = (page: Page) =>
  settled(async () => (await cardSurface(page).boundingBox())?.height ?? 0);

test("a card in a short window at a larger size keeps its reading room and every control", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page, app } = launched;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const card = shownEntry(page);
    const bodyFrame = cardBodyElement(card, DECISION_TITLE);
    const controls = [
      card.getByRole("button", { name: "Close", exact: true }),
      card.getByRole("button", { name: MOCK_LONG_ACTION_LABEL, exact: true }),
      card.getByRole("button", { name: "Await the queue", exact: true }),
      cardReply(page).field,
    ];

    // At 150% the smallest window leaves no room for the body beside the
    // card's title: the two share the space between the head and the
    // buttons, which stay whole, and the body is in sight, so a card that
    // first arrives here draws.
    await chooseSize(page, 150);
    await resizeWindow(app, page, await minimumWindowSize(app));
    const input = promptInput(page);
    await input.fill(`commission a crewmate: ${EMIT_CARDS_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });
    await showCard(page, DECISION_TITLE);
    await expect(bodyFrame).toHaveAttribute("data-frame-drawn", "");
    await expectControlsWhole(page, controls);
    await capture(launched, "smallest-150.png");

    // The room a long decision has at the smallest window at 100%.
    await chooseSize(page, 100);
    // Settings takes the home screen away, so the card's body draws again
    // on the way back, and its room is measured only once it has.
    await showCard(page, DECISION_TITLE);
    await expect(bodyFrame).toHaveAttribute("data-frame-drawn", "");
    const smallest = await cardRoom(page);
    await expectControlsWhole(page, controls);

    // At 150% a 1200 × 800 window is shorter than that smallest window; the
    // stage's air gives way, so the card keeps the same room.
    await chooseSize(page, 150);
    await resizeWindow(app, page, { width: 1200, height: 800 });
    await showCard(page, DECISION_TITLE);
    await expect(bodyFrame).toHaveAttribute("data-frame-drawn", "");
    expect(await cardRoom(page)).toBeGreaterThanOrEqual(smallest - 1);
    await expectControlsWhole(page, controls);
    await capture(launched, "short-150.png");

    // A notice under the input stays whole on screen, and the card yields
    // to it rather than run under the input.
    await pastePictures(input, [{ name: "huge.png", bytes: TURN_IMAGE_MAX_BYTES + 1 }]);
    const notice = page.locator('[data-composer-notice="picture-too-big"]');
    const dismiss = notice.getByRole("button");
    await dismiss.click({ trial: true });
    const noticed = await settled(async () => ({
      notice: await notice.boundingBox(),
      window: await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
    }));
    if (!noticed.notice) throw new Error("The notice has no box");
    expect(within(noticed.notice, noticed.window as Rect)).toEqual([]);
    await expectControlsWhole(page, controls);
    await capture(launched, "short-150-notice.png");
    await dismiss.click();
    await expect(notice).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

/**
 * The collapsed Activity and Tasks headers at the rails' feet, each drawn
 * clear of the main message's box once the layout holds still. With no card
 * up both are drawn; while a card is up a header may step aside instead,
 * and then it is not drawn at all.
 */
async function expectHeadersClearOfInput(page: Page, { cardUp }: { cardUp: boolean }) {
  const headers = (["activity", "now"] as const).map((dock) =>
    page.locator(`[data-side-panel="${dock}"]`),
  );
  for (const header of headers) {
    await expect(header).toHaveAttribute("data-side-panel-collapsed", "");
  }
  const boxes = await settled(async () => ({
    input: await page.locator("[data-prompt-dock]").boundingBox(),
    headers: await Promise.all(
      headers.map(async (header) => ({
        drawn: await header.isVisible(),
        box: await header.boundingBox(),
      })),
    ),
  }));
  if (!boxes.input) throw new Error("The main message has no box");
  for (const [i, header] of boxes.headers.entries()) {
    if (!cardUp) expect(header.drawn, `${headers[i]} is drawn`).toBe(true);
    if (!header.drawn) continue;
    if (!header.box) throw new Error(`${headers[i]} has no box`);
    expect(intersects(header.box, boxes.input), `${headers[i]} is under the main message`).toBe(
      false,
    );
  }
}

for (const size of UI_SIZES) {
  test(`Size ${size}% keeps the collapsed panel headers clear of the main message`, async () => {
    const launched = await launchApp({ withMockProvider: true });
    try {
      const { page, app } = launched;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await chooseSize(page, size);
      const roomy = { width: 1200, height: 800 };
      const windows = [roomy, await minimumWindowSize(app)];
      // A task docks Tasks, collapsed on the right as Activity is on the left.
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} keep the headers clear`);
      await input.press("Enter");
      await expect(page.locator('[data-side-panel="now"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-card-layer]")).toHaveCount(0);
      for (const window of windows) {
        await resizeWindow(app, page, window);
        await expectHeadersClearOfInput(page, { cardUp: false });
      }

      // With a card up, the card stays clear of the main message as well.
      await resizeWindow(app, page, roomy);
      await input.fill(`${SPAWN_PROMPT_MARKER} ${CARD_WIDTH_PROMPT_MARKER}`);
      await input.press("Enter");
      await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
      await showCard(page, WIDTH_CARD_TITLES.regular);
      for (const window of windows) {
        await resizeWindow(app, page, window);
        await expectHeadersClearOfInput(page, { cardUp: true });
        await expectControlsWhole(page, [
          shownEntry(page).getByRole("button", { name: "Close", exact: true }),
          cardReply(page).field,
        ]);
      }
      await capture(launched, `headers-card-${size}.png`);
    } finally {
      await launched.close();
    }
  });
}

/**
 * The main message as a person meets it with Activity and Tasks both
 * expanded: inside the window, its Add files button whole inside it, the
 * hint its empty field shows set on that field's one line, and no side
 * panel drawn under it, once the layout holds still.
 */
async function expectMainMessageUsable(page: Page) {
  const dock = page.locator("[data-prompt-dock]");
  const addFiles = dock.getByRole("button", { name: FILE_WORDS.add, exact: true });
  await addFiles.click({ trial: true });
  const panels = (["activity", "now"] as const).map((id) =>
    page.locator(`[data-side-panel="${id}"]`),
  );
  const boxes = await settled(async () => ({
    input: await dock.boundingBox(),
    addFiles: await addFiles.boundingBox(),
    window: await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
    // The hint as the field sets it, in its own font, beside the room its
    // one line has inside the field's padding.
    hint: await promptInput(page).evaluate((field: HTMLTextAreaElement) => {
      const style = getComputedStyle(field);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("No canvas to measure the hint with");
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        words: field.placeholder,
        width: context.measureText(field.placeholder).width,
        room:
          field.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
      };
    }),
    panels: await Promise.all(
      panels.map(async (panel) => ({
        drawn: await panel.isVisible(),
        box: await panel.boundingBox(),
      })),
    ),
  }));
  if (!boxes.input || !boxes.addFiles) throw new Error("The main message is not laid out");
  expect(
    within(boxes.input, boxes.window as Rect),
    "the main message is out of the window",
  ).toEqual([]);
  expect(within(boxes.addFiles, boxes.input), "Add files is cut off").toEqual([]);
  expect(boxes.hint.words).not.toBe("");
  expect(boxes.hint.width, `"${boxes.hint.words}" runs past its line`).toBeLessThanOrEqual(
    boxes.hint.room,
  );
  for (const [i, panel] of boxes.panels.entries()) {
    if (!panel.drawn) continue;
    if (!panel.box) throw new Error(`${panels[i]} has no box`);
    expect(intersects(panel.box, boxes.input), `${panels[i]} is under the main message`).toBe(
      false,
    );
  }
}

for (const size of UI_SIZES) {
  test(`Size ${size}% keeps the main message usable between two expanded side panels`, async () => {
    const launched = await launchApp({ withMockProvider: true });
    try {
      const { page, app } = launched;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await chooseSize(page, size);
      // A task docks Tasks on the right, as Activity is on the left; then both expand.
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} keep the main message usable`);
      await input.press("Enter");
      await expect(page.locator('[data-side-panel="now"]')).toBeAttached({ timeout: 30_000 });
      await page.evaluate(() =>
        window.infinitary.settings.setLayout({
          collapsedPanels: { activity: false, now: false },
          hiddenPanels: {},
          placements: {},
        }),
      );
      for (const dock of ["activity", "now"]) {
        await expect(page.locator(`[data-side-panel="${dock}"]`)).not.toHaveAttribute(
          "data-side-panel-collapsed",
          "",
        );
      }
      await expect(page.locator("[data-card-layer]")).toHaveCount(0);
      for (const window of [
        await minimumWindowSize(app),
        { width: 1080, height: 720 },
        { width: 1200, height: 800 },
      ]) {
        await resizeWindow(app, page, window);
        await expectMainMessageUsable(page);
      }
      await capture(launched, `both-panels-${size}.png`);
    } finally {
      await launched.close();
    }
  });
}

type Dock = "activity" | "now";

/**
 * One expanded side panel alone beside the main message, once the layout
 * holds still: drawn, it shares no area with the input, the last turn
 * above it or the notices under it, and Activity's newest line lies whole
 * inside its panel's view.
 */
async function expectLonePanelClear(page: Page, dock: Dock) {
  const panel = page.locator(`[data-side-panel="${dock}"]`);
  const around = {
    "main message": page.locator("[data-prompt-dock]"),
    "last turn": page.locator("[data-last-turn-slot]"),
    notices: page.locator("[data-prompt-notices]"),
  };
  const boxes = await settled(async () => ({
    drawn: await panel.isVisible(),
    panel: await panel.boundingBox(),
    around: await Promise.all(
      Object.entries(around).map(async ([name, part]) => ({ name, box: await part.boundingBox() })),
    ),
  }));
  // Folded away for the input's room, it is drawn under nothing.
  if (!boxes.drawn) return;
  if (!boxes.panel) throw new Error(`${dock} has no box`);
  for (const { name, box } of boxes.around) {
    if (!box) throw new Error(`The ${name} has no box`);
    expect(intersects(boxes.panel, box), `${dock} is under the ${name}`).toBe(false);
  }
  if (dock !== "activity") return;
  const view = panel.locator("[data-side-panel-body]");
  const newest = newestFeedLine(page);
  await expect
    .poll(
      async () => {
        const [line, body] = [await newest.boundingBox(), await view.boundingBox()];
        return line && body ? within(line, body) : ["not laid out"];
      },
      { message: "Activity's newest line is out of view" },
    )
    .toEqual([]);
}

for (const size of UI_SIZES) {
  test(`Size ${size}% keeps a lone expanded side panel clear of the main message`, async () => {
    // A feed long enough to fill Activity's list, as a used app's is, so a
    // panel that gets shorter has lines to lose.
    const userDataDir = scratchDir("infinitary-lone-panel-");
    const db = openDatabase(userDataDir);
    const feed = new ActivityStore(db);
    for (let line = 1; line <= 20; line += 1) {
      feed.record({ kind: "info", text: `Earlier ${line}` });
    }
    db.close();
    const launched = await launchApp({ withMockProvider: true, userDataDir });
    try {
      const { page, app } = launched;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await chooseSize(page, size);
      // A task docks Tasks on the right, as Activity is on the left, and its
      // turn leaves the last turn above the input.
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} keep a lone panel clear`);
      await input.press("Enter");
      await expect(page.locator('[data-side-panel="now"]')).toBeAttached({ timeout: 30_000 });
      await expect(page.locator("[data-card-layer]")).toHaveCount(0);
      const windows = [
        await minimumWindowSize(app),
        { width: 1080, height: 720 },
        { width: 1200, height: 800 },
        { width: 1440, height: 900 },
      ];
      for (const dock of ["activity", "now"] as const) {
        // Only this one expanded: the input is centred on the window, so it
        // reaches across into a lone panel's rail on a narrow page.
        await page.evaluate(
          (open) =>
            window.infinitary.settings.setLayout({
              collapsedPanels: { activity: open !== "activity", now: open !== "now" },
              hiddenPanels: {},
              placements: {},
            }),
          dock,
        );
        await expect(page.locator(`[data-side-panel="${dock}"]`)).not.toHaveAttribute(
          "data-side-panel-collapsed",
          "",
        );
        for (const window of windows) {
          await resizeWindow(app, page, window);
          await expectLonePanelClear(page, dock);
        }
        await capture(launched, `lone-${dock}-${size}.png`);
      }
    } finally {
      await launched.close();
    }
  });
}
