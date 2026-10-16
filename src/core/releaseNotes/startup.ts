import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardPicture } from "@shared/cards";
import type { FirstRunRecord } from "@shared/firstRun";
import type { ReleaseIdentity, ReleaseTrackingRecord } from "@shared/releaseTracking";
import { type LaunchOutcome, recordLaunch, type TrackingStore } from "../releaseTracking";
import { compareSemver, parseSemver } from "../update/semver";
import {
  type HeroPicture,
  highlights,
  type NoteText,
  renderNote,
  type ShownPicture,
} from "./briefing";
import { type Catalog, PACKAGED_PICTURES_DIR, verifyCatalog } from "./catalog";
import { listedEntries, type Selection, selectEntries } from "./select";

/**
 * The startup release note (docs/release-notes.md "The startup note"). After
 * saved-data compatibility, migrations, restored cards and first-run
 * eligibility, and before the window's first card snapshot: one ordinary
 * Firstmate note per forward upgrade, placed on top of the stack and
 * committed with its baseline and delivery stamp in one transaction. The
 * captain's FI3-608 choices, as revised on FI3-706 and FI3-1164: a legacy
 * profile with no recorded history gets every recorded change once; a first
 * installation gets no note, and records its version quietly once setup and
 * the welcome are finished or skipped. Nothing here reads the network or
 * calls a model.
 */

export type CatalogLoad =
  | {
      kind: "ok";
      catalog: Catalog;
      /** Where the catalog's hero pictures sit, beside it. */
      picturesDir: string;
    }
  | { kind: "unavailable" };

/**
 * The catalog in `resourcesDir`, for exactly the running version. Missing,
 * unreadable, placeholder or inconsistent data is unavailable.
 */
export function loadCatalog(resourcesDir: string, version: string): CatalogLoad {
  try {
    const value = JSON.parse(readFileSync(join(resourcesDir, "release-notes.json"), "utf8")) as {
      release?: { sourceCommit?: unknown };
    };
    const sourceCommit = value.release?.sourceCommit;
    if (typeof sourceCommit !== "string") return { kind: "unavailable" };
    if (verifyCatalog(value, { version, sourceCommit }).length > 0) return { kind: "unavailable" };
    return {
      kind: "ok",
      catalog: value as unknown as Catalog,
      picturesDir: join(resourcesDir, PACKAGED_PICTURES_DIR),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export type ReleaseNotesOutcome =
  | LaunchOutcome
  | "delivered"
  /** A first installation's quiet record waits on setup and the welcome. */
  | "waiting"
  | "failed";

export type ReleaseNotesDeps = {
  settings: TrackingStore & { getFirstRun(): FirstRunRecord };
  /** Whether this card is still on the stack. */
  isOpen: (cardId: string) => boolean;
  catalog: () => CatalogLoad;
  /**
   * `CardService.addRecordedFirstmateNote`, on top of the stack: commits the
   * note, its answer and whatever `record` writes together, then publishes.
   */
  createNote: (
    note: NoteText & { pictures?: CardPicture[] },
    record: (cardId: string) => void,
  ) => void;
  /**
   * Copies one hero picture where card pictures are kept, through the card
   * picture checks, so the note still shows it after the next upgrade
   * replaces this build's files; undefined when the file is missing or
   * refused.
   */
  keepPicture: (file: string) => (ShownPicture & { id: string }) | undefined;
  now: () => number;
};

/**
 * A profile that came from a version with no tracking and has recorded no
 * step since: no previous version and no delivery. 0.1.28-alpha.23 seeded
 * such profiles' baseline silently; an upgrade, a downgrade or a delivery
 * each fills one of these fields, and a fresh profile is never one.
 */
function unrecorded(tracking: ReleaseTrackingRecord): boolean {
  return (
    tracking.profile === "legacy" &&
    tracking.previous === null &&
    Object.keys(tracking.deliveries).length === 0
  );
}

export class ReleaseNotesService {
  private waiting = false;
  private running = false;

  constructor(
    private readonly deps: ReleaseNotesDeps,
    private readonly identity: { version: string; source: string | null },
  ) {}

  /** A first installation's record is waiting, so setup and card changes are worth a look. */
  get awaitingWelcome(): boolean {
    return this.waiting;
  }

  /** Never throws: a failed commit rolls back whole, and the next launch retries. */
  reconcile(): ReleaseNotesOutcome {
    if (this.running) return "waiting";
    this.running = true;
    try {
      return this.decide();
    } catch (error) {
      console.warn("[release-notes] this launch could not be reconciled:", error);
      return "failed";
    } finally {
      this.running = false;
    }
  }

  private record(): ReleaseNotesOutcome {
    this.waiting = false;
    return recordLaunch(this.deps.settings, this.identity, this.deps.now).outcome;
  }

  private decide(): ReleaseNotesOutcome {
    const { version } = this.identity;
    if (!parseSemver(version)) return this.record();
    const tracking = this.deps.settings.getReleaseTracking();
    const baseline = tracking.baseline;
    const known = baseline && parseSemver(baseline.version) ? baseline : null;
    if (known?.version === version) {
      this.waiting = false;
      return "unchanged";
    }
    // No known version: a first installation records it quietly after its
    // welcome; a legacy profile with no recorded history gets every
    // recorded change; anything else (a fresh profile's corrupt baseline)
    // invents no history.
    if (!known) {
      if (baseline === null && tracking.profile === "fresh") return this.firstInstallation();
      return unrecorded(tracking) ? this.history(tracking, null) : this.record();
    }
    // A downgrade records the lower version with no note; a version already
    // delivered is never delivered again, open or closed.
    if ((compareSemver(version, known.version) ?? 0) < 0 || tracking.deliveries[version])
      return this.record();
    // A baseline seeded silently from a version with no record.
    if (unrecorded(tracking)) return this.history(tracking, known);
    return this.upgrade(tracking, known, this.deps.catalog());
  }

  private upgrade(
    tracking: ReleaseTrackingRecord,
    known: ReleaseIdentity,
    load: CatalogLoad,
  ): ReleaseNotesOutcome {
    const { version } = this.identity;
    this.waiting = false;
    const selection = selectEntries({
      catalog: load.kind === "ok" ? load.catalog : null,
      from: known.version,
      to: version,
      delivered: new Set(Object.values(tracking.deliveries).flatMap((d) => d.entryIds)),
      unresolved: tracking.unresolved,
      mode: "upgrade",
    });
    return this.deliver(tracking, known, selection, "upgrade", load);
  }

  /**
   * Every change the catalog records, once, for an earlier version that kept
   * no record of what it had seen. With no readable notes it falls back to
   * the ordinary path: an honest note after a known baseline, otherwise a
   * silent record that keeps the profile unrecorded for the next upgrade.
   */
  private history(
    tracking: ReleaseTrackingRecord,
    known: ReleaseIdentity | null,
  ): ReleaseNotesOutcome {
    const load = this.deps.catalog();
    const selection =
      load.kind === "ok"
        ? selectEntries({
            catalog: load.catalog,
            from: null,
            to: this.identity.version,
            delivered: new Set(),
            unresolved: tracking.unresolved,
            mode: "history",
          })
        : null;
    if (!selection || selection.coverage === "unavailable" || listedEntries(selection).length === 0)
      return known ? this.upgrade(tracking, known, load) : this.record();
    this.waiting = false;
    return this.deliver(tracking, known, selection, "history", load);
  }

  /**
   * A clean new installation shows no note (FI3-1164, the captain's call
   * for a clean first launch): the welcome is its only card. Once the
   * welcome is settled, this version is recorded quietly as the baseline the
   * next upgrade's note measures from; until then nothing is written, so a
   * restart still finds a fresh profile.
   */
  private firstInstallation(): ReleaseNotesOutcome {
    const { welcomeState, welcomeCardId } = this.deps.settings.getFirstRun();
    const settled =
      welcomeState === undefined ||
      welcomeState === "skipped" ||
      (welcomeState === "consumed" &&
        (welcomeCardId === undefined || !this.deps.isOpen(welcomeCardId)));
    if (!settled) {
      this.waiting = true;
      return "waiting";
    }
    return this.record();
  }

  /**
   * The highlights' hero pairs this build carries, copied where card pictures
   * are kept. A highlight whose pair is not both in the catalog and on disk
   * reads as text only.
   */
  private heroPictures(
    selection: Selection,
    load: CatalogLoad,
  ): { shown: Map<string, HeroPicture>; pictures: CardPicture[] } {
    const shown = new Map<string, HeroPicture>();
    const pictures: CardPicture[] = [];
    if (load.kind !== "ok") return { shown, pictures };
    const shipped = load.catalog.pictures ?? {};
    for (const entry of highlights(listedEntries(selection))) {
      const pair = entry.picture;
      if (!pair || !(pair.dark in shipped) || !(pair.light in shipped)) continue;
      const files = [pair.dark, pair.light].map((file) => join(load.picturesDir, file));
      // Half a pair keeps nothing: the highlight reads as text.
      if (!files.every((file) => existsSync(file))) continue;
      const dark = this.deps.keepPicture(files[0] as string);
      const light = dark && this.deps.keepPicture(files[1] as string);
      if (!dark || !light) continue;
      shown.set(entry.id, { alt: pair.alt, dark, light });
      // Each picture stands alone in the body, so each is a group of its own.
      for (const { id, width, height } of [dark, light])
        pictures.push({ id, alt: pair.alt, width, height, group: pictures.length });
    }
    return { shown, pictures };
  }

  private deliver(
    tracking: ReleaseTrackingRecord,
    known: ReleaseIdentity | null,
    selection: Selection,
    mode: "upgrade" | "history",
    load: CatalogLoad,
  ): ReleaseNotesOutcome {
    const { version, source } = this.identity;
    const { shown, pictures } = this.heroPictures(selection, load);
    const note = renderNote({
      mode,
      from: mode === "upgrade" ? (known?.version ?? null) : null,
      to: version,
      selection,
      pictures: shown,
    });
    const now = this.deps.now();
    this.deps.createNote({ ...note, ...(pictures.length > 0 ? { pictures } : {}) }, (cardId) => {
      this.deps.settings.setReleaseTracking({
        ...tracking,
        baseline: { version, source, recordedAt: now },
        previous: known,
        deliveries: {
          ...tracking.deliveries,
          [version]: {
            boundary: { version: known?.version ?? null, source: known?.source ?? null },
            entryIds: listedEntries(selection).map((entry) => entry.id),
            coverage: selection.coverage,
            cardId,
            deliveredAt: now,
          },
        },
        unresolved: selection.unresolved,
      });
    });
    return "delivered";
  }
}
