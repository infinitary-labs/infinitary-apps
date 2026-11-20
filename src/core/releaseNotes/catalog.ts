import {
  compareSemver,
  isAlphaVersion,
  isStableVersion,
  parseSemver,
} from "../../shared/semver.ts";
import { readPicture } from "../pictureFormat.ts";

/**
 * The reviewed release-notes ledger and the offline catalog built from it
 * (docs/release-notes.md). Pure and dependency-free: the release scripts load
 * it with Node's type stripping, so imports carry explicit `.ts` specifiers
 * and nothing here reads a file or runs git. The git facts it needs (which
 * commits a release contains, which commit added a note file) arrive as
 * arguments.
 *
 * The ledger declares; it never judges. A deterministic check can say a
 * source change has a note or a reviewed exclusion, never whether the prose
 * is true or well written - that is the release crewmate's review.
 */

export const ENTRY_KINDS = ["feature", "improvement", "fix", "removal", "maintenance"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const PROVENANCE_ORIGINS = ["change", "changelog-backfill", "release-review"] as const;
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];

/**
 * The feature areas the full list groups by, in the order a person meets
 * them (the captain's FI3-745 plan). Closed: an entry declares its area and
 * nothing infers one from its words. `other` also holds every entry that
 * declares none, which is backfilled history.
 */
export const NOTE_AREAS = [
  { id: "firstmate", label: "First mate" },
  { id: "message-box", label: "Message box" },
  { id: "cards", label: "Cards" },
  { id: "tasks", label: "Tasks" },
  { id: "crewmates", label: "Crewmates" },
  { id: "projects", label: "Projects" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "settings", label: "Settings and appearance" },
  { id: "devices", label: "Your devices" },
  { id: "updates", label: "Updates" },
  { id: "other", label: "Other changes" },
] as const;
export type NoteArea = (typeof NOTE_AREAS)[number]["id"];
const AREA_IDS: readonly string[] = NOTE_AREAS.map((area) => area.id);

/**
 * The kinds a person can see, which keep a hero picture or say why there is
 * none when a change or a release review writes them. Maintenance and
 * backfilled history are exempt.
 */
export const PICTURED_KINDS: readonly EntryKind[] = ["feature", "improvement", "fix", "removal"];

/**
 * A note is for a change a person notices; internal work takes an exclusion
 * with a reason (the captain's FI3-783 rule, docs/release-notes.md "What a
 * note may say"). So a change or a release review writes no `maintenance`
 * entry. The one listed here was written and shipped before the rule.
 */
const MAINTENANCE_BEFORE_THE_RULE: readonly string[] = ["pi-1-0"];

/** Where an entry's hero pictures live in the repository, beside the notes. */
export const PICTURES_DIR = "release-notes/pictures";
/** Where a packaged catalog's hero files sit, relative to the folder that holds the catalog. */
export const PACKAGED_PICTURES_DIR = "release-notes/pictures";
/** Each hero file's caps: the lead slot is about 720 px wide, so 1600 px is room to spare. */
export const MAX_HERO_WIDTH = 1600;
export const MAX_HERO_BYTES = 300 * 1024;

/** The most highlights a note shows, and the slots a stable's picks fill. */
export const MAX_HIGHLIGHTS = 3;

/**
 * An entry's hero pictures: the same crop in each theme, as
 * `<entry id>-dark.webp` and `<entry id>-light.webp` (PNG accepted) under
 * `PICTURES_DIR`, and what they show.
 */
export type NotePicture = { dark: string; light: string; alt: string };

export type NoteEntry = {
  /** Stable for the life of the change: an alpha and its promoted stable share it. */
  id: string;
  kind: EntryKind;
  title: string;
  body?: string;
  /** 1 is the lead highlight; absent for an ordinary entry. */
  highlight?: number;
  /** The feature area the full list files it under; absent only on backfilled history. */
  area?: NoteArea;
  /** Its hero pictures, committed beside the note. */
  picture?: NotePicture;
  /** Why it keeps no picture, in one sentence, instead of `picture`. */
  noPicture?: string;
  provenance: {
    origin: ProvenanceOrigin;
    /** Source commits this entry covers beyond the commit that added its file. */
    covers?: string[];
  };
};

/** A reviewed statement that a source change needs no product note. */
export type NoteExclusion = {
  id: string;
  reason: string;
  covers?: string[];
};

export type NoteFile = { entries: NoteEntry[]; exclusions: NoteExclusion[] };

export type ReleaseManifest = {
  /** The exact logical version, as `host.app.version` reports it. */
  version: string;
  channel: "stable" | "alpha";
  sourceCommit: string;
  /** The source commit's committer date, `YYYY-MM-DD`. */
  date: string;
  /** The alpha a stable was promoted from. */
  promotedFrom: string | null;
  /**
   * A stable's highlights as the captain picked them for its promotion, lead
   * first: the only ranks its catalog carried. Absent on an alpha, and on a
   * stable published before the picks.
   */
  highlights?: string[];
  /** Cumulative: every entry in this release's source, sorted. */
  entryIds: string[];
  /** Present when the release's earliest history cannot be recovered. */
  incomplete?: string;
};

/**
 * The record of past releases (docs/release-notes.md "A fresh history"): the
 * releases published from a history this repository may no longer carry,
 * each one's manifest pinned by the SHA-256 of its file, and the newest
 * version each channel published, which every later version numbers above.
 * It is written from the full history (`release-notes.ts archive --write`);
 * a checkout without that history trusts each listed manifest by its hash
 * rather than re-deriving it from commits it cannot read.
 */
export type ReleaseArchive = {
  schema: 1;
  /** Where the archived history lives, as `owner/name` on GitHub. */
  repository: string;
  /** Earlier repository histories included in the same pin set, oldest first. */
  previousRepositories?: string[];
  /** The newest stable the archived history published. */
  stable: string;
  /** The newest alpha the archived history published. */
  alpha: string;
  /** Every archived release: its version to the SHA-256 of `releases/<version>.json`. */
  releases: Record<string, string>;
};

/** Where the record of past releases lives. */
export const ARCHIVE_FILE = "release-notes/archive.json";

/** One hero file the packaged app carries beside its catalog. */
export type CatalogPicture = { sha256: string; width: number; height: number };

export type Catalog = {
  schema: 1;
  release: { version: string; sourceCommit: string };
  /** Only the entries inside the packaged release. */
  entries: NoteEntry[];
  releases: ReleaseManifest[];
  /**
   * The highlighted entries' hero files, by file name, shipped in
   * `release-notes/pictures/` beside the catalog. Absent in a catalog
   * built before hero pictures.
   */
  pictures?: Record<string, CatalogPicture>;
};

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(value: Json, allowed: readonly string[], where: string, problems: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown field "${key}"`);
  }
}

function text(value: unknown, where: string, max: number, problems: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    problems.push(`${where}: expected non-empty text of at most ${max} characters`);
    return null;
  }
  return value;
}

function shaList(value: unknown, where: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !SHA.test(item))) {
    problems.push(`${where}: expected full 40-character lowercase commit ids`);
    return undefined;
  }
  return value as string[];
}

function parseEntry(value: unknown, where: string, problems: string[]): NoteEntry | null {
  if (!isRecord(value)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  closed(
    value,
    ["id", "kind", "title", "body", "highlight", "area", "picture", "noPicture", "provenance"],
    where,
    problems,
  );
  const before = problems.length;
  const id = text(value.id, `${where}.id`, 80, problems);
  if (id !== null && !ID.test(id))
    problems.push(`${where}.id: use lowercase letters, digits and hyphens`);
  if (!ENTRY_KINDS.includes(value.kind as EntryKind))
    problems.push(`${where}.kind: expected one of ${ENTRY_KINDS.join(", ")}`);
  const title = text(value.title, `${where}.title`, 200, problems);
  const body =
    value.body === undefined ? undefined : (text(value.body, `${where}.body`, 600, problems) ?? "");
  if (
    value.highlight !== undefined &&
    (!Number.isInteger(value.highlight) || (value.highlight as number) < 1)
  )
    problems.push(`${where}.highlight: expected a whole rank from 1`);
  if (value.area !== undefined && !AREA_IDS.includes(value.area as string))
    problems.push(`${where}.area: expected one of ${AREA_IDS.join(", ")}`);
  const picture =
    value.picture === undefined ? undefined : parsePicture(value.picture, id, where, problems);
  const noPicture =
    value.noPicture === undefined
      ? undefined
      : (text(value.noPicture, `${where}.noPicture`, 300, problems) ?? "");
  if (value.picture !== undefined && value.noPicture !== undefined)
    problems.push(`${where}: declare a picture or a noPicture reason, not both`);
  let provenance: NoteEntry["provenance"] | null = null;
  if (!isRecord(value.provenance)) problems.push(`${where}.provenance: expected an object`);
  else {
    closed(value.provenance, ["origin", "covers"], `${where}.provenance`, problems);
    if (!PROVENANCE_ORIGINS.includes(value.provenance.origin as ProvenanceOrigin))
      problems.push(`${where}.provenance.origin: expected one of ${PROVENANCE_ORIGINS.join(", ")}`);
    const covers = shaList(value.provenance.covers, `${where}.provenance.covers`, problems);
    provenance = {
      origin: value.provenance.origin as ProvenanceOrigin,
      ...(covers ? { covers } : {}),
    };
  }
  if (problems.length > before || id === null || title === null || provenance === null) return null;
  return {
    id,
    kind: value.kind as EntryKind,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(value.highlight !== undefined ? { highlight: value.highlight as number } : {}),
    ...(value.area !== undefined ? { area: value.area as NoteArea } : {}),
    ...(picture ? { picture } : {}),
    ...(noPicture !== undefined ? { noPicture } : {}),
    provenance,
  };
}

/** `{ dark, light, alt }`, each file named for its entry and theme. */
function parsePicture(
  value: unknown,
  id: string | null,
  where: string,
  problems: string[],
): NotePicture | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}.picture: expected { dark, light, alt }`);
    return undefined;
  }
  closed(value, ["dark", "light", "alt"], `${where}.picture`, problems);
  const before = problems.length;
  for (const theme of ["dark", "light"] as const) {
    const file = value[theme];
    const expected = `${id ?? "<id>"}-${theme}.webp`;
    if (typeof file !== "string" || (id !== null && !heroFileNames(id, theme).includes(file)))
      problems.push(
        `${where}.picture.${theme}: expected "${expected}" (or .png) in ${PICTURES_DIR}`,
      );
  }
  const alt = text(value.alt, `${where}.picture.alt`, 300, problems);
  if (problems.length > before || alt === null) return undefined;
  return { dark: value.dark as string, light: value.light as string, alt };
}

/** The hero file names an entry may use for one theme. */
function heroFileNames(id: string, theme: "dark" | "light"): string[] {
  return [`${id}-${theme}.webp`, `${id}-${theme}.png`];
}

function parseExclusion(value: unknown, where: string, problems: string[]): NoteExclusion | null {
  if (!isRecord(value)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  closed(value, ["id", "reason", "covers"], where, problems);
  const before = problems.length;
  const id = text(value.id, `${where}.id`, 80, problems);
  if (id !== null && !ID.test(id))
    problems.push(`${where}.id: use lowercase letters, digits and hyphens`);
  const reason = text(value.reason, `${where}.reason`, 400, problems);
  const covers = shaList(value.covers, `${where}.covers`, problems);
  if (problems.length > before || id === null || reason === null) return null;
  return { id, reason, ...(covers ? { covers } : {}) };
}

/** A note file: `{ entries?, exclusions? }`, closed to unknown fields. */
export function parseNoteFile(
  value: unknown,
  where: string,
): { file: NoteFile; problems: string[] } {
  const problems: string[] = [];
  const file: NoteFile = { entries: [], exclusions: [] };
  if (!isRecord(value)) return { file, problems: [`${where}: expected an object`] };
  closed(value, ["entries", "exclusions"], where, problems);
  for (const key of ["entries", "exclusions"] as const) {
    const list = value[key] ?? [];
    if (!Array.isArray(list)) {
      problems.push(`${where}.${key}: expected a list`);
      continue;
    }
    list.forEach((item, index) => {
      const at = `${where}.${key}[${index}]`;
      if (key === "entries") {
        const entry = parseEntry(item, at, problems);
        if (entry) file.entries.push(entry);
      } else {
        const exclusion = parseExclusion(item, at, problems);
        if (exclusion) file.exclusions.push(exclusion);
      }
    });
  }
  return { file, problems };
}

export function parseManifest(
  value: unknown,
  where: string,
): { manifest: ReleaseManifest | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(value)) return { manifest: null, problems: [`${where}: expected an object`] };
  closed(
    value,
    [
      "version",
      "channel",
      "sourceCommit",
      "date",
      "promotedFrom",
      "highlights",
      "entryIds",
      "incomplete",
    ],
    where,
    problems,
  );
  const version = typeof value.version === "string" ? value.version : "";
  if (!parseSemver(version) || (!isStableVersion(version) && !isAlphaVersion(version)))
    problems.push(`${where}.version: expected a stable X.Y.Z or alpha X.Y.Z-alpha.N version`);
  else if (
    (value.channel === "alpha") !== isAlphaVersion(version) ||
    !["stable", "alpha"].includes(value.channel as string)
  )
    problems.push(`${where}.channel: does not match version ${version}`);
  if (typeof value.sourceCommit !== "string" || !SHA.test(value.sourceCommit))
    problems.push(`${where}.sourceCommit: expected a full lowercase commit id`);
  if (typeof value.date !== "string" || !DATE.test(value.date))
    problems.push(`${where}.date: expected YYYY-MM-DD`);
  if (value.promotedFrom !== null && typeof value.promotedFrom !== "string")
    problems.push(`${where}.promotedFrom: expected an alpha version or null`);
  const ids = value.entryIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    problems.push(`${where}.entryIds: expected a list of entry ids`);
  if (value.incomplete !== undefined && typeof value.incomplete !== "string")
    problems.push(`${where}.incomplete: expected text`);
  const picks = value.highlights;
  if (
    picks !== undefined &&
    (!Array.isArray(picks) ||
      picks.length === 0 ||
      picks.some((id) => typeof id !== "string" || !ID.test(id)))
  )
    problems.push(`${where}.highlights: expected the picked entry ids, lead first`);
  if (problems.length > 0) return { manifest: null, problems };
  return {
    manifest: {
      version,
      channel: value.channel as "stable" | "alpha",
      sourceCommit: value.sourceCommit as string,
      date: value.date as string,
      promotedFrom: value.promotedFrom as string | null,
      ...(picks !== undefined ? { highlights: [...(picks as string[])] } : {}),
      entryIds: [...(ids as string[])].sort(),
      ...(value.incomplete !== undefined ? { incomplete: value.incomplete as string } : {}),
    },
    problems,
  };
}

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The record of past releases, closed to unknown fields. */
export function parseArchive(
  value: unknown,
  where: string,
): { archive: ReleaseArchive | null; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(value)) return { archive: null, problems: [`${where}: expected an object`] };
  closed(
    value,
    ["schema", "repository", "previousRepositories", "stable", "alpha", "releases"],
    where,
    problems,
  );
  if (value.schema !== 1) problems.push(`${where}.schema: expected 1`);
  if (typeof value.repository !== "string" || !REPOSITORY.test(value.repository))
    problems.push(`${where}.repository: expected owner/name`);
  const previous = value.previousRepositories;
  if (
    previous !== undefined &&
    (!Array.isArray(previous) ||
      previous.length === 0 ||
      previous.some((name) => typeof name !== "string" || !REPOSITORY.test(name)) ||
      new Set([value.repository, ...previous].map((name) => String(name).toLowerCase())).size !==
        previous.length + 1)
  )
    problems.push(
      `${where}.previousRepositories: expected distinct earlier repositories as owner/name`,
    );
  if (typeof value.stable !== "string" || !isStableVersion(value.stable))
    problems.push(`${where}.stable: expected a stable X.Y.Z version`);
  if (typeof value.alpha !== "string" || !isAlphaVersion(value.alpha))
    problems.push(`${where}.alpha: expected an alpha X.Y.Z-alpha.N version`);
  const releases = value.releases;
  if (
    !isRecord(releases) ||
    Object.entries(releases).some(
      ([version, hash]) =>
        (!isStableVersion(version) && !isAlphaVersion(version)) ||
        typeof hash !== "string" ||
        !SHA256.test(hash),
    )
  )
    problems.push(`${where}.releases: expected each release's version to its manifest's SHA-256`);
  if (problems.length > 0) return { archive: null, problems };
  return {
    archive: {
      schema: 1,
      repository: value.repository as string,
      ...(Array.isArray(previous) ? { previousRepositories: previous as string[] } : {}),
      stable: value.stable as string,
      alpha: value.alpha as string,
      releases: { ...(releases as Record<string, string>) },
    },
    problems,
  };
}

/**
 * The record of past releases for these manifests: each one's hash, and the
 * newest version each channel published. `hashes` is each manifest file's
 * SHA-256 by version.
 */
export function archiveOf(
  repository: string,
  manifests: ReleaseManifest[],
  hashes: ReadonlyMap<string, string>,
): ReleaseArchive {
  const newest = (channel: "stable" | "alpha") =>
    manifests
      .filter((manifest) => manifest.channel === channel)
      .map((manifest) => manifest.version)
      .sort((a, b) => compareSemver(a, b) ?? 0)
      .at(-1) ?? "";
  const versions = manifests
    .map((manifest) => manifest.version)
    .sort((a, b) => compareSemver(a, b) ?? 0);
  return {
    schema: 1,
    repository,
    stable: newest("stable"),
    alpha: newest("alpha"),
    releases: Object.fromEntries(versions.map((version) => [version, hashes.get(version) ?? ""])),
  };
}

/**
 * Why the record of past releases does not match the manifests it pins,
 * with no git: every listed release has its manifest with exactly the
 * recorded bytes, and each channel's newest version is the newest listed.
 */
export function archiveProblems(
  archive: ReleaseArchive,
  manifests: ReleaseManifest[],
  hashes: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const byVersion = new Map(manifests.map((manifest) => [manifest.version, manifest]));
  const listed: ReleaseManifest[] = [];
  for (const [version, hash] of Object.entries(archive.releases)) {
    const manifest = byVersion.get(version);
    if (!manifest) {
      problems.push(`${ARCHIVE_FILE}: ${version} has no manifest in release-notes/releases/`);
      continue;
    }
    listed.push(manifest);
    if (hashes.get(version) !== hash)
      problems.push(
        `${ARCHIVE_FILE}: release-notes/releases/${version}.json is not the manifest it pins; a published release is immutable`,
      );
  }
  const pinned = archiveOf(archive.repository, listed, hashes);
  for (const channel of ["stable", "alpha"] as const)
    if (pinned[channel] !== archive[channel])
      problems.push(
        `${ARCHIVE_FILE}: ${channel} is ${archive[channel]}, but the newest ${channel} it lists is ${pinned[channel] || "none"}`,
      );
  return problems;
}

/** Every entry an archived release carries: what a release standing on that history carries too. */
export function archivedEntries(
  archive: ReleaseArchive,
  manifests: ReleaseManifest[],
): Set<string> {
  const ids = new Set<string>();
  for (const manifest of manifests)
    if (Object.hasOwn(archive.releases, manifest.version))
      for (const id of manifest.entryIds) ids.add(id);
  return ids;
}

/** A note file with the facts the repository adds around it. */
export type LedgerFile = {
  path: string;
  file: NoteFile;
  /** True for a file whose adding commit is itself the change it describes. */
  selfCovering: boolean;
};

export type Ledger = {
  files: LedgerFile[];
  manifests: { path: string; manifest: ReleaseManifest }[];
};

/** The static consistency of the ledger, with no git. Returns every problem. */
export function validateLedger(ledger: Ledger): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  const entryIds = new Set<string>();
  const entries: NoteEntry[] = [];
  const claim = (id: string, path: string) => {
    const owner = owners.get(id);
    if (owner !== undefined)
      problems.push(`duplicate id "${id}" in ${path} and ${owner}: one change keeps one id`);
    else owners.set(id, path);
  };
  for (const { path, file } of ledger.files) {
    for (const entry of file.entries) {
      claim(entry.id, path);
      entryIds.add(entry.id);
      entries.push(entry);
      problems.push(...declarationProblems(entry, path));
    }
    for (const exclusion of file.exclusions) claim(exclusion.id, path);
  }
  const byVersion = new Map<string, ReleaseManifest>();
  for (const { path, manifest } of ledger.manifests) {
    if (byVersion.has(manifest.version))
      problems.push(`${path}: release ${manifest.version} has two manifests`);
    byVersion.set(manifest.version, manifest);
    if (new Set(manifest.entryIds).size !== manifest.entryIds.length)
      problems.push(`${path}: lists an entry id twice`);
    for (const id of manifest.entryIds)
      if (!entryIds.has(id)) problems.push(`${path}: references missing entry "${id}"`);
  }
  for (const { path, manifest } of ledger.manifests) {
    if (manifest.promotedFrom === null) continue;
    const alpha = byVersion.get(manifest.promotedFrom);
    const left = parseSemver(manifest.version);
    const right = parseSemver(manifest.promotedFrom);
    if (
      manifest.channel !== "stable" ||
      !alpha ||
      alpha.channel !== "alpha" ||
      !left ||
      !right ||
      `${left.major}.${left.minor}.${left.patch}` !== `${right.major}.${right.minor}.${right.patch}`
    )
      problems.push(
        `${path}: promotion from ${manifest.promotedFrom} is not a published alpha of the same release`,
      );
    else if (alpha.entryIds.join("\n") !== manifest.entryIds.join("\n"))
      problems.push(
        `${path}: a stable keeps exactly the entries of the alpha it was promoted from`,
      );
  }
  const releases = ledger.manifests.map((item) => item.manifest);
  for (const { path, manifest } of ledger.manifests)
    for (const problem of recordedHighlightProblems(manifest, releases, entries))
      problems.push(`${path}: ${problem}`);
  return problems;
}

/**
 * What a change or a release review declares beyond its prose (FI3-745): an
 * area, and for a kind a person can see, a hero picture pair or one sentence
 * saying why there is none. It never declares maintenance (FI3-783). The
 * lead highlight always has a picture. Backfilled history declares neither.
 */
function declarationProblems(entry: NoteEntry, path: string): string[] {
  const problems: string[] = [];
  const at = `${path}: "${entry.id}"`;
  if (entry.provenance.origin !== "changelog-backfill") {
    if (entry.kind === "maintenance" && !MAINTENANCE_BEFORE_THE_RULE.includes(entry.id))
      problems.push(
        `${at} is maintenance: a note is for a change a person notices, so internal work takes an exclusion with a reason`,
      );
    if (entry.area === undefined)
      problems.push(`${at} declares no area (one of ${AREA_IDS.join(", ")})`);
    if (
      PICTURED_KINDS.includes(entry.kind) &&
      entry.picture === undefined &&
      entry.noPicture === undefined
    )
      problems.push(
        `${at} needs a hero picture pair in ${PICTURES_DIR} or a noPicture reason saying why there is nothing to see`,
      );
  }
  if (entry.highlight === 1 && entry.picture === undefined)
    problems.push(`${at} is the lead highlight and needs a hero picture pair`);
  return problems;
}

/**
 * Every hero file the ledger names, read through `read` (a file name under
 * `PICTURES_DIR` to its bytes, or null when it is missing): a WebP or PNG
 * whose header matches its name, at most `MAX_HERO_WIDTH` wide and
 * `MAX_HERO_BYTES` large, and never taller than it is wide. Whether it shows
 * the right thing is the release crewmate's review, never this check.
 */
export function pictureProblems(
  files: LedgerFile[],
  read: (file: string) => Buffer | null,
): string[] {
  const problems: string[] = [];
  for (const { path, file } of files) {
    for (const entry of file.entries) {
      if (!entry.picture) continue;
      for (const name of [entry.picture.dark, entry.picture.light]) {
        const at = `${path}: "${entry.id}" names ${PICTURES_DIR}/${name}`;
        const bytes = read(name);
        if (bytes === null) {
          problems.push(`${at}, which is missing`);
          continue;
        }
        const picture = readPicture(bytes);
        const wanted = name.endsWith(".png") ? "png" : "webp";
        if (!picture || picture.format.extension !== wanted) {
          problems.push(`${at}, which is not a valid ${wanted === "png" ? "PNG" : "WebP"}`);
          continue;
        }
        const { width, height } = picture.size;
        if (width > MAX_HERO_WIDTH)
          problems.push(`${at}, which is ${width} px wide (at most ${MAX_HERO_WIDTH})`);
        if (bytes.length > MAX_HERO_BYTES)
          problems.push(
            `${at}, which is ${Math.ceil(bytes.length / 1024)} KB (at most ${MAX_HERO_BYTES / 1024} KB)`,
          );
        if (height > width)
          problems.push(
            `${at}, which is ${width} by ${height}: crop it landscape, wider than it is tall`,
          );
      }
    }
  }
  return problems;
}

/** The hero files a catalog carries: every highlighted entry's pair. */
export function heroFiles(entries: NoteEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.highlight !== undefined && entry.picture ? [entry.picture.dark, entry.picture.light] : [],
  );
}

/**
 * The source commits each note speaks for: the ones it names, plus - for a
 * self-covering file - the commit that added the file, so a change's own pull
 * request needs no commit id it cannot yet know.
 */
export function declaredCommits(
  file: LedgerFile,
  addedBy: (path: string) => string | null,
): Map<string, string[]> {
  const added = file.selfCovering ? addedBy(file.path) : null;
  const claims = new Map<string, string[]>();
  for (const note of [...file.file.entries, ...file.file.exclusions]) {
    const covers = "provenance" in note ? (note.provenance.covers ?? []) : (note.covers ?? []);
    claims.set(note.id, [...covers, ...(added ? [added] : [])]);
  }
  return claims;
}

/** Every note must speak for at least one commit, or it can never be reached. */
export function unreachableNotes(
  files: LedgerFile[],
  addedBy: (path: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const [id, commits] of declaredCommits(file, addedBy))
      if (commits.length === 0)
        problems.push(`${file.path}: "${id}" covers no commit (name one in "covers")`);
  }
  return problems;
}

/** Entry id -> the commits it speaks for. */
export function entryCommits(
  files: LedgerFile[],
  addedBy: (path: string) => string | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    const claims = declaredCommits(file, addedBy);
    for (const entry of file.file.entries) out.set(entry.id, claims.get(entry.id) ?? []);
  }
  return out;
}

/** The commits a note or exclusion accounts for, across the whole ledger. */
export function coveredCommits(
  files: LedgerFile[],
  addedBy: (path: string) => string | null,
): Set<string> {
  const covered = new Set<string>();
  for (const file of files)
    for (const commits of declaredCommits(file, addedBy).values())
      for (const commit of commits) covered.add(commit);
  return covered;
}

export function uncoveredCommits<T extends { sha: string }>(range: T[], covered: Set<string>): T[] {
  return range.filter((commit) => !covered.has(commit.sha));
}

/** The cumulative entry ids inside one release's source. */
export function membership(
  commitsByEntry: Map<string, string[]>,
  ancestors: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const [id, commits] of commitsByEntry)
    if (commits.some((commit) => ancestors.has(commit))) ids.push(id);
  return ids.sort();
}

export type CatalogInput = {
  target: ReleaseManifest;
  entries: NoteEntry[];
  /** Published releases, from committed manifests or tags. */
  releases: ReleaseManifest[];
  /** The hero files read from the ledger, by name: every highlighted entry's pair must be here. */
  pictures?: Record<string, CatalogPicture>;
};

/** The catalog one packaged release carries; every refusal is a returned problem. */
export function buildCatalog(input: CatalogInput): { catalog: Catalog | null; problems: string[] } {
  const problems: string[] = [];
  const byVersion = new Map<string, ReleaseManifest>();
  for (const release of input.releases) byVersion.set(release.version, release);
  const existing = byVersion.get(input.target.version);
  if (existing && existing.sourceCommit !== input.target.sourceCommit)
    problems.push(
      `${input.target.version} is already published from ${existing.sourceCommit}, not ${input.target.sourceCommit}`,
    );
  byVersion.set(input.target.version, input.target);
  const releases = [...byVersion.values()].sort(
    (a, b) => compareSemver(a.version, b.version) ?? a.version.localeCompare(b.version),
  );
  const wanted = new Set(input.target.entryIds);
  const entries = input.entries.filter((entry) => wanted.has(entry.id));
  if (entries.length !== wanted.size) problems.push("the release lists an entry the ledger lacks");
  const pictures: Record<string, CatalogPicture> = {};
  for (const file of heroFiles(entries)) {
    const picture = input.pictures?.[file];
    if (picture) pictures[file] = picture;
    else problems.push(`the highlight picture ${file} was not read from the ledger`);
  }
  if (problems.length > 0) return { catalog: null, problems };
  return {
    catalog: {
      schema: 1,
      release: { version: input.target.version, sourceCommit: input.target.sourceCommit },
      entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
      releases,
      ...(Object.keys(pictures).length > 0 ? { pictures } : {}),
    },
    problems,
  };
}

/** What a packaged catalog must be before it ships: this exact version and source. */
export function verifyCatalog(
  value: unknown,
  expected: { version: string; sourceCommit: string },
): string[] {
  const problems: string[] = [];
  if (!isRecord(value) || value.schema !== 1) return ["the catalog is not schema 1"];
  const release = value.release;
  if (!isRecord(release)) return ["the catalog names no release"];
  if (release.version !== expected.version)
    problems.push(`the catalog is for ${String(release.version)}, not ${expected.version}`);
  if (release.sourceCommit !== expected.sourceCommit)
    problems.push(
      `the catalog is built from ${String(release.sourceCommit)}, not ${expected.sourceCommit}`,
    );
  const entries: NoteEntry[] = [];
  if (!Array.isArray(value.entries)) problems.push("the catalog has no entries list");
  else
    value.entries.forEach((entry, index) => {
      const parsed = parseEntry(entry, `entries[${index}]`, problems);
      if (parsed) entries.push(parsed);
    });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`entry "${entry.id}" appears twice`);
    ids.add(entry.id);
  }
  const versions = new Set<string>();
  let target: ReleaseManifest | undefined;
  if (!Array.isArray(value.releases)) problems.push("the catalog has no releases list");
  else
    value.releases.forEach((item, index) => {
      const { manifest, problems: found } = parseManifest(item, `releases[${index}]`);
      problems.push(...found);
      if (!manifest) return;
      if (versions.has(manifest.version))
        problems.push(`release ${manifest.version} appears twice`);
      versions.add(manifest.version);
      if (manifest.version === expected.version) target = manifest;
    });
  if (!target) problems.push(`the catalog has no manifest for ${expected.version}`);
  else {
    if (target.sourceCommit !== expected.sourceCommit)
      problems.push("the release manifest names a different source commit");
    const listed = new Set(target.entryIds);
    for (const id of listed)
      if (!ids.has(id)) problems.push(`the release lists missing entry "${id}"`);
    for (const id of ids)
      if (!listed.has(id)) problems.push(`entry "${id}" is outside the release`);
  }
  problems.push(...catalogPictureProblems(value.pictures, entries));
  return problems;
}

/** The catalog's hero files: exactly the highlighted entries' pairs, each with its hash and size. */
function catalogPictureProblems(value: unknown, entries: NoteEntry[]): string[] {
  const problems: string[] = [];
  if (value !== undefined && !isRecord(value)) return ["the catalog's pictures are not a map"];
  const pictures = (value ?? {}) as Json;
  const wanted = new Set(heroFiles(entries));
  for (const file of wanted)
    if (!(file in pictures)) problems.push(`the highlight picture ${file} is not in the catalog`);
  for (const [file, picture] of Object.entries(pictures)) {
    if (!wanted.has(file)) problems.push(`the picture ${file} belongs to no highlight`);
    if (
      !isRecord(picture) ||
      typeof picture.sha256 !== "string" ||
      !SHA256.test(picture.sha256) ||
      !Number.isInteger(picture.width) ||
      (picture.width as number) < 1 ||
      !Number.isInteger(picture.height) ||
      (picture.height as number) < 1
    )
      problems.push(`the picture ${file} needs a sha256, a width and a height`);
  }
  return problems;
}

/**
 * The stable a release is measured from when its highlights are picked: the
 * newest stable older than it, or null for the first.
 */
function lastStable(target: ReleaseManifest, releases: ReleaseManifest[]): ReleaseManifest | null {
  return (
    releases
      .filter(
        (release) =>
          release.channel === "stable" && (compareSemver(release.version, target.version) ?? 0) < 0,
      )
      .sort((a, b) => compareSemver(a.version, b.version) ?? 0)
      .at(-1) ?? null
  );
}

/**
 * The changes a stable's highlights are picked from (the captain's FI3-1392
 * plan): every entry it carries that the last stable did not, never
 * backfilled history, which no note lists.
 */
function sinceLastStable(
  target: ReleaseManifest,
  releases: ReleaseManifest[],
  entries: NoteEntry[],
): NoteEntry[] {
  const before = new Set(lastStable(target, releases)?.entryIds ?? []);
  const carried = new Set(target.entryIds);
  return entries.filter(
    (entry) =>
      carried.has(entry.id) &&
      !before.has(entry.id) &&
      entry.provenance.origin !== "changelog-backfill",
  );
}

/**
 * Why picks cannot be a stable's highlights: they fill every slot (three, or
 * one per change when there are fewer), name each change once, and come from
 * the changes since the last stable.
 */
function pickProblems(picks: string[], version: string, candidates: NoteEntry[]): string[] {
  const problems: string[] = [];
  const slots = Math.min(MAX_HIGHLIGHTS, candidates.length);
  if (picks.length !== slots)
    problems.push(`stable ${version} takes ${slots} picked highlights, not ${picks.length}`);
  if (new Set(picks).size !== picks.length) problems.push("a change is picked twice");
  const allowed = new Set(candidates.map((entry) => entry.id));
  for (const id of picks)
    if (!allowed.has(id))
      problems.push(
        `"${id}" is not a change since the last stable, so it cannot be a highlight of stable ${version}`,
      );
  return problems;
}

/** Why a release's record cannot keep the highlights it names. */
export function recordedHighlightProblems(
  manifest: ReleaseManifest,
  releases: ReleaseManifest[],
  entries: NoteEntry[],
): string[] {
  if (manifest.highlights === undefined) return [];
  if (manifest.channel !== "stable") return ["only a stable's record keeps picked highlights"];
  return pickProblems(
    manifest.highlights,
    manifest.version,
    sinceLastStable(manifest, releases, entries),
  );
}

/** A parsed catalog's entries and releases; call only on one `verifyCatalog` accepted. */
function catalogParts(value: Json): { entries: NoteEntry[]; releases: ReleaseManifest[] } {
  const ignored: string[] = [];
  return {
    entries: (value.entries as unknown[]).flatMap((item) => parseEntry(item, "", ignored) ?? []),
    releases: (value.releases as unknown[]).flatMap(
      (item) => parseManifest(item, "").manifest ?? [],
    ),
  };
}

/** A catalog's own release, read before anything trusts it. */
function catalogRelease(value: unknown): { version: string; sourceCommit: string } {
  const release = isRecord(value) && isRecord(value.release) ? value.release : {};
  return {
    version: typeof release.version === "string" ? release.version : "",
    sourceCommit: typeof release.sourceCommit === "string" ? release.sourceCommit : "",
  };
}

/**
 * What a stable's highlights are picked from: the changes since the last
 * stable, each with the rank its alpha review gave it, from the catalog the
 * promotion generates.
 */
export function highlightCandidates(value: unknown): {
  version: string;
  since: string | null;
  candidates: NoteEntry[];
  problems: string[];
} {
  const { version, sourceCommit } = catalogRelease(value);
  const problems = verifyCatalog(value, { version, sourceCommit });
  if (problems.length > 0) return { version, since: null, candidates: [], problems };
  const { entries, releases } = catalogParts(value as Json);
  const target = releases.find((release) => release.version === version) as ReleaseManifest;
  return {
    version,
    since: lastStable(target, releases)?.version ?? null,
    candidates: sinceLastStable(target, releases, entries),
    problems,
  };
}

/**
 * A stable's catalog with the captain's picks as its only highlights, ranked
 * in his order, every other rank cleared and the pictures map rebuilt for
 * them (docs/alpha.md "Promoting an alpha"). The catalog comes from the
 * promoted alpha's own tooling, so nothing else in it changes. The lead must
 * have a hero picture. `picture` reads a hero file's hash and size from the
 * ledger, or null when it cannot. Every refusal is a returned problem.
 */
export function pickHighlights(
  value: unknown,
  picks: string[],
  picture: (file: string) => CatalogPicture | null,
): { catalog: Record<string, unknown> | null; problems: string[] } {
  const { version, sourceCommit } = catalogRelease(value);
  const listed = highlightCandidates(value);
  if (listed.problems.length > 0) return { catalog: null, problems: listed.problems };
  if (!isStableVersion(version))
    return {
      catalog: null,
      problems: [`${version} is not a stable: an alpha keeps the ranks its notes review gave`],
    };
  const problems = pickProblems(picks, version, listed.candidates);
  const lead = listed.candidates.find((entry) => entry.id === picks[0]);
  if (lead && !lead.picture)
    problems.push(`"${lead.id}" has no hero picture, and only a change with one can lead`);
  if (problems.length > 0) return { catalog: null, problems };
  const ranks = new Map(picks.map((id, index) => [id, index + 1]));
  const entries = ((value as Json).entries as Json[]).map((entry) => {
    const { highlight: _review, ...rest } = entry;
    const rank = ranks.get(entry.id as string);
    return rank === undefined ? rest : { ...rest, highlight: rank };
  });
  const pictures: Record<string, CatalogPicture> = {};
  const ranked = catalogParts({ entries, releases: [] }).entries;
  for (const file of heroFiles(ranked)) {
    const read = picture(file);
    if (read) pictures[file] = read;
    else problems.push(`${PICTURES_DIR}/${file} cannot be read as a picture`);
  }
  if (problems.length > 0) return { catalog: null, problems };
  const { pictures: _review, ...rest } = value as Json;
  const catalog = {
    ...rest,
    entries,
    ...(Object.keys(pictures).length > 0 ? { pictures } : {}),
  };
  const verified = verifyCatalog(catalog, { version, sourceCommit });
  return verified.length > 0 ? { catalog: null, problems: verified } : { catalog, problems };
}
