import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { bundledSource, recordLaunch } from "./releaseTracking";
import { openInMemoryDatabase } from "./storage/db";
import { SettingsStore } from "./storage/settingsStore";

const SOURCE = "a".repeat(40);

function fixture(throughVersion?: number) {
  const db = openInMemoryDatabase(throughVersion);
  const settings = new SettingsStore(db);
  let clock = 1000;
  const launch = (version: string, source: string | null = null) =>
    recordLaunch(settings, { version, source }, () => (clock += 1));
  return { db, settings, launch };
}

describe("version tracking", () => {
  it("seeds the first known baseline silently, without a previous version", () => {
    const f = fixture();
    expect(f.launch("0.1.28-alpha.3", SOURCE)).toEqual({ outcome: "seeded", previous: null });
    expect(f.settings.getReleaseTracking()).toMatchObject({
      baseline: { version: "0.1.28-alpha.3", source: SOURCE },
      previous: null,
      deliveries: {},
      unresolved: [],
    });
  });

  it("records an upgrade with the previous identity read before the new one is written", () => {
    const f = fixture();
    f.launch("0.1.27");
    const result = f.launch("0.1.28-alpha.10", SOURCE);
    expect(result.outcome).toBe("upgraded");
    expect(result.previous).toMatchObject({ version: "0.1.27", source: null });
    expect(f.settings.getReleaseTracking()).toMatchObject({
      baseline: { version: "0.1.28-alpha.10", source: SOURCE },
      previous: { version: "0.1.27" },
    });
  });

  it("orders alpha numbers numerically and a stable above its own alphas", () => {
    const f = fixture();
    f.launch("0.1.28-alpha.2");
    expect(f.launch("0.1.28-alpha.10").outcome).toBe("upgraded");
    expect(f.launch("0.1.28").outcome).toBe("upgraded");
    expect(f.launch("0.1.28-alpha.10").outcome).toBe("downgraded");
  });

  it("writes nothing for a restart or reinstall of the same version", () => {
    const f = fixture();
    f.launch("0.1.27", SOURCE);
    const before = f.settings.getReleaseTracking();
    expect(f.launch("0.1.27", SOURCE).outcome).toBe("unchanged");
    expect(f.launch("0.1.27", null).outcome).toBe("unchanged");
    expect(f.settings.getReleaseTracking()).toEqual(before);
  });

  it("records a downgrade as the lower baseline, which a later upgrade compares against", () => {
    const f = fixture();
    f.launch("0.1.28");
    expect(f.launch("0.1.26").outcome).toBe("downgraded");
    expect(f.settings.getReleaseTracking().baseline?.version).toBe("0.1.26");
    const result = f.launch("0.1.27");
    expect(result).toMatchObject({ outcome: "upgraded", previous: { version: "0.1.26" } });
  });

  it("never records or invents anything from an unreadable running version", () => {
    const f = fixture();
    f.launch("0.1.27");
    const before = f.settings.getReleaseTracking();
    for (const version of ["", "dev", "v0.1.28", "0.1"]) {
      expect(f.launch(version)).toEqual({ outcome: "unreadable", previous: null });
    }
    expect(f.settings.getReleaseTracking()).toEqual(before);
  });

  it("treats a corrupt saved row as an unknown baseline, not a previous version", () => {
    const f = fixture();
    f.db.prepare("UPDATE settings SET value = ? WHERE key = 'release-tracking'").run("{not json");
    expect(f.settings.getReleaseTracking()).toMatchObject({ baseline: null, previous: null });
    expect(f.launch("0.1.28")).toEqual({ outcome: "seeded", previous: null });
    f.db
      .prepare(
        "UPDATE settings SET value = json_set(value, '$.baseline.version', 'garbage') WHERE key = 'release-tracking'",
      )
      .run();
    expect(f.launch("0.1.29")).toEqual({ outcome: "seeded", previous: null });
  });
});

describe("the profile classification", () => {
  it("is fresh for a new profile, and legacy where no migration recorded one", () => {
    expect(fixture().settings.getReleaseTracking().profile).toBe("fresh");
    // Before the migration there is no row: never a fresh classification by default.
    expect(fixture(60).settings.getReleaseTracking()).toMatchObject({
      profile: "legacy",
      baseline: null,
    });
  });

  it("stays fresh while setup is pending and leaves the welcome's eligibility alone", () => {
    const f = fixture();
    const welcome = f.settings.getFirstRun();
    expect(welcome.welcomeState).toBe("uninitialized");
    f.launch("0.1.27");
    f.launch("0.1.28");
    expect(f.settings.getReleaseTracking().profile).toBe("fresh");
    expect(f.settings.getFirstRun()).toEqual(welcome);
  });
});

describe("the bundled source", () => {
  function resources(catalog: unknown): string {
    const dir = scratchDir("infinitary-bundled-notes-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "release-notes.json"), JSON.stringify(catalog));
    return dir;
  }

  it("reads the source commit only from a catalog for the running version", () => {
    const dir = resources({ release: { version: "0.1.28-alpha.3", sourceCommit: SOURCE } });
    expect(bundledSource(dir, "0.1.28-alpha.3")).toBe(SOURCE);
    expect(bundledSource(dir, "0.1.28-alpha.4")).toBeNull();
  });

  it("is null when the build carries no readable catalog", () => {
    expect(bundledSource(scratchDir("infinitary-bundled-none-"), "0.1.28")).toBeNull();
    expect(bundledSource(resources("not an object"), "0.1.28")).toBeNull();
  });
});
