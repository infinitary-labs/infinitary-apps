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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  crewSectionsOf,
  type NamingRule,
  type RunbookFacts,
  type RunbookManifest,
  type RunbookSkillFiles,
  type RunbookView,
  runbookManifestSchema,
  runbookMatches,
} from "../../shared/runbooks";
import { skillFolders } from "../session/projectResources";
import type { SettingsStore } from "../storage/settingsStore";
import { checkRunbookFiles } from "./runbookFiles";

type Entry = {
  manifest: RunbookManifest;
  dir: string;
  source: "builtin" | "installed" | "personal";
};

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
  "queue",
  "computer-cleanup",
  "architecture",
] as const;

/** The selected section and resource fingerprint share one prompt author. */
export function crewRunbookText(served: { text: string; sha: string }): string {
  return `${served.text}\n\nRunbook resources: ${served.sha}.`;
}

/** Bundled, installed and personal folders supply procedure. SettingsStore alone owns their switches. */
export class Runbooks {
  private readonly bundled: Entry[];
  constructor(
    root: string,
    private readonly settings: Pick<SettingsStore, "getRunbookStates" | "setRunbookStates">,
    private readonly installed: () => string[] = () => [],
    private readonly personalRoot?: string,
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
      })),
      ...unreadable,
    ];
  }
  set(id: string, enabled: boolean): RunbookView[] {
    const entry = this.entries.find(({ manifest }) => manifest.id === id);
    if (!entry) throw new Error("This runbook is not available.");
    const states = { ...this.settings.getRunbookStates(), [id]: enabled };
    if (enabled && entry.manifest.replaces) states[entry.manifest.replaces] = false;
    this.settings.setRunbookStates(states);
    return this.list();
  }
  private active(project?: string): Entry[] {
    const on = new Set(
      this.list()
        .filter((entry) => entry.enabled)
        .map((entry) => entry.id),
    );
    return this.entries.filter(
      ({ manifest }) =>
        on.has(manifest.id) &&
        (!manifest.projects || (project !== undefined && manifest.projects.includes(project))),
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
  crew(facts: RunbookFacts): { text: string; skills: RunbookSkillFiles[]; sha: string } {
    const active = this.active(facts.project);
    const text = this.crewSections(facts).join("\n\n");
    const roots = active.flatMap((entry) =>
      entry.manifest.skills ? [this.path(entry, entry.manifest.skills)] : [],
    );
    const skills = skillFolders(roots).map(({ name, dir }) => ({ name, files: textFiles(dir) }));
    return {
      text,
      skills,
      sha: createHash("sha256").update(JSON.stringify({ text, skills })).digest("hex"),
    };
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
