import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type Catalog,
  type NoteEntry,
  pictureProblems,
  type ReleaseManifest,
} from "../../src/core/releaseNotes/catalog";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { encodePng } from "./pictureFixtures";
import { heroShot } from "./pictures";
import { clickInBody, closeOpenCards, pagerAt, showCard, shownCard, shownEntry } from "./stack";
import { setThemeViaSettings } from "./theme";

/**
 * The startup release note (docs/release-notes.md "The startup note"),
 * offline, in the built app: after an upgrade one ordinary note is on top of
 * the card stack, listing exactly what is new since the version last opened;
 * a restart brings back the same note, and a closed one never returns; the
 * lead highlight shows its hero picture in the reader's theme. The app is
 * unpackaged, so the catalog comes from INFINITARY_RELEASE_NOTES_DIR and the
 * running version is the package's own.
 */

const VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const EARLIER = "0.0.1";
const SKIPPED = "0.0.2";

const entry = (
  id: string,
  kind: NoteEntry["kind"],
  title: string,
  extra: Partial<NoteEntry> = {},
) => ({ id, kind, title, provenance: { origin: "change" }, ...extra }) as NoteEntry;

const ENTRIES = [
  entry("already-had", "feature", "A change the earlier version already had"),
  entry("skipped-fix", "fix", "Replies keep their card", {
    body: "A reply moves its card to the back of the stack.",
  }),
  entry("levels", "feature", "Choose models by level in Settings", {
    highlight: 1,
    body: "The model catalog is arranged by levels, with drag and drop.",
  }),
  entry("past-cards", "feature", "Read a closed card again", {
    highlight: 2,
    body: "Ask your first mate for an earlier card and it comes forward as it was.",
  }),
  entry("task-facts", "improvement", "Task status reads the same everywhere", {
    highlight: 3,
    body: "Every view of a task shares one set of facts.",
  }),
  entry("old-panel", "removal", "The old gutter pane is gone"),
];
/** History backfilled in commit wording: every release carries it, and no note lists it. */
const BACKFILLED = entry("backfilled-old", "fix", "Quote dry-run fixture check path", {
  provenance: { origin: "changelog-backfill" },
});

const sha = (n: number) => n.toString(16).padStart(40, "0");
const manifest = (version: string, ids: string[], source: number): ReleaseManifest => ({
  version,
  channel: "stable",
  sourceCommit: sha(source),
  date: "2026-10-02",
  promotedFrom: null,
  entryIds: [...ids].sort(),
});
const RELEASES = [
  manifest(EARLIER, ["already-had", BACKFILLED.id], 1),
  manifest(SKIPPED, ["already-had", "skipped-fix", BACKFILLED.id], 2),
  manifest(VERSION, [...ENTRIES.map((e) => e.id), BACKFILLED.id], 3),
];
const CATALOG: Catalog = {
  schema: 1,
  release: { version: VERSION, sourceCommit: sha(3) },
  entries: [...ENTRIES, BACKFILLED],
  releases: RELEASES,
};
const NEW_SINCE_EARLIER = ["levels", "past-cards", "task-facts", "old-panel", "skipped-fix"];
const titleOf = (id: string) => ENTRIES.find((e) => e.id === id)?.title ?? id;

function notesDir(): string {
  const dir = scratchDir("infinitary-release-notes-dir-");
  writeFileSync(join(dir, "release-notes.json"), JSON.stringify(CATALOG));
  return dir;
}

/** The lead highlight's hero pair, one picture per theme, as a release packages them beside its catalog. */
const HERO_ALT = "The models board arranged by level";
const HERO_SIZE = { width: 600, height: 300 };
const HERO = {
  dark: {
    file: "levels-dark.png",
    bytes: encodePng(HERO_SIZE.width, HERO_SIZE.height, () => [24, 30, 48]),
  },
  light: {
    file: "levels-light.png",
    bytes: encodePng(HERO_SIZE.width, HERO_SIZE.height, () => [236, 240, 247]),
  },
};

function picturedNotesDir(): string {
  const dir = scratchDir("infinitary-release-notes-pictured-");
  const pictures = join(dir, "release-notes", "pictures");
  mkdirSync(pictures, { recursive: true });
  for (const { file, bytes } of Object.values(HERO)) writeFileSync(join(pictures, file), bytes);
  const catalog: Catalog = {
    ...CATALOG,
    entries: CATALOG.entries.map((e) =>
      e.id === "levels"
        ? { ...e, picture: { dark: HERO.dark.file, light: HERO.light.file, alt: HERO_ALT } }
        : e,
    ),
    pictures: Object.fromEntries(
      Object.values(HERO).map(({ file, bytes }) => [
        file,
        { sha256: createHash("sha256").update(bytes).digest("hex"), ...HERO_SIZE },
      ]),
    ),
  };
  writeFileSync(join(dir, "release-notes.json"), JSON.stringify(catalog));
  return dir;
}

/** What the saved profile says about release notes, read after the app has quit. */
function tracking(userDataDir: string) {
  const db = openDatabase(userDataDir);
  try {
    return new SettingsStore(db).getReleaseTracking();
  } finally {
    db.close();
  }
}

const stack = (page: Page) =>
  page.evaluate(() => window.infinitary.cards.list()) as Promise<Card[]>;

test("an upgrade puts one release note on top of the stack, a restart keeps it, and a closed one stays closed", async () => {
  const userDataDir = scratchDir("infinitary-release-notes-");
  const env = { INFINITARY_RELEASE_NOTES_DIR: notesDir() };
  const projectQuestion = "Which project first?";
  const firstProject = "First";
  // A profile that last opened the earlier version, after an even earlier
  // one, and has a decision open.
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({
    ...settings.getReleaseTracking(),
    profile: "legacy",
    baseline: { version: EARLIER, source: sha(1), recordedAt: Date.now() - 86_400_000 },
    previous: { version: "0.0.0", source: null, recordedAt: Date.now() - 2 * 86_400_000 },
  });
  new CardStore(db).upsert({
    id: "card-fm-open-decision",
    title: projectQuestion,
    author: "firstmate",
    priority: 30,
    meta: "firstmate",
    body: "<p>Two projects are waiting.</p>",
    actions: [
      { id: "first", label: firstProject, variant: "secondary" },
      { id: "second", label: "Second", variant: "primary", default: true },
    ],
    status: "ready",
    createdAt: Date.now() - 60_000,
  });
  db.close();

  let noteId = "";
  await test.step("the upgrade: the note is the top card, shown first, above the open decision", async () => {
    const launched = await launchApp({ userDataDir, withMockProvider: true, env });
    try {
      const cards = await stack(launched.page);
      const [top, below] = cards;
      expect(cards).toHaveLength(2);
      expect(top).toMatchObject({ author: "firstmate", actions: [] });
      expect(below?.id).toBe("card-fm-open-decision");
      noteId = top?.id ?? "";
      await expect(shownCard(launched.page, top?.title ?? "")).toBeVisible();
      await expect(pagerAt(launched.page, 1, 2)).toBeVisible();
      const body = cardBody(launched.page, top?.title ?? "");
      for (const id of NEW_SINCE_EARLIER)
        await expect(body.getByText(titleOf(id), { exact: true }).first()).toBeAttached();
      await expect(body.getByText(titleOf("already-had"))).toHaveCount(0);
      await expect(body.getByRole("region", { name: "Highlights" })).toBeVisible();
      await launched.page.screenshot({ path: test.info().outputPath("release-note-on-top.png") });
    } finally {
      await launched.close();
    }
    const saved = tracking(userDataDir);
    expect(saved.baseline?.version).toBe(VERSION);
    expect(saved.deliveries[VERSION]).toMatchObject({
      boundary: { version: EARLIER },
      coverage: "complete",
      cardId: noteId,
    });
    expect([...(saved.deliveries[VERSION]?.entryIds ?? [])].sort()).toEqual(
      [...NEW_SINCE_EARLIER].sort(),
    );
  });

  await test.step("a restart: the same note, still on top, and no second one", async () => {
    const launched = await launchApp({ userDataDir, withMockProvider: true, env });
    try {
      const cards = await stack(launched.page);
      expect(cards.map((card) => card.id)).toEqual([noteId, "card-fm-open-decision"]);
      // INF-1879: minus preserves a decision. Explicitly answer this fixture's
      // unrelated question; putting away the release note must still persist.
      await showCard(launched.page, projectQuestion);
      await shownEntry(launched.page)
        .getByRole("button", { name: firstProject, exact: true })
        .click();
      await closeOpenCards(launched.page);
      expect(await stack(launched.page)).toEqual([]);
    } finally {
      await launched.close();
    }
  });

  await test.step("after closing it: a restart brings nothing back", async () => {
    const launched = await launchApp({ userDataDir, withMockProvider: true, env });
    try {
      await expect
        .poll(() => launched.page.evaluate(() => window.infinitary.app.healthcheck()))
        .toMatchObject({ ok: true });
      expect(await stack(launched.page)).toEqual([]);
    } finally {
      await launched.close();
    }
    expect(Object.keys(tracking(userDataDir).deliveries)).toEqual([VERSION]);
  });
});

test("a first installation that needs no setup shows no note and records its version quietly", async () => {
  const userDataDir = scratchDir("infinitary-release-notes-fresh-");
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { INFINITARY_RELEASE_NOTES_DIR: notesDir() },
  });
  try {
    await expect
      .poll(() => launched.page.evaluate(() => window.infinitary.app.healthcheck()))
      .toMatchObject({ ok: true });
    expect(await stack(launched.page)).toEqual([]);
    expect(await launched.page.evaluate(() => window.infinitary.releaseNotes.list())).toMatchObject(
      {
        version: VERSION,
        notes: [],
      },
    );
  } finally {
    await launched.close();
  }
  // This version is the baseline the next upgrade's note measures from.
  const saved = tracking(userDataDir);
  expect(saved).toMatchObject({ profile: "fresh", baseline: { version: VERSION } });
  expect(saved.deliveries).toEqual({});
});

test("a profile whose earlier version kept no record gets every change written for it once, on top", async () => {
  const userDataDir = scratchDir("infinitary-release-notes-unrecorded-");
  const env = { INFINITARY_RELEASE_NOTES_DIR: notesDir() };
  // What 0.1.28-alpha.23 left on its first launch after a version with no
  // tracking: a baseline seeded silently, no previous version, no delivery.
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({
    ...settings.getReleaseTracking(),
    profile: "legacy",
    baseline: { version: EARLIER, source: sha(1), recordedAt: Date.now() - 86_400_000 },
    previous: null,
    deliveries: {},
  });
  db.close();

  let noteId = "";
  const launched = await launchApp({ userDataDir, withMockProvider: true, env });
  try {
    const [top, ...rest] = await stack(launched.page);
    expect(rest).toEqual([]);
    expect(top).toMatchObject({ author: "firstmate", actions: [] });
    noteId = top?.id ?? "";
    const body = cardBody(launched.page, top?.title ?? "");
    for (const change of ENTRIES)
      await expect(body.getByText(change.title, { exact: true }).first()).toBeAttached();
    await expect(body.getByText(BACKFILLED.title)).toHaveCount(0);
    await launched.page.screenshot({ path: test.info().outputPath("every-release-note.png") });
  } finally {
    await launched.close();
  }
  const saved = tracking(userDataDir);
  expect(saved).toMatchObject({ baseline: { version: VERSION }, previous: { version: EARLIER } });
  expect(saved.deliveries[VERSION]).toMatchObject({ coverage: "complete", cardId: noteId });
  expect([...(saved.deliveries[VERSION]?.entryIds ?? [])].sort()).toEqual(
    ENTRIES.map((e) => e.id).sort(),
  );

  const again = await launchApp({ userDataDir, withMockProvider: true, env });
  try {
    expect((await stack(again.page)).map((card) => card.id)).toEqual([noteId]);
  } finally {
    await again.close();
  }
});

test("the lead highlight shows its picture in your theme, opens it whole, and keeps it once the build's own copy is gone", async () => {
  const userDataDir = scratchDir("infinitary-release-notes-pictures-");
  const notesDir = picturedNotesDir();
  const env = { INFINITARY_RELEASE_NOTES_DIR: notesDir };
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({
    ...settings.getReleaseTracking(),
    profile: "legacy",
    baseline: { version: EARLIER, source: sha(1), recordedAt: Date.now() - 86_400_000 },
    previous: { version: "0.0.0", source: null, recordedAt: Date.now() - 2 * 86_400_000 },
  });
  db.close();
  const shownPicture = async (page: Page, title: string) => {
    const body = cardBody(page, title);
    const picture = body
      .getByRole("region", { name: "Highlights" })
      .getByRole("img", { name: HERO_ALT });
    await expect(picture).toHaveCount(1);
    await expect
      .poll(() =>
        picture.evaluate(async (image: HTMLImageElement) => {
          await image.decode();
          return [image.naturalWidth, image.naturalHeight];
        }),
      )
      .toEqual([HERO_SIZE.width, HERO_SIZE.height]);
    return picture;
  };

  let noteId = "";
  await test.step("the upgrade: the lead highlight shows the dark picture and opens it in the viewer", async () => {
    const launched = await launchApp({ userDataDir, withMockProvider: true, env });
    try {
      const { page } = launched;
      const [top] = await stack(page);
      noteId = top?.id ?? "";
      expect(top?.pictures?.map((picture) => picture.alt)).toEqual([HERO_ALT, HERO_ALT]);
      const picture = await shownPicture(page, top?.title ?? "");
      await expect(picture).toHaveAttribute("data-inf-theme", "dark");
      await clickInBody(picture);
      const viewer = page.getByRole("dialog", { name: /^Pictures from / });
      await expect(viewer).toBeVisible();
      await expect(viewer.locator("[data-picture-image]")).toHaveAttribute(
        "src",
        (await picture.getAttribute("src")) ?? "",
      );
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("release-note-picture-dark.png") });

      await setThemeViaSettings(page, "light");
      await expect(await shownPicture(page, top?.title ?? "")).toHaveAttribute(
        "data-inf-theme",
        "light",
      );
      await page.screenshot({ path: test.info().outputPath("release-note-picture-light.png") });
    } finally {
      await launched.close();
    }
  });

  await test.step("the next build carries other files: the note keeps its pictures", async () => {
    rmSync(join(notesDir, "release-notes"), { recursive: true, force: true });
    const launched = await launchApp({ userDataDir, withMockProvider: true, env });
    try {
      const { page } = launched;
      const [top] = await stack(page);
      expect(top?.id).toBe(noteId);
      await expect(await shownPicture(page, top?.title ?? "")).toHaveAttribute(
        "data-inf-theme",
        "light",
      );
    } finally {
      await launched.close();
    }
  });
});

test("a change's hero pair, taken with heroShot from the view it changed, passes the ledger's picture check", async () => {
  const userDataDir = scratchDir("infinitary-release-notes-hero-");
  const db = openDatabase(userDataDir);
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({
    ...settings.getReleaseTracking(),
    profile: "legacy",
    baseline: { version: EARLIER, source: sha(1), recordedAt: Date.now() - 86_400_000 },
    previous: { version: "0.0.0", source: null, recordedAt: Date.now() - 2 * 86_400_000 },
  });
  db.close();
  const dir = scratchDir("infinitary-release-notes-hero-pair-");
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    env: { INFINITARY_RELEASE_NOTES_DIR: picturedNotesDir() },
  });
  try {
    const { page } = launched;
    const [top] = await stack(page);
    const highlights = cardBody(page, top?.title ?? "").getByRole("region", { name: "Highlights" });
    await expect(highlights.getByRole("img", { name: HERO_ALT })).toBeVisible();
    const pair = await heroShot(launched.app, page, {
      region: highlights.getByRole("heading", { name: titleOf("levels") }),
      anchors: [highlights.getByRole("img", { name: HERO_ALT })],
      name: "levels",
      dir,
    });
    expect(pair).toMatchObject({ dark: "levels-dark.webp", light: "levels-light.webp" });
    // Landscape, a WebP within the caps, and both themes from the one clip.
    expect(pair.width).toBeGreaterThan(pair.height);
    const levels = ENTRIES.find((e) => e.id === "levels") as NoteEntry;
    const entry = { ...levels, picture: { dark: pair.dark, light: pair.light, alt: HERO_ALT } };
    expect(
      pictureProblems(
        [
          {
            path: "changes/levels.json",
            file: { entries: [entry], exclusions: [] },
            selfCovering: true,
          },
        ],
        (file) => readFileSync(join(dir, file)),
      ),
    ).toEqual([]);
    // The theme it started in is put back.
    expect(await page.evaluate(() => document.body.dataset.theme)).toBe("dark");
  } finally {
    await launched.close();
  }
});
