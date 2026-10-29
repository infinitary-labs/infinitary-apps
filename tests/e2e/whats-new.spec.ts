import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { READ_AGAIN } from "../../src/core/releaseNotes/briefing";
import type { Catalog, NoteEntry, ReleaseManifest } from "../../src/core/releaseNotes/catalog";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import type { Card } from "../../src/shared/cards";
import type { ReleaseDelivery } from "../../src/shared/releaseTracking";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { HAS_APP_MENU } from "./desktop";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { settingRow } from "./settings";
import { SHOWN_ENTRY, shownCardFrame } from "./stack";
import { MAC_ONLY_TAG } from "./tags";
import {
  commandSearch,
  endRecording,
  keyboardSettings,
  menuItemAccelerator,
  pressKey,
  pressWindowKey,
  runFromSearch,
  startRecording,
} from "./windowKeys";

/**
 * Reading a release note again (docs/release-notes.md "Reading a note
 * again"): after the startup note, What's new brings it back from the Help
 * menu, command search, Settings → General → Version and Firstmate, through
 * one door - to the front of the stack while it is open, read-only once it
 * is closed - and a key a person records for it runs it. Before any note,
 * every way in says there is none and runs nothing. The app is unpackaged,
 * so the catalog comes from INFINITARY_RELEASE_NOTES_DIR.
 */

const VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const EARLIER = "0.0.1";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const ENTRIES = [
  {
    id: "levels",
    kind: "feature",
    title: "Choose models by level in Settings",
    highlight: 1,
    provenance: { origin: "change" },
  },
  {
    id: "past-cards",
    kind: "feature",
    title: "Read a closed card again",
    provenance: { origin: "change" },
  },
] as NoteEntry[];
const manifest = (version: string, ids: string[], source: number): ReleaseManifest => ({
  version,
  channel: "stable",
  sourceCommit: sha(source),
  date: "2026-10-02",
  promotedFrom: null,
  entryIds: ids,
});
const CATALOG: Catalog = {
  schema: 1,
  release: { version: VERSION, sourceCommit: sha(3) },
  entries: ENTRIES,
  releases: [manifest(EARLIER, [], 1), manifest(VERSION, ["levels", "past-cards"], 3)],
};

/** A profile that last opened the earlier version, with a decision still open. */
function upgradedProfile(): { userDataDir: string; notes: string } {
  const userDataDir = scratchDir("infinitary-whats-new-");
  const notes = scratchDir("infinitary-whats-new-notes-");
  writeFileSync(join(notes, "release-notes.json"), JSON.stringify(CATALOG));
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({
    ...settings.getReleaseTracking(),
    profile: "legacy",
    baseline: { version: EARLIER, source: sha(1), recordedAt: Date.now() - 86_400_000 },
    previous: { version: "0.0.0", source: null, recordedAt: Date.now() - 2 * 86_400_000 },
  });
  new CardStore(db).upsert({
    id: "card-open-decision",
    title: "Which project first?",
    author: "firstmate",
    priority: 30,
    meta: "firstmate",
    body: "<p>Two projects are waiting.</p>",
    actions: [
      { id: "first", label: "First", variant: "secondary" },
      { id: "second", label: "Second", variant: "primary", default: true },
    ],
    status: "ready",
    createdAt: Date.now() - 60_000,
  });
  db.close();
  return { userDataDir, notes };
}

/** The Help menu's What's New, as the app menu holds it now. */
const helpItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("whats-new");
    const help = Menu.getApplicationMenu()?.items.find((entry) => entry.role === "help");
    return item ? { enabled: item.enabled, inHelp: help?.submenu?.items.includes(item) } : null;
  });

/** Chooses What's New in the Help menu, as a click on it does. */
const chooseHelpItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("whats-new");
    if (!item) throw new Error("No What's New in the Help menu");
    item.click();
  });

const shownEntryId = (page: Page) =>
  page.locator(SHOWN_ENTRY).first().getAttribute("data-stage-entry-id");

test("What's new brings the release note back from the Help menu, command search, Settings, Firstmate and a key of its own", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.setTimeout(120_000);
  const { userDataDir, notes } = upgradedProfile();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { INFINITARY_RELEASE_NOTES_DIR: notes },
  });
  try {
    const { app, page } = launched;
    await expect(promptInput(page)).toBeVisible();
    const cards = (await page.evaluate(() => window.infinitary.cards.list())) as Card[];
    const noteId = cards[0]?.id ?? "";
    expect(cards.map((card) => card.id)).toEqual([noteId, "card-open-decision"]);
    const pastNote = page.locator(`[data-past-card="${noteId}"]`);
    const search = commandSearch(page);
    // A desktop whose window draws its own controls has no app menu, so no Help menu.
    if (HAS_APP_MENU)
      await expect.poll(() => helpItem(app)).toEqual({ enabled: true, inHelp: true });

    await test.step("with the note open, command search and the Help menu bring it to the front", async () => {
      await runFromSearch(app, page, "cards.next");
      await expect.poll(() => shownEntryId(page)).toBe("card-open-decision");
      await pressWindowKey(app, "k", ["meta"]);
      await search.field.fill("release notes");
      await expect(search.rows).toHaveCount(1);
      await expect(search.row("whats-new.show")).toHaveAttribute("aria-selected", "true");
      await pressWindowKey(app, "Enter");
      await expect(search.dialog).toHaveCount(0);
      await expect.poll(() => shownEntryId(page)).toBe(noteId);
      await expect(pastNote).toHaveCount(0);

      if (HAS_APP_MENU) {
        await runFromSearch(app, page, "cards.next");
        await expect.poll(() => shownEntryId(page)).toBe("card-open-decision");
        await chooseHelpItem(app);
        await expect.poll(() => shownEntryId(page)).toBe(noteId);
      }
      expect((await page.evaluate(() => window.infinitary.cards.list())).length).toBe(2);
    });

    await test.step("with the note closed, both bring it back read-only, and make no new card", async () => {
      await runFromSearch(app, page, "cards.close");
      await expect
        .poll(() =>
          page.evaluate(() => window.infinitary.cards.list().then((l) => l.map((c) => c.id))),
        )
        .toEqual(["card-open-decision"]);
      await runFromSearch(app, page, "whats-new.show");
      await expect(pastNote).toBeVisible();
      // The note reads as it was shown, ending on where to read it again.
      await expect(shownCardFrame(page).getByText(READ_AGAIN)).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("whats-new-past-note.png") });
      await page.keyboard.press("Escape");
      await expect(pastNote).toHaveCount(0);

      if (HAS_APP_MENU) {
        await chooseHelpItem(app);
        await expect(pastNote).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(pastNote).toHaveCount(0);
      }
      expect(
        (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.id),
      ).toEqual(["card-open-decision"]);
    });

    await test.step("Settings → General lists the note under the version, and Enter opens it", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      await page.getByRole("tab", { name: "General", exact: true }).click();
      const row = settingRow(page, "version").locator(`[data-release-note="${VERSION}"]`);
      await expect(row).toBeVisible();
      await pressKey(row, "Enter");
      await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
      await expect(pastNote).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pastNote).toHaveCount(0);
    });

    await test.step("asking Firstmate brings the same note forward", async () => {
      await promptInput(page).fill(
        `${APP_CATALOG_PROMPT_MARKER}${JSON.stringify({ action: "show-whats-new", value: {} })}`,
      );
      await promptInput(page).press("Enter");
      await expect(pastNote).toBeVisible();
      await waitForFirstmateIdle(page);
      await page.keyboard.press("Escape");
      await expect(pastNote).toHaveCount(0);
    });

    await test.step("Keyboard settings lists it, and a key recorded there runs it", async () => {
      const keyboard = keyboardSettings(page);
      await runFromSearch(app, page, "settings.keyboard");
      await expect(keyboard.row("whats-new.show")).toBeVisible();
      await startRecording(page, "whats-new.show");
      await pressWindowKey(app, "n", ["meta", "control"]);
      await expect(keyboard.verdict("whats-new.show")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.row("whats-new.show")).toHaveAttribute("data-keyboard-changed", "true");
      if (HAS_APP_MENU)
        expect(await menuItemAccelerator(app, "whats-new")).toBe("Command+Control+N");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(promptInput(page)).toBeVisible();
      await pressWindowKey(app, "n", ["meta", "control"]);
      await expect(pastNote).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

test("before any release note, every way in says there is none and runs nothing", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { app, page } = launched;
    if (HAS_APP_MENU)
      await expect.poll(() => helpItem(app)).toEqual({ enabled: false, inHelp: true });
    const search = commandSearch(page);
    await pressWindowKey(app, "k", ["meta"]);
    await search.field.fill("what's new");
    await expect(search.row("whats-new.show")).toHaveAttribute("aria-disabled", "true");
    await expect(search.row("whats-new.show").locator("[data-command-refusal]")).not.toBeEmpty();
    await pressWindowKey(app, "Enter");
    // A refused row runs nothing and leaves search open.
    await expect(search.dialog).toBeVisible();
    await pressWindowKey(app, "Escape");
    await expect(search.dialog).toHaveCount(0);
    await expect(page.locator("[data-past-card]")).toHaveCount(0);

    await pressWindowKey(app, ",", ["meta"]);
    await page.getByRole("tab", { name: "General", exact: true }).click();
    await expect(settingRow(page, "version")).toBeVisible();
    await expect(settingRow(page, "version").locator("[data-release-note]")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

// A fresh profile with five actual saved notes; no earlier test owns this history.
test("General reveals older notes from the keyboard and opens the selected saved note", async () => {
  const home = scratchDir("fm-version-history-");
  const db = openDatabase(home);
  const settings = new SettingsStore(db);
  const deliveries: Record<string, ReleaseDelivery> = {};
  for (let n = 1; n <= 5; n++) {
    const version = `0.1.28-alpha.${n}`;
    const id = `release-example-${n}`;
    new CardStore(db).upsert({
      id,
      title: `What’s new in alpha ${version}`,
      author: "firstmate",
      priority: 0,
      meta: "firstmate",
      body: `<p>Changes in alpha ${version}.</p>`,
      actions: [],
      status: "ready",
      createdAt: Date.UTC(2026, 9, n, 12),
    });
    new CardStore(db).resolve(id, "close");
    deliveries[version] = {
      boundary: { version: null, source: null },
      entryIds: ["example"],
      coverage: "complete",
      cardId: id,
      deliveredAt: Date.UTC(2026, 9, n, 12),
    };
  }
  settings.setReleaseTracking({ ...settings.getReleaseTracking(), deliveries });
  db.close();
  const launched = await launchApp({ userDataDir: home, withMockProvider: true });
  try {
    const { page } = launched;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    const version = settingRow(page, "version");
    const rows = version.locator("[data-release-note]");
    await expect(rows).toHaveCount(3);
    await pressKey(rows.first(), "End");
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(version.locator('[data-release-note="0.1.28-alpha.4"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(version.locator('[data-release-note="0.1.28-alpha.4"]')).toBeFocused();
    await page.keyboard.press("Tab");
    const more = version.locator("[data-release-notes-more]");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(5);
    await expect(version.locator('[data-release-note="0.1.28-alpha.2"]')).toBeFocused();
    await expect(version.locator('[data-release-note][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(version.locator('[data-release-note="0.1.28-alpha.2"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-past-card="release-example-1"]')).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.infinitary.releaseNotes.list().then((view) => view.notes.length),
      ),
    ).toBe(5);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(more).toBeVisible();
  } finally {
    await launched.close();
  }
});
