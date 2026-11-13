import { DEFAULT_DICTATION } from "@shared/dictation";
import { appearanceSchema } from "@shared/preferences";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "./db";
import { SettingsStore } from "./settingsStore";

/**
 * The captain's presentation choices live in the core's `settings` table
 * (src/shared/preferences.ts), which is what makes them survive a relaunch
 * with a fresh window profile. A row the schema does not recognise is not a
 * reason to fail: the store answers the default, the way every other KV here
 * does, so a value written by a future version cannot brick the window.
 */
describe("SettingsStore preferences", () => {
  function store(): SettingsStore {
    return new SettingsStore(openInMemoryDatabase());
  }

  it("persists an OpenRouter decision pick and versioned consent without a credential", () => {
    const settings = store();
    const decisions = {
      version: 1 as const,
      answerer: { kind: "openrouter" as const, model: "typesafe/jev-1.13" },
      egress: {
        openrouter: { enabled: true, consentedVersion: 1 },
        jev: { enabled: true, consentedVersion: 1 },
      },
    };
    settings.setDecisions(decisions);
    expect(settings.getDecisions()).toEqual(decisions);
  });

  it.each([0, 19, 20, 21, 35, 100])("migrates only saved 20%% once (saved %s)", (washStrength) => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const appearance = { theme: "light", washStrength, size: 150, showCrewModelNames: false };
    const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    write.run("appearance", JSON.stringify(appearance));
    write.run("wash-opacity-v2", "true");
    const expected = { ...appearance, washStrength: washStrength === 20 ? 0 : washStrength };
    expect(settings.getAppearance()).toEqual(expected);
    expect(
      JSON.parse(
        (
          db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance") as {
            value: string;
          }
        ).value,
      ),
    ).toEqual(expected);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = ?").get("wash-default-zero-v1"),
    ).toEqual({ value: "true" });
    settings.setAppearance({ theme: "light", washStrength: 20 });
    expect(new SettingsStore(db).getAppearance().washStrength).toBe(20);
  });

  it("records the migration on a fresh install before a later 20% choice", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    expect(settings.getAppearance().washStrength).toBe(0);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = ?").get("wash-default-zero-v1"),
    ).toEqual({ value: "true" });
    settings.setAppearance({ theme: "dark", washStrength: 20 });
    expect(new SettingsStore(db).getAppearance().washStrength).toBe(20);
  });

  it("answers 0% when a saved appearance never recorded a wash", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    write.run("appearance", JSON.stringify({ theme: "light" }));
    write.run("wash-opacity-v2", "true");
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      washStrength: 0,
      size: 100,
      showCrewModelNames: true,
    });
  });

  it("preserves a chosen wash when only the theme changes", () => {
    const settings = store();
    settings.setAppearance({ theme: "dark", washStrength: 35 });
    settings.setAppearance({ theme: "light" });
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      washStrength: 35,
      size: 100,
      showCrewModelNames: true,
    });
  });

  it("converts legacy wash values once, moving the former default through 20% to 0%", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "appearance",
      JSON.stringify({ theme: "light", washStrength: 100 }),
    );
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      washStrength: 0,
      size: 100,
      showCrewModelNames: true,
    });
    settings.setAppearance({ theme: "light", washStrength: 100 });
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      washStrength: 100,
      size: 100,
      showCrewModelNames: true,
    });
  });

  it("preserves a non-default legacy wash as its approximate actual opacity", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "appearance",
      JSON.stringify({ theme: "dark", washStrength: 50 }),
    );
    expect(settings.getAppearance()).toEqual({
      theme: "dark",
      washStrength: 39,
      size: 100,
      showCrewModelNames: true,
    });
    expect(settings.getAppearance()).toEqual({
      theme: "dark",
      washStrength: 39,
      size: 100,
      showCrewModelNames: true,
    });
  });

  it("persists hidden crew names without losing the choice on partial appearance writes", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setAppearance({ theme: "dark", showCrewModelNames: false });
    expect(new SettingsStore(db).getAppearance().showCrewModelNames).toBe(false);
    settings.setAppearance({ theme: "light", washStrength: 60 });
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      washStrength: 60,
      size: 100,
      showCrewModelNames: false,
    });
    settings.setAppearance({ theme: "light", showCrewModelNames: true });
    expect(new SettingsStore(db).getAppearance().showCrewModelNames).toBe(true);
  });

  it("persists size and preserves it through partial appearance writes", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setAppearance({ theme: "dark", size: 150 });
    settings.setAppearance({ theme: "light", washStrength: 35 });
    expect(new SettingsStore(db).getAppearance()).toMatchObject({
      size: 150,
      theme: "light",
      washStrength: 35,
    });
  });

  // The captain's ask (INF-3152): once a card is maximized, every card stays
  // maximized until one is restored, and that lasts through a restart; an
  // older build still reads theme, size and wash from the appearance row.
  it("keeps Keep cards maximized and the maximized state apart from the row an older build reads", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setAppearance({ theme: "light", size: 125, washStrength: 35 });
    expect(settings.getAppearance().keepCardsMaximized).toBeUndefined();
    settings.setAppearance({ theme: "light", keepCardsMaximized: true, cardsMaximized: true });
    // A later write without them, such as a theme change, keeps them.
    settings.setAppearance({ theme: "dark" });
    expect(new SettingsStore(db).getAppearance()).toEqual({
      theme: "dark",
      size: 125,
      washStrength: 35,
      showCrewModelNames: true,
      keepCardsMaximized: true,
      cardsMaximized: true,
    });
    const row = JSON.parse(
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance") as {
          value: string;
        }
      ).value,
    );
    const olderBuild = appearanceSchema.omit({ keepCardsMaximized: true, cardsMaximized: true });
    expect(olderBuild.parse(row)).toEqual({
      theme: "dark",
      size: 125,
      washStrength: 35,
      showCrewModelNames: true,
    });
    settings.setAppearance({ theme: "dark", cardsMaximized: false });
    expect(new SettingsStore(db).getAppearance()).toMatchObject({
      keepCardsMaximized: true,
      cardsMaximized: false,
    });
  });

  // The approved plan (INF-3674): a Settings choice overrides the computer's
  // language, and an older build still reads the rest of the look.
  it("keeps the language choice in its own row, and a look without one follows the computer", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setAppearance({ theme: "light", size: 125, language: "ja" });
    // A theme change writes the whole look it read, language included.
    settings.setAppearance({ ...settings.getAppearance(), theme: "dark" });
    expect(new SettingsStore(db).getAppearance()).toMatchObject({
      theme: "dark",
      size: 125,
      language: "ja",
    });
    const row = JSON.parse(
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance") as {
          value: string;
        }
      ).value,
    );
    expect(appearanceSchema.omit({ language: true }).safeParse(row).success).toBe(true);
    expect(row.language).toBeUndefined();
    const { language: _chosen, ...followComputer } = settings.getAppearance();
    settings.setAppearance(followComputer);
    expect(new SettingsStore(db).getAppearance().language).toBeUndefined();
    expect(new SettingsStore(db).getAppearance().theme).toBe("dark");
  });

  // The approved plan (INF-3982, direction B): any installed font for the
  // app, reading and code, kept across a restart, while an older build,
  // which reads the appearance row strictly, still reads the rest of the look.
  it("keeps the font choice in its own row, and a look without one takes Infinitary's own", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setAppearance({ theme: "light", fonts: { app: "Inter", code: "ui-monospace" } });
    settings.setAppearance({ ...settings.getAppearance(), theme: "dark" });
    expect(new SettingsStore(db).getAppearance()).toMatchObject({
      theme: "dark",
      fonts: { app: "Inter", code: "ui-monospace" },
    });
    const row = JSON.parse(
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get("appearance") as {
          value: string;
        }
      ).value,
    );
    expect(appearanceSchema.omit({ fonts: true, language: true }).safeParse(row).success).toBe(
      true,
    );
    const { fonts: _chosen, ...ownFonts } = settings.getAppearance();
    settings.setAppearance(ownFonts);
    expect(new SettingsStore(db).getAppearance().fonts).toBeUndefined();
    expect(new SettingsStore(db).getAppearance().theme).toBe("dark");
  });

  it("keeps the panels the captain moved", () => {
    const settings = store();
    settings.setLayout({
      collapsedPanels: { activity: false, now: true },
      hiddenPanels: {},
      placements: {},
    });
    expect(settings.getLayout()).toEqual({
      collapsedPanels: { activity: false, now: true },
      hiddenPanels: {},
      placements: {},
    });
  });

  // INF-2344: the arrangement lives in a row of its own, because a build
  // from before it reads the `layout` row strictly and would drop every
  // collapse choice on a key it does not know (docs/saved-data-compatibility.md).
  it("keeps the arrangement and the More pick out of the layout row an older build reads", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const arrangement = {
      left: { top: [], bottom: ["activity"] },
      right: { top: ["tokyo-clock"], bottom: ["now", "knowledge"] },
    };
    settings.setLayout({
      collapsedPanels: { now: true },
      hiddenPanels: {},
      placements: {},
      arrangement,
      morePick: "tokyo-clock",
    });
    const row = (key: string) =>
      JSON.parse(
        (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string })
          .value,
      );
    // The keys the layout row held before the arrangement existed.
    expect(Object.keys(row("layout")).sort()).toEqual([
      "collapsedPanels",
      "hiddenPanels",
      "placements",
    ]);
    expect(row("panel-arrangement")).toEqual({ arrangement, morePick: "tokyo-clock" });
    // A write without an arrangement, as an older build makes, keeps it.
    settings.setLayout({ collapsedPanels: {}, hiddenPanels: { now: true }, placements: {} });
    expect(settings.getLayout()).toEqual({
      collapsedPanels: {},
      hiddenPanels: { now: true },
      placements: {},
      arrangement,
      morePick: "tokyo-clock",
    });
  });

  it("answers the default for an unreadable row rather than throwing", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    write.run("appearance", JSON.stringify({ theme: "sepia" }));
    write.run("layout", "{not json");
    expect(settings.getAppearance()).toEqual({
      theme: "dark",
      washStrength: 0,
      size: 100,
      showCrewModelNames: true,
    });
    expect(settings.getLayout()).toEqual({ collapsedPanels: {}, hiddenPanels: {}, placements: {} });
  });
});

describe("dictation", () => {
  it("defaults on and retains the selected key while off, including in a fresh store", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    expect(settings.getDictation()).toEqual(DEFAULT_DICTATION);
    settings.setDictation({ enabled: false, key: "ControlRight" });
    expect(new SettingsStore(db).getDictation()).toEqual({ enabled: false, key: "ControlRight" });
    db.close();
  });
});

it("keeps personal resources off until explicitly enabled and persists the choice", () => {
  const db = openInMemoryDatabase();
  try {
    const settings = new SettingsStore(db);
    expect(settings.getPersonalResourcesEnabled()).toBe(false);
    settings.setPersonalResourcesEnabled(true);
    expect(new SettingsStore(db).getPersonalResourcesEnabled()).toBe(true);
    settings.setPersonalResourcesEnabled(false);
    expect(new SettingsStore(db).getPersonalResourcesEnabled()).toBe(false);
  } finally {
    db.close();
  }
});
