import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  crewSectionsOf,
  type NamingRule,
  type RunbookFacts,
  type RunbookManifest,
  type RunbookOffer,
  type RunbookSection,
  type RunbookSkillFiles,
  type RunbookView,
  runbookManifestSchema,
  runbookMatches,
  runbookPanelId,
  runbookPanelSlice,
} from "../../shared/runbooks";
import { skillFolders } from "../session/projectResources";
import type { SettingsStore } from "../storage/settingsStore";
import { checkRunbookFiles } from "./runbookFiles";

type Entry = {
  manifest: RunbookManifest;
  dir: string;
  source: "builtin" | "installed" | "personal";
};

const MAP_PART_FILE = "skills/advanced-architecture/parts/map.html";

/** The captain's common-to-niche order, shared by every reader and joined guidance. */
export const BUILTIN_RUNBOOK_ORDER = [
  "sequences",
  "delivery",
  "testing",
  "care",
  "naming",
  "programs",
  "casual-projects",
  "lessons",
  "batches",
  "pull-comments",
  "computer-cleanup",
  "bring-secrets",
  "feedback",
  "architecture",
] as const;

/** The selected section and resource fingerprint share one prompt author. */
export function crewRunbookText(served: { text: string; sha: string }): string {
  return `${served.text}\n\nRunbook resources: ${served.sha}.`;
}

/**
 * One panel a runbook that is on shows (docs/runbooks.md, "Panels"): its
 * folder, the id it is shown under, and the runbook it comes with.
 */
export type RunbookPanel = {
  id: string;
  /** The folder as the runbook's manifest names it. */
  folder: string;
  /** Where its saved data is kept (`runbookPanelSlice`). */
  slice: string;
  dir: string;
  runbook: { id: string; name: string; source: "installed" | "personal" };
};

/**
 * What `crewPart` answers: each crew section with the selector that serves
 * it (an absent one serves every crewmate in the runbook's reach), and the
 * names of the skills its crewmates may open.
 */
export type RunbookCrewPart = {
  id: string;
  name: string;
  enabled: boolean;
  projects?: string[];
  sections: { when?: RunbookSection["when"]; text: string }[];
  skills: string[];
};

/** Bundled, installed and personal folders supply procedure. SettingsStore alone owns their switches. */
export class Runbooks {
  private readonly bundled: Entry[];
  /** Who hears that a switch, a copy or a turned-on built-in may have changed what is on. */
  private readonly listeners = new Set<() => void>();
  constructor(
    root: string,
    private readonly settings: Pick<SettingsStore, "getRunbookStates" | "setRunbookStates">,
    private readonly installed: () => string[] = () => [],
    private readonly personalRoot?: string,
    /**
     * The names of the projects that still use a choice a runbook offers,
     * such as those on batched pull requests (`RUNBOOK_OFFERS`).
     */
    private readonly using: (offer: RunbookOffer) => string[] = () => [],
  ) {
    this.bundled = readdirSync(root)
      .sort()
      .map((name) => {
        const dir = join(root, name);
        const manifest = runbookManifestSchema.parse(
          JSON.parse(readFileSync(join(dir, "runbook.json"), "utf8")),
        );
        return { manifest, dir, source: "builtin" as const };
      });
    const order = new Map<string, number>(BUILTIN_RUNBOOK_ORDER.map((id, index) => [id, index]));
    for (const { manifest } of this.bundled) {
      if (!order.has(manifest.id))
        throw new Error(`Place ${manifest.id} in the built-in runbook order.`);
    }
    this.bundled.sort((a, b) => (order.get(a.manifest.id) ?? 0) - (order.get(b.manifest.id) ?? 0));
    if (new Set(this.bundled.map(({ manifest }) => manifest.id)).size !== this.bundled.length)
      throw new Error("Runbook names must be unique.");
  }
  builtins(): RunbookManifest[] {
    return this.bundled.map(({ manifest }) => manifest);
  }
  /** Hears every switch, copy and kept offer; returns the way to stop hearing. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  /**
   * The panels the runbooks you made or added show while they are on
   * (docs/runbooks.md, "Panels"), in runbook then manifest order. A built-in
   * runbook's panels are not read here.
   */
  panels(): RunbookPanel[] {
    return this.enabled().flatMap(({ manifest, dir, source }) =>
      source === "builtin"
        ? []
        : (manifest.panels ?? []).map((folder) => ({
            id: runbookPanelId(manifest, folder),
            folder,
            slice: runbookPanelSlice(manifest.id, folder),
            dir: contained(dir, folder),
            runbook: { id: manifest.id, name: manifest.name, source },
          })),
    );
  }
  /**
   * The map part the Advanced architecture runbook ships, which a story's map
   * view draws in on its merge card whether or not the runbook is on now
   * (`docs/forge.md`, "A map view"); undefined when it cannot be read.
   */
  async mapPart(): Promise<string | undefined> {
    const architecture = this.bundled.find(({ manifest }) => manifest.id === "architecture");
    if (!architecture) return undefined;
    return readFile(join(architecture.dir, MAP_PART_FILE), "utf8").catch(() => undefined);
  }
  private scan(): { entries: Entry[]; unreadable: RunbookView[] } {
    const entries = [...this.bundled];
    const unreadable: RunbookView[] = [];
    const folders = [
      ...this.installed().map((dir) => ({ dir, source: "installed" as const })),
      ...this.personalFolders().map((dir) => ({ dir, source: "personal" as const })),
    ];
    for (const { dir, source } of folders) {
      try {
        const manifest = checkRunbookFiles(dir);
        // An added runbook is its record's, whose folder bears its id: files
        // changed to name another never borrow that one's grants or data.
        if (source === "installed" && manifest.id !== basename(dir))
          throw new Error("This runbook's files now name another runbook. Add it again.");
        if (entries.some((entry) => entry.manifest.id === manifest.id)) continue;
        entries.push({ manifest, dir, source });
      } catch (error) {
        unreadable.push({
          id: `unreadable:${dir}`,
          name: basename(dir),
          description: "This runbook is not available.",
          enabled: false,
          path: dir,
          source,
          error:
            error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")
              ? "Check runbook.json: its fields could not be read."
              : error instanceof Error && !("code" in error)
                ? error.message
                : "Check that this folder and its runbook.json can be read.",
        });
      }
    }
    return { entries, unreadable };
  }
  private get entries(): Entry[] {
    return this.scan().entries;
  }
  /** Only the local host opens folders; a paired view cannot turn a home path into a local one. */
  personalFolder(): string {
    if (!this.personalRoot) throw new Error("The personal workspace is not available.");
    mkdirSync(this.personalRoot, { recursive: true });
    this.personalFolders(true);
    return this.personalRoot;
  }
  /** View immutable built-ins without exposing the signed bundle to an editor. */
  view(id: string, temporaryRoot: string): string {
    const source = this.bundled.find((entry) => entry.manifest.id === id);
    if (!source) throw new Error("Choose a built-in runbook to view.");
    const parent = mkdtempSync(join(temporaryRoot, "infinitary-runbook-"));
    chmodSync(parent, 0o700);
    const dir = join(parent, source.manifest.id);
    const copy = (from: string, to: string) => {
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error("A built-in runbook must contain plain files.");
      if (stat.isDirectory()) {
        mkdirSync(to);
        for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
        chmodSync(to, 0o555);
      } else if (stat.isFile()) {
        writeFileSync(to, readFileSync(from), { mode: 0o444 });
      } else throw new Error("A built-in runbook must contain plain files.");
    };
    try {
      copy(source.dir, dir);
      return dir;
    } catch (error) {
      const writable = (path: string) => {
        if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
        chmodSync(path, 0o700);
        for (const name of readdirSync(path)) writable(join(path, name));
      };
      writable(parent);
      rmSync(parent, { recursive: true, force: true });
      throw error;
    }
  }
  private personalFolders(strict = false): string[] {
    const root = this.personalRoot;
    if (!root || !existsSync(root)) return [];
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
      if (strict) throw new Error("Your runbooks folder must be a plain folder.");
      return [];
    }
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name));
  }
  /** Copy only our immutable bundle, never overwrite personal work or activate new guidance. */
  copy(id: string, copyId: string, name: string): RunbookView[] {
    if (!this.personalRoot) throw new Error("The personal workspace is not available.");
    const source = this.bundled.find((entry) => entry.manifest.id === id);
    if (!source) throw new Error("Choose a built-in runbook to copy.");
    const manifest = runbookManifestSchema.parse({
      ...source.manifest,
      id: copyId,
      name,
      author: "You",
      version: "1.0.0",
      replaces: id,
    });
    if (this.entries.some((entry) => entry.manifest.id === copyId))
      throw new Error("That runbook id is already in use. Choose another for your copy.");
    mkdirSync(this.personalRoot, { recursive: true });
    this.personalFolders(true);
    const dir = contained(this.personalRoot, copyId);
    mkdirSync(dir); // Exclusive: an existing folder, even an invalid runbook, is never overwritten.
    try {
      cpSync(source.dir, dir, { recursive: true });
      writeFileSync(join(dir, "runbook.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      checkRunbookFiles(dir);
      this.settings.setRunbookStates({ ...this.settings.getRunbookStates(), [copyId]: false });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    this.changed();
    return this.list();
  }
  list(): RunbookView[] {
    const states = this.settings.getRunbookStates();
    const { entries, unreadable } = this.scan();
    return [
      ...entries.map(({ manifest, dir, source }) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        enabled: states[manifest.id] ?? !manifest.startsOff,
        source,
        ...(source === "personal" ? { path: dir } : {}),
        ...(manifest.panels?.length
          ? {
              panels: manifest.panels.map((folder) => ({
                id: runbookPanelId(manifest, folder),
                title: panelTitle(dir, folder),
              })),
            }
          : {}),
      })),
      ...unreadable,
    ];
  }
  set(id: string, enabled: boolean): RunbookView[] {
    const entries = this.entries;
    const entry = entries.find(({ manifest }) => manifest.id === id);
    if (!entry) throw new Error("This runbook is not available.");
    const before = this.settings.getRunbookStates();
    const states = { ...before, [id]: enabled };
    if (enabled && entry.manifest.replaces) states[entry.manifest.replaces] = false;
    // A choice a project still uses keeps a runbook that offers it on.
    const had = offersUnder(entries, before);
    const has = offersUnder(entries, states);
    for (const offer of had) {
      if (has.has(offer)) continue;
      const projects = this.using(offer);
      if (projects.length > 0) throw new Error(offerInUse(offer, projects));
    }
    this.settings.setRunbookStates(states);
    this.changed();
    return this.list();
  }
  /**
   * Every choice an enabled runbook offers (docs/runbooks.md, "Built-ins"):
   * the host reads only what one offers, and never which one.
   */
  offers(): Set<RunbookOffer> {
    return offersUnder(this.entries, this.settings.getRunbookStates());
  }
  /**
   * Turn on the built-in that offers a choice a project still uses while no
   * enabled runbook offers it, as after the update that started Batched
   * pull requests off: a person already batching keeps it, quietly.
   */
  keepOffersInUse(): void {
    const offered = this.offers();
    for (const { manifest } of this.bundled) {
      const kept = (manifest.offers ?? []).some(
        (offer) => !offered.has(offer) && this.using(offer).length > 0,
      );
      if (kept) {
        this.settings.setRunbookStates({
          ...this.settings.getRunbookStates(),
          [manifest.id]: true,
        });
        this.changed();
      }
    }
  }
  /** The runbooks that are on, from one scan and one read of the switches. */
  private enabled(): Entry[] {
    const states = this.settings.getRunbookStates();
    return this.entries.filter(({ manifest }) => states[manifest.id] ?? !manifest.startsOff);
  }
  private active(project?: string): Entry[] {
    return this.enabled().filter(
      ({ manifest }) =>
        !manifest.projects || (project !== undefined && manifest.projects.includes(project)),
    );
  }
  firstmate(): { text: string; sha: string } {
    const text = this.active()
      .flatMap((entry) =>
        entry.manifest.firstmate ? [this.read(entry, entry.manifest.firstmate)] : [],
      )
      .join("\n\n");
    return { text, sha: createHash("sha256").update(text).digest("hex") };
  }
  /** The crew sections the facts select, in runbook then manifest order. */
  crewSections(facts: RunbookFacts): string[] {
    return this.active(facts.project).flatMap((entry) =>
      crewSectionsOf(entry.manifest)
        .filter((section) => runbookMatches(section.when, facts))
        .map((section) => this.read(entry, section.file)),
    );
  }
  crew(facts: RunbookFacts): {
    text: string;
    skills: RunbookSkillFiles[];
    sha: string;
    /** The host wakes asked for by the runbooks whose crew sections the facts select. */
    wakes: string[];
  } {
    const active = this.active(facts.project);
    const wakes = active.flatMap((entry) =>
      crewSectionsOf(entry.manifest).some((section) => runbookMatches(section.when, facts))
        ? (entry.manifest.wakes ?? [])
        : [],
    );
    const text = this.crewSections(facts).join("\n\n");
    const roots = active.flatMap((entry) =>
      entry.manifest.skills ? [this.path(entry, entry.manifest.skills)] : [],
    );
    const skills = skillFolders(roots).map(({ name, dir }) => ({ name, files: textFiles(dir) }));
    return {
      text,
      skills,
      sha: createHash("sha256").update(JSON.stringify({ text, skills })).digest("hex"),
      wakes: [...new Set(wakes)],
    };
  }
  /**
   * A runbook's crew part, whole, for the first mate to read on request
   * (docs/runbooks.md, "Reading a runbook's crew part"): its served
   * first-mate section is only half of what the runbook says. Read by id or
   * name whether it is on or off, since a question may be about turning it on.
   */
  crewPart(name: string): RunbookCrewPart {
    const entries = this.entries;
    const wanted = name.trim().toLowerCase();
    const entry =
      entries.find(({ manifest }) => manifest.id === name.trim()) ??
      entries.find(({ manifest }) => manifest.name.toLowerCase() === wanted);
    if (!entry)
      throw new Error(
        `No runbook "${name}". Runbooks: ${entries.map(({ manifest }) => `${manifest.name} (${manifest.id})`).join(", ")}.`,
      );
    const { manifest } = entry;
    const states = this.settings.getRunbookStates();
    return {
      id: manifest.id,
      name: manifest.name,
      enabled: states[manifest.id] ?? !manifest.startsOff,
      ...(manifest.projects ? { projects: manifest.projects } : {}),
      sections: crewSectionsOf(manifest).map((section) => ({
        ...(section.when ? { when: section.when } : {}),
        text: this.read(entry, section.file),
      })),
      skills: manifest.skills
        ? skillFolders([this.path(entry, manifest.skills)]).map(({ name }) => name)
        : [],
    };
  }
  /**
   * Every host wake an enabled runbook asks for (docs/runbooks.md,
   * "Built-ins"): the host reads only what one asks, and never which one.
   */
  wakes(): Set<string> {
    return new Set(this.active().flatMap((entry) => entry.manifest.wakes ?? []));
  }
  naming(): NamingRule | null {
    return this.active().find((entry) => entry.manifest.naming)?.manifest.naming ?? null;
  }
  private path(entry: Entry, file: string): string {
    return contained(entry.dir, file);
  }
  private read(entry: Entry, file: string): string {
    const text = readFileSync(this.path(entry, file), "utf8");
    if (file.endsWith(".json")) {
      const section: unknown = JSON.parse(text);
      if (typeof section !== "string") throw new Error("A runbook section must be text.");
      return section.trim();
    }
    return text.trim();
  }
}

function offersUnder(entries: Entry[], states: Record<string, boolean>): Set<RunbookOffer> {
  return new Set(
    entries
      .filter(({ manifest }) => states[manifest.id] ?? !manifest.startsOff)
      .flatMap(({ manifest }) => manifest.offers ?? []),
  );
}

const OFFER_NAMES: Record<RunbookOffer, string> = {
  "batched-pull-requests": "batched pull requests",
};

/** Why a runbook stays on: the projects named still use what it offers. */
export function offerInUse(offer: RunbookOffer, projects: string[]): string {
  const names =
    projects.length === 1
      ? projects[0]
      : `${projects.slice(0, -1).join(", ")} and ${projects[projects.length - 1]}`;
  return `${names} still ${projects.length === 1 ? "uses" : "use"} ${OFFER_NAMES[offer]}. Choose another way for changes to go in Settings, under Projects, then turn this runbook off.`;
}

/** A runbook panel's title as its manifest names it, or its folder's name. */
function panelTitle(dir: string, folder: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(contained(dir, folder), "manifest.json"), "utf8")) as {
      title?: unknown;
    };
    if (typeof raw.title === "string" && raw.title) return raw.title;
  } catch {
    // An unreadable manifest is named by its folder; the panel says why it does not show.
  }
  return basename(folder);
}

function contained(root: string, file: string): string {
  const path = resolve(root, file);
  if (
    !relative(resolve(root), path) ||
    relative(resolve(root), path).startsWith(`..${sep}`) ||
    relative(resolve(root), path) === ".."
  )
    throw new Error("Runbook files must stay inside their folder.");
  return path;
}
function textFiles(root: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const file = join(prefix, name);
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink()) throw new Error("A runbook cannot link outside its folder.");
    if (stat.isDirectory()) Object.assign(files, textFiles(root, file));
    else if (stat.isFile()) files[file] = readFileSync(join(root, file)).toString("base64");
  }
  return files;
}

/** The third skill root is materialized on the computer actually opening the session. */
export async function stageRunbookSkills(
  skills: readonly RunbookSkillFiles[],
  root: string,
): Promise<{ name: string; dir: string }[]> {
  await rm(root, { recursive: true, force: true });
  const result: { name: string; dir: string }[] = [];
  for (const skill of skills) {
    const dir = contained(root, skill.name);
    for (const [file, content] of Object.entries(skill.files)) {
      const path = contained(dir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(content, "base64"));
    }
    result.push({ name: skill.name, dir });
  }
  return result;
}
