import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { panelCommandId } from "../../src/shared/keyboard";
import { scratchDir } from "../helpers/scratchDirs";
import { keyWords } from "./desktop";
import { frameIn } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { ADD_PANEL_PROMPT_MARKER } from "./mockProvider";
import {
  panelCardChrome,
  panelHeaderButton,
  shownPanelCard,
  shownPanelCardFrame,
} from "./panelCards";
import { promptInput } from "./prompt";
import { clickInBody, pager } from "./stack";
import {
  commandSearch,
  keyboardSettings,
  pressWindowKey,
  runFromSearch,
  typeInto,
} from "./windowKeys";

/**
 * A panel's cards on the main card stack (docs/ui-plugins.md, "A panel's
 * cards"; FI3-1014 piece 1): the one way a card appears, whoever made the
 * panel. The fixture under tests/fixtures/panel-cards/ declares a named
 * card, two header buttons and two commands, and its code puts cards up
 * from its rows and from a card. The journey drives it by the header, by
 * its key and command search, and by the panel's own clicks.
 */

const PANEL = "reading-list";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "panel-cards", PANEL);

test.describe("a panel of the captain's own puts cards on the stack", () => {
  let launched: LaunchedApp;
  let workspace: string;

  test.beforeEach(async () => {
    const userDataDir = scratchDir("infinitary-e2e-panel-cards-");
    workspace = join(userDataDir, "fleet", "personal");
    mkdirSync(workspace, { recursive: true });
    cpSync(FIXTURE, join(workspace, PANEL), { recursive: true });
    launched = await launchApp({ userDataDir });
    // Room for a card beside the docks, so the panel stays in reach while one is up.
    await resizeWindow(launched.app, launched.page, { width: 1600, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("by its header button and its key, revised in place, hidden by Hide and Esc, gone with the panel", async () => {
    const { app, page } = launched;
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);
    const open = panelHeaderButton(page, PANEL, "open");
    const reader = shownPanelCard(page, PANEL, "reader");

    await test.step("the header button puts its card up at the front, the panel still collapsed", async () => {
      await expect(panel.locator("[data-fixture]")).toBeVisible({ timeout: 30_000 });
      await panel.getByRole("button", { name: "Collapse Reading list" }).click();
      // Collapsed, its page runs on out of sight and its header says what it holds.
      await expect(panel.locator("[data-fixture]")).toBeHidden();
      await expect(panel.locator("[data-panel-summary]")).toHaveText("3 left");
      await open.click();
      await expect(reader.locator("[data-fixture-reader]")).toHaveAttribute(
        "data-fixture-reader",
        "list",
      );
      const chrome = panelCardChrome(page);
      await expect(chrome.title).toHaveText("Reading");
      await expect(chrome.attribution).toHaveText("yours");
      await expect(panel).toHaveAttribute("data-side-panel-collapsed", "");
      // A second press brings the same card forward, never a copy.
      await open.click();
      await expect(pager(page, 2)).toHaveCount(0);
      await chrome.hide.click();
      await expect(reader).toHaveCount(0);
    });

    await test.step("its command's key puts it up again, with the keyboard's focus in it", async () => {
      await pressWindowKey(app, "j", ["meta"]);
      await expect(reader.locator("[data-fixture-reader]")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement
              ?.closest("[data-stage-entry-id]")
              ?.getAttribute("data-stage-entry-id"),
          ),
        )
        .toBe(`panel-card:${PANEL}/reader`);
    });

    await test.step("a card puts up a card of its own at the front, and the first waits behind", async () => {
      await reader.locator("[data-fixture-reader-notes]").click();
      const notes = shownPanelCard(page, PANEL, "notes-the-calm-interface");
      await expect(notes.locator('[data-fixture-notes="The calm interface"]')).toBeVisible();
      await expect(pager(page, 2)).toBeVisible();
      // The panel's own row names the same card: revised in place, no third card.
      await panel.getByRole("button", { name: "Expand Reading list" }).click();
      await panel.locator('[data-fixture-notes-for="The calm interface"]').click();
      await expect(notes).toBeVisible();
      await expect(pager(page, 2)).toBeVisible();
      await panel.locator('[data-fixture-notes-for="Notes on focus"]').click();
      await expect(
        shownPanelCard(page, PANEL, "notes-notes-on-focus").locator(
          '[data-fixture-notes="Notes on focus"]',
        ),
      ).toBeVisible();
      await expect(pager(page, 3)).toBeVisible();
    });

    await test.step("Esc a field used keeps the card; Esc nothing used hides it", async () => {
      const note = shownPanelCard(page, PANEL, "notes-notes-on-focus").locator(
        "[data-fixture-note]",
      );
      await note.fill("a thought");
      await note.press("Escape");
      await expect(note).toHaveValue("");
      await expect(pager(page, 3)).toBeVisible();
      await note.press("Escape");
      await expect(shownPanelCard(page, PANEL, "notes-notes-on-focus")).toHaveCount(0);
      await expect(pager(page, 2)).toBeVisible();
    });

    await test.step("its panel leaving takes its cards off the stack", async () => {
      rmSync(join(workspace, PANEL), { recursive: true, force: true });
      await expect(panel).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator("[data-panel-card]")).toHaveCount(0);
      await expect(pager(page, 2)).toHaveCount(0);
    });
  });

  test("command search lists its commands under its title, and a press asks the panel itself", async () => {
    const { app, page } = launched;
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);
    await expect(panel.locator("[data-fixture]")).toBeVisible({ timeout: 30_000 });

    await test.step("command search finds them by the panel's title, with the key it gave", async () => {
      const search = commandSearch(page);
      await pressWindowKey(app, "k", ["meta"]);
      await search.field.fill("reading list");
      await expect(search.row(panelCommandId(PANEL, "open"))).toContainText(
        keyWords({ key: "j", meta: true }),
      );
      await expect(search.row(panelCommandId(PANEL, "find"))).toBeVisible();
      await expect(search.dialog.locator(`[data-command-panel="Reading list"]`)).toHaveCount(1);
      await page.keyboard.press("Escape");
    });

    await test.step("Find a piece brings the collapsed panel out with its search taking the keys", async () => {
      await panel.getByRole("button", { name: "Collapse Reading list" }).click();
      await runFromSearch(app, page, panelCommandId(PANEL, "find"));
      const field = panel.locator("[data-fixture-search]");
      await expect(field).toBeFocused();
      await typeInto(field, "quiet");
      await expect(panel.getByRole("button", { name: "Notes" })).toHaveCount(1);
    });

    await test.step("Keyboard settings lists them for a key of the captain's own", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Keyboard" }).click();
      const keys = keyboardSettings(page);
      await keys.search.fill("reading list");
      await expect(keys.row(panelCommandId(PANEL, "open"))).toContainText("Reading list");
      await expect(keys.keys(panelCommandId(PANEL, "open"))).toContainText(
        keyWords({ key: "j", meta: true }),
      );
      await expect(keys.row(panelCommandId(PANEL, "find"))).toBeVisible();
    });
  });
});

test.describe("a panel from elsewhere draws its cards walled off", () => {
  let launched: LaunchedApp;
  let source: string;

  test.beforeEach(async () => {
    source = join(scratchDir("infinitary-e2e-panel-cards-source-"), PANEL);
    cpSync(FIXTURE, source, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ ...manifest, name: "Acme", version: "1.0.0" }),
    );
    launched = await launchApp({ withMockProvider: true });
    await resizeWindow(launched.app, launched.page, { width: 1600, height: 900 });
  });

  test.afterEach(async () => {
    await launched.close();
  });

  test("in a frame of its own, at the front from the captain's click, behind and marked new otherwise", async () => {
    const { app, page } = launched;
    const panel = page.locator(`[data-side-panel="${PANEL}"]`);

    await test.step("the captain adds it, and its header draws its buttons", async () => {
      const input = promptInput(page);
      await input.click();
      await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
      await input.press("Enter");
      await page.getByRole("button", { name: "Add it", exact: true }).click({ timeout: 30_000 });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator("[data-side-panel-attribution]")).toHaveText("Acme");
      await expect(panelHeaderButton(page, PANEL, "open")).toBeVisible();
    });

    await test.step("its header button puts its card up, drawn in a frame of its own", async () => {
      await panelHeaderButton(page, PANEL, "open").click();
      const reader = shownPanelCard(page, PANEL, "reader");
      await expect(frameIn(reader.locator("[data-panel-card-page]"))).toHaveAttribute(
        "src",
        /^app-frame:\/\/panel-[0-9a-f-]+\/$/,
      );
      await expect(panelCardChrome(page).attribution).toHaveText("Acme");
      await expect(shownPanelCardFrame(page).locator('[data-fixture-reader="list"]')).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("a card it puts up from the captain's click inside it comes to the front", async () => {
      await clickInBody(shownPanelCardFrame(page).locator("[data-fixture-reader-notes]"));
      await expect(shownPanelCard(page, PANEL, "notes-the-calm-interface")).toBeVisible();
      await expect(
        shownPanelCardFrame(page).locator('[data-fixture-notes="The calm interface"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(pager(page, 2)).toBeVisible();
    });

    await test.step("one it raises on its own, while the captain types elsewhere, waits behind, marked new", async () => {
      await pressWindowKey(app, "l", ["meta"]);
      await expect(promptInput(page)).toBeFocused();
      await page.evaluate(
        (extensionId) =>
          window.infinitary.plugins.db.request({
            op: "set",
            extensionId,
            key: "raise",
            value: "Notes on focus",
          }),
        PANEL,
      );
      await expect(pager(page, 3)).toBeVisible();
      await expect(shownPanelCard(page, PANEL, "notes-the-calm-interface")).toBeVisible();
      await expect(page.locator('[data-unread-dot="before"]')).toBeVisible();
      await expect(promptInput(page)).toBeFocused();
    });

    await test.step("an Escape its field uses keeps the card, and one nothing used hides it", async () => {
      const note = shownPanelCardFrame(page).locator("[data-fixture-note]");
      await clickInBody(note);
      await note.fill("a thought");
      await note.press("Escape");
      await expect(note).toHaveValue("");
      await expect(pager(page, 3)).toBeVisible();
      await note.press("Escape");
      await expect(shownPanelCard(page, PANEL, "notes-the-calm-interface")).toHaveCount(0);
      await expect(pager(page, 2)).toBeVisible();
    });

    await test.step("the panels switch takes its cards back with it", async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator('[data-setting="your-panels"] [role="switch"]').click();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.locator("[data-panel-card]")).toHaveCount(0);
    });
  });
});

// Hold the card at its draw boundary so the pending focus move resolves only
// after command search opens, independent of how fast this computer draws.
test("a panel card still drawing yields its pending focus to command search", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  try {
    await page.evaluate(() => {
      const hold = new MutationObserver(() => {
        const card = document.querySelector('[data-panel-card="now/board"]');
        const entry = card?.closest<HTMLElement>('[data-stage-entry="shown"]');
        if (entry) entry.style.opacity = "0";
      });
      hold.observe(document.body, { childList: true, subtree: true });
      (window as unknown as { releasePanelDraw: () => void }).releasePanelDraw = () => {
        hold.disconnect();
        const card = document.querySelector('[data-panel-card="now/board"]');
        card?.closest<HTMLElement>('[data-stage-entry="shown"]')?.style.removeProperty("opacity");
      };
    });
    await runFromSearch(app, page, "panel:now/board");
    await expect(frameIn(shownPanelCard(page, "now", "board"))).toBeAttached();
    await pressWindowKey(app, "k", ["meta"]);
    const search = commandSearch(page);
    await expect
      .poll(() => search.field.evaluate((field) => field.ownerDocument.activeElement === field))
      .toBe(true);
    await page.evaluate(async () => {
      (window as unknown as { releasePanelDraw: () => void }).releasePanelDraw();
      // Let the app's pending focus callback observe the newly drawn card.
      for (let frame = 0; frame < 4; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect
      .poll(() => search.field.evaluate((field) => field.ownerDocument.activeElement === field))
      .toBe(true);
    await typeInto(search.field, "knowledge");
    await expect(search.field).toHaveValue("knowledge");
  } finally {
    await launched.close();
  }
});
