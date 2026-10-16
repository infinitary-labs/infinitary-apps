import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { webpBytes } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CardService } from "../orchestrator/cardService";
import { keepPictureFile } from "../pi/cardImages";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { TaskService } from "../tasks/taskService";
import { type CatalogLoad, loadCatalog, ReleaseNotesService } from "./startup";
import { catalogFor, ENTRIES, RELEASES } from "./testCatalog";

/**
 * The startup note on the real writers (TaskService, CardStore, CardService
 * and SettingsStore over one in-memory database), one launch per
 * `launch(version)`: what reaches the stack, where it sits, and what is
 * recorded with it.
 */

const RELEASE_TITLE = /^What’s new in |^Your app is updated$|^Your alpha is now stable$/;

function setup(profile: "fresh" | "legacy" = "legacy") {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  settings.setReleaseTracking({ ...settings.getReleaseTracking(), profile });
  settings.setFirstRun({ ...settings.getFirstRun(), welcomeState: "skipped" });
  const tasks = new TaskService({ db, strict: true });
  const cardStore = new CardStore(db);
  const published: string[][] = [];
  let clock = 1000;
  const now = () => (clock += 1);
  const makeCards = () =>
    new CardService({
      now,
      tasks,
      cardStore,
      syncCaptainGate: () => {},
      noteCapAnswered: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: (cards) => published.push(cards.map((card) => card.id)),
    });
  let cards = makeCards();
  // This build's pictures beside its catalog, and where the host keeps its copies.
  const picturesDir = scratchDir("infinitary-release-notes-pictures-");
  const keptDir = join(scratchDir("infinitary-release-notes-kept-"), "release-notes", "cards");
  let load: (version: string) => CatalogLoad = (version) => ({
    kind: "ok",
    catalog: catalogFor(version),
    picturesDir,
  });
  const service = (version: string) =>
    new ReleaseNotesService(
      {
        settings,
        isOpen: (id) => cards.has(id),
        catalog: () => load(version),
        createNote: (note, record) => {
          cards.addRecordedFirstmateNote(note, record, { onTop: true });
        },
        keepPicture: (file) => keepPictureFile(file, { dir: keptDir, taskId: "release-notes" }),
        now,
      },
      { version, source: null },
    );
  return {
    db,
    settings,
    tasks,
    cardStore,
    published,
    service,
    launch: (version: string) => service(version).reconcile(),
    /** A profile whose history is recorded: `version` last ran, after an earlier one. */
    seed: (version: string) =>
      settings.setReleaseTracking({
        ...settings.getReleaseTracking(),
        baseline: { version, source: null, recordedAt: now() },
        previous: { version: "0.1.0", source: null, recordedAt: now() },
      }),
    cards: () => cards,
    /** A new process over the same saved data: the stack is what the store restores. */
    restart: () => {
      cards = makeCards();
    },
    catalog: (fn: (version: string) => CatalogLoad) => {
      load = fn;
    },
    picturesDir,
    keptDir,
    top: () => cards.snapshot()[0],
    releaseNotes: () => cards.snapshot().filter((card) => RELEASE_TITLE.test(card.title)),
    tracking: () => settings.getReleaseTracking(),
  };
}

const listed = (body: string) =>
  [...body.matchAll(/<li><strong>(.*?)<\/strong>/g)].map((match) => match[1]);

describe("an upgrade", () => {
  it("commits its note on top of the stack with the answer, baseline and delivery together, then publishes it", () => {
    const f = setup();
    f.seed("0.1.25");
    // What the captain already has open: a decision, and an earlier note.
    f.cards().addFirstmateCard({
      title: "Which way?",
      body: "<p>Two ways.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    f.cards().addRecordedFirstmateNote({ title: "Earlier note", body: "<p>Hi.</p>" }, () => {});
    f.published.length = 0;
    let atPublish: { stored: number; baseline?: string } | undefined;
    f.tasks.onChange(() => {
      atPublish ??= {
        stored: f.cardStore.listOpen().length,
        baseline: f.tracking().baseline?.version,
      };
    });

    expect(f.launch("0.1.27")).toBe("delivered");

    const note = f.top();
    expect(note).toMatchObject({
      author: "firstmate",
      actions: [],
      title: "What’s new in stable 0.1.27",
    });
    expect(
      f
        .cards()
        .snapshot()
        .map((card) => card.title),
    ).toEqual(["What’s new in stable 0.1.27", "Which way?", "Earlier note"]);
    // By area, features first: these fixtures declare none, so all are Other changes.
    expect(listed(note?.body ?? "")).toEqual([
      "Change change-d",
      "Change change-b",
      "Change change-c",
    ]);
    // Everything was written before anything was told.
    expect(atPublish).toEqual({ stored: 3, baseline: "0.1.27" });
    expect(f.published).toHaveLength(1);
    expect(f.published[0]?.[0]).toBe(note?.id);
    expect(f.tasks.taskForCard(note?.id ?? "")).toMatchObject({ kind: "question", status: "done" });
    expect(f.tracking()).toMatchObject({
      baseline: { version: "0.1.27" },
      previous: { version: "0.1.25" },
      deliveries: {
        "0.1.27": {
          boundary: { version: "0.1.25" },
          entryIds: ["change-d", "change-c", "change-b"],
          coverage: "complete",
          cardId: note?.id,
        },
      },
      unresolved: [],
    });
  });

  it("rolls back note, answer, baseline and delivery together, holding nothing, and the next launch retries", () => {
    const f = setup();
    f.seed("0.1.25");
    vi.spyOn(f.settings, "setReleaseTracking").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    f.published.length = 0;
    expect(f.launch("0.1.27")).toBe("failed");
    expect(f.cardStore.listOpen()).toEqual([]);
    expect(f.cards().snapshot()).toEqual([]);
    expect(f.tasks.list()).toEqual([]);
    expect(f.tracking()).toMatchObject({ baseline: { version: "0.1.25" }, deliveries: {} });
    expect(f.published).toEqual([]);

    expect(f.launch("0.1.27")).toBe("delivered");
    expect(f.releaseNotes()).toHaveLength(1);
  });

  it("is restored on top after a crash, and never reissued by a restart, a close or a reinstall", () => {
    const f = setup();
    f.seed("0.1.25");
    f.cards().addFirstmateCard({
      title: "An open decision",
      body: "<p>Choose.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    f.launch("0.1.27");
    const id = f.top()?.id;
    f.restart();
    expect(
      f
        .cards()
        .snapshot()
        .map((card) => card.id)[0],
    ).toBe(id);
    expect(f.cards().snapshot()).toHaveLength(2);
    expect(f.launch("0.1.27")).toBe("unchanged");
    expect(f.releaseNotes().map((card) => card.id)).toEqual([id]);

    const note = f.cards().get(id ?? "");
    if (note) f.cards().dismiss(note);
    f.restart();
    expect(f.launch("0.1.27")).toBe("unchanged");
    expect(f.releaseNotes()).toEqual([]);
    expect(f.tasks.list().filter((task) => task.kind === "question")).toHaveLength(1);
  });

  it("gives a later upgrade its own note on top and keeps the earlier unread one", () => {
    const f = setup();
    f.seed("0.1.25");
    f.launch("0.1.26");
    f.launch("0.1.27");
    expect(f.releaseNotes().map((card) => card.title)).toEqual([
      "What’s new in stable 0.1.27",
      "What’s new in stable 0.1.26",
    ]);
    expect(listed(f.top()?.body ?? "")).toEqual(["Change change-d", "Change change-c"]);
  });

  it("orders alphas by number, so alpha.10 after alpha.2 is an upgrade", () => {
    const f = setup();
    f.seed("0.1.28-alpha.2");
    expect(f.launch("0.1.28-alpha.10")).toBe("delivered");
    expect(f.top()?.title).toBe("What’s new in alpha 0.1.28-alpha.10");
    expect(f.launch("0.1.28-alpha.2")).toBe("downgraded");
  });

  it("says a promotion with nothing new in one compact note", () => {
    const f = setup();
    f.seed("0.1.27-alpha.20");
    expect(f.launch("0.1.27")).toBe("delivered");
    expect(f.top()?.title).toBe("Your alpha is now stable");
    expect(f.tracking().deliveries["0.1.27"]).toMatchObject({ entryIds: [], coverage: "complete" });
  });
});

describe("a downgrade", () => {
  it("records the lower version with no note, never reissues a delivered one, and later compares with the lower version", () => {
    const f = setup();
    f.seed("0.1.25");
    f.launch("0.1.27");
    const first = f.top();
    if (first) f.cards().dismiss(first);

    expect(f.launch("0.1.26")).toBe("downgraded");
    expect(f.tracking().baseline?.version).toBe("0.1.26");
    expect(f.launch("0.1.27")).toBe("upgraded");
    expect(f.releaseNotes()).toEqual([]);

    expect(f.launch("0.1.26")).toBe("downgraded");
    expect(f.launch("0.1.28-alpha.10")).toBe("delivered");
    // Measured from 0.1.26, less what 0.1.27's note already listed.
    expect(listed(f.top()?.body ?? "")).toEqual(["Change change-e", "Change change-f"]);
    expect(f.tracking().deliveries["0.1.28-alpha.10"]?.boundary.version).toBe("0.1.26");
  });
});

describe("no known version", () => {
  it("gives an existing profile every recorded change once, on top", () => {
    const f = setup("legacy");
    f.cards().addFirstmateCard({
      title: "An open decision",
      body: "<p>Choose.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    expect(f.launch("0.1.27")).toBe("delivered");
    expect(f.top()?.title).toBe("What’s new in stable 0.1.27");
    const body = f.top()?.body ?? "";
    expect(listed(body)).toEqual([
      "Change change-d",
      "Change change-a",
      "Change change-b",
      "Change change-c",
    ]);
    expect(body).toContain("An earlier version");
    expect(f.tracking()).toMatchObject({
      baseline: { version: "0.1.27" },
      previous: null,
      deliveries: { "0.1.27": { boundary: { version: null }, coverage: "complete" } },
    });
    expect(f.launch("0.1.27")).toBe("unchanged");
    expect(f.launch("0.1.28-alpha.10")).toBe("delivered");
    expect(listed(f.top()?.body ?? "")).toEqual(["Change change-e", "Change change-f"]);
  });

  it("gives a profile alpha.23 seeded silently every recorded change at its next upgrade", () => {
    const f = setup("legacy");
    // alpha.23's silent seed: a baseline, no previous version, no delivery.
    f.settings.setReleaseTracking({
      ...f.tracking(),
      baseline: { version: "0.1.28-alpha.2", source: null, recordedAt: 1 },
    });
    expect(f.launch("0.1.28-alpha.2")).toBe("unchanged");
    expect(f.releaseNotes()).toEqual([]);
    expect(f.launch("0.1.28-alpha.10")).toBe("delivered");
    // Every change the release carries, features first, newer first within a kind.
    expect(listed(f.top()?.body ?? "")).toEqual([
      "Change change-d",
      "Change change-a",
      "Change change-b",
      "Change change-c",
      "Change change-e",
      "Change change-f",
    ]);
    expect(f.tracking()).toMatchObject({
      baseline: { version: "0.1.28-alpha.10" },
      previous: { version: "0.1.28-alpha.2" },
      deliveries: { "0.1.28-alpha.10": { boundary: { version: "0.1.28-alpha.2" } } },
    });
    expect(f.launch("0.1.28-alpha.10")).toBe("unchanged");
    expect(f.releaseNotes()).toHaveLength(1);
  });

  it("measures a seeded profile's later upgrade normally once it has a recorded step", () => {
    const f = setup("legacy");
    f.catalog(() => ({ kind: "unavailable" }));
    expect(f.launch("0.1.27")).toBe("seeded");
    f.catalog((version) => ({
      kind: "ok",
      catalog: catalogFor(version),
      picturesDir: f.picturesDir,
    }));
    expect(f.launch("0.1.26")).toBe("downgraded");
    expect(f.launch("0.1.27")).toBe("delivered");
    expect(listed(f.top()?.body ?? "")).toEqual(["Change change-d", "Change change-c"]);
  });

  it("invents no history from a corrupt baseline or an unreadable running version", () => {
    const f = setup("fresh");
    f.settings.setReleaseTracking({
      ...f.tracking(),
      baseline: { version: "not a version", source: null, recordedAt: 1 },
    });
    expect(f.launch("0.1.27")).toBe("seeded");
    expect(f.releaseNotes()).toEqual([]);
    const before = f.tracking();
    expect(f.launch("dev-build")).toBe("unreadable");
    expect(f.tracking()).toEqual(before);
  });
});

describe("a first installation", () => {
  it("waits for setup and the welcome, writing nothing, then records its version quietly with no note", () => {
    const f = setup("fresh");
    f.settings.setFirstRun({ ...f.settings.getFirstRun(), welcomeState: "pending" });
    const service = f.service("0.1.27");
    expect(service.reconcile()).toBe("waiting");
    expect(service.awaitingWelcome).toBe(true);
    expect(f.tracking()).toMatchObject({ profile: "fresh", baseline: null });

    const welcome = f
      .cards()
      .addRecordedFirstmateNote({ title: "Welcome aboard", body: "<p>Hi.</p>" }, () => {});
    f.settings.setFirstRun({
      ...f.settings.getFirstRun(),
      welcomeState: "consumed",
      welcomeCardId: welcome,
    });
    expect(service.reconcile()).toBe("waiting");
    expect(f.releaseNotes()).toEqual([]);

    const shown = f.cards().get(welcome);
    if (shown) f.cards().dismiss(shown);
    // The welcome was the only card: this version is the baseline, and no note follows it.
    expect(service.reconcile()).toBe("seeded");
    expect(service.awaitingWelcome).toBe(false);
    expect(f.releaseNotes()).toEqual([]);
    expect(f.tracking()).toMatchObject({
      profile: "fresh",
      baseline: { version: "0.1.27" },
      deliveries: {},
    });
    expect(f.launch("0.1.27")).toBe("unchanged");
    expect(f.releaseNotes()).toEqual([]);
    // The next upgrade's note measures from it: only what came after 0.1.27.
    expect(f.launch("0.1.28-alpha.10")).toBe("delivered");
    expect(f.tracking().deliveries["0.1.28-alpha.10"]?.boundary.version).toBe("0.1.27");
  });

  it("follows a skipped welcome at once, recording quietly whether or not the build carries notes", () => {
    const skipped = setup("fresh");
    expect(skipped.launch("0.1.27")).toBe("seeded");
    expect(skipped.releaseNotes()).toEqual([]);

    const bare = setup("fresh");
    bare.catalog(() => ({ kind: "unavailable" }));
    expect(bare.launch("0.1.27")).toBe("seeded");
    expect(bare.releaseNotes()).toEqual([]);
  });
});

describe("notes that cannot be verified", () => {
  it("give one honest note that keeps the range, and a later upgrade recovers it under that range", () => {
    const f = setup();
    f.seed("0.1.25");
    f.catalog(() => ({ kind: "unavailable" }));
    expect(f.launch("0.1.26")).toBe("delivered");
    expect(f.top()?.title).toBe("Your app is updated");
    expect(f.tracking()).toMatchObject({
      deliveries: { "0.1.26": { coverage: "unavailable", entryIds: [] } },
      unresolved: [{ from: "0.1.25", to: "0.1.26" }],
    });
    expect(f.launch("0.1.26")).toBe("unchanged");

    f.catalog((version) => ({
      kind: "ok",
      catalog: catalogFor(version),
      picturesDir: f.picturesDir,
    }));
    expect(f.launch("0.1.27")).toBe("delivered");
    const body = f.top()?.body ?? "";
    expect(listed(body)).toEqual(["Change change-d", "Change change-c", "Change change-b"]);
    expect(body).toContain("Earlier, now verified: stable 0.1.25 to stable 0.1.26");
    expect(f.tracking().unresolved).toEqual([]);
  });
});

describe("hero pictures", () => {
  // change-d is the lead highlight of 0.1.27; change-c the second.
  const PAIR = {
    dark: "change-d-dark.webp",
    light: "change-d-light.webp",
    alt: "The view change d brings",
  };
  const pictured = ENTRIES.map((entry) =>
    entry.id === "change-d" ? { ...entry, area: "cards" as const, picture: PAIR } : entry,
  );
  const withPictures = (picturesDir: string) => (version: string) => ({
    kind: "ok" as const,
    catalog: {
      ...catalogFor(version, RELEASES, pictured),
      pictures: {
        [PAIR.dark]: { sha256: "0".repeat(64), width: 1200, height: 600 },
        [PAIR.light]: { sha256: "1".repeat(64), width: 1200, height: 600 },
      },
    },
    picturesDir,
  });

  it("draws the lead highlight's pair, each marked with its theme, from copies kept outside the build", () => {
    const f = setup();
    f.seed("0.1.25");
    writeFileSync(join(f.picturesDir, PAIR.dark), webpBytes(1200, 600, 64));
    writeFileSync(join(f.picturesDir, PAIR.light), webpBytes(1200, 600, 96));
    f.catalog(withPictures(f.picturesDir));

    expect(f.launch("0.1.27")).toBe("delivered");

    const note = f.top();
    const body = note?.body ?? "";
    const images = [...body.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
    expect(images).toHaveLength(2);
    expect(images[0]).toContain('data-inf-theme="dark"');
    expect(images[1]).toContain('data-inf-theme="light"');
    for (const image of images) {
      expect(image).toMatch(/src="app-frame:\/\/images\/release-notes-[0-9a-f]{32}\.webp"/);
      expect(image).toContain(`alt="${PAIR.alt}"`);
      expect(image).toContain('width="1200" height="600"');
    }
    // The pictures follow the lead's words, under its area-named label.
    expect(body.indexOf("01 / Added · Cards")).toBeLessThan(body.indexOf(images[0] ?? "<img"));
    expect(note?.pictures).toEqual([
      expect.objectContaining({ alt: PAIR.alt, width: 1200, height: 600, group: 0 }),
      expect.objectContaining({ alt: PAIR.alt, width: 1200, height: 600, group: 1 }),
    ]);
    // The copies are the host's own, so they outlive this build's files.
    expect(readdirSync(f.keptDir).sort()).toEqual(
      (note?.pictures ?? []).map((picture) => `${picture.id}.webp`).sort(),
    );
  });

  it("reads a highlight as text when its picture is not on disk, and delivers the note all the same", () => {
    const f = setup();
    f.seed("0.1.25");
    writeFileSync(join(f.picturesDir, PAIR.dark), webpBytes(1200, 600));
    f.catalog(withPictures(f.picturesDir));

    expect(f.launch("0.1.27")).toBe("delivered");

    expect(f.top()?.body).not.toContain("<img");
    expect(f.top()?.body).toContain("01 / Added · Cards");
    expect(f.top()?.pictures).toBeUndefined();
    expect(existsSync(f.keptDir) ? readdirSync(f.keptDir) : []).toEqual([]);
  });
});

describe("the bundled catalog", () => {
  const write = (value: unknown) => {
    const dir = scratchDir("infinitary-release-notes-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "release-notes.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
    return dir;
  };

  it("is read only when it is a consistent catalog for exactly the running version", () => {
    const dir = write(catalogFor("0.1.27"));
    expect(loadCatalog(dir, "0.1.27").kind).toBe("ok");
    expect(loadCatalog(dir, "0.1.28-alpha.10").kind).toBe("unavailable");
    expect(loadCatalog(scratchDir("infinitary-release-notes-none-"), "0.1.27").kind).toBe(
      "unavailable",
    );
    expect(
      loadCatalog(
        write({ schema: 1, unavailable: "A development build carries no release catalog." }),
        "0.1.27",
      ).kind,
    ).toBe("unavailable");
    expect(loadCatalog(write("{ not json"), "0.1.27").kind).toBe("unavailable");
    const torn = catalogFor("0.1.27");
    expect(loadCatalog(write({ ...torn, entries: torn.entries.slice(1) }), "0.1.27").kind).toBe(
      "unavailable",
    );
  });
});
