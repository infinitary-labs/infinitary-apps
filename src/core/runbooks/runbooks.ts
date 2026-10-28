import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
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

type Entry = { manifest: RunbookManifest; dir: string };

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
        return { manifest, dir };
      });
    if (new Set(this.bundled.map(({ manifest }) => manifest.id)).size !== this.bundled.length)
      throw new Error("Runbook names must be unique.");
  }
  builtins(): RunbookManifest[] {
    return this.bundled.map(({ manifest }) => manifest);
  }
  private get entries(): Entry[] {
    const entries = [...this.bundled];
    for (const dir of [...this.installed(), ...this.personalFolders()]) {
      try {
        const manifest = checkRunbookFiles(dir);
        if (entries.some((entry) => entry.manifest.id === manifest.id)) continue;
        entries.push({ manifest, dir });
      } catch (error) {
        console.warn(`Could not read an added runbook: ${String(error)}`);
      }
    }
    return entries;
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
    return this.entries.map(({ manifest, dir }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      enabled: states[manifest.id] !== false,
      ...(this.personalRoot && dirname(dir) === this.personalRoot ? { path: dir } : {}),
    }));
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
  crew(facts: RunbookFacts): { text: string; skills: RunbookSkillFiles[]; sha: string } {
    const active = this.active(facts.project);
    const text = active
      .flatMap((entry) =>
        entry.manifest.crew && runbookMatches(entry.manifest.crew.when, facts)
          ? [this.read(entry, entry.manifest.crew.file)]
          : [],
      )
      .join("\n\n");
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
