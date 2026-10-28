import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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

type Entry = { manifest: RunbookManifest; dir: string };

/** The selected section and resource fingerprint share one prompt author. */
export function crewRunbookText(served: { text: string; sha: string }): string {
  return `${served.text}\n\nRunbook resources: ${served.sha}.`;
}

/** Bundle-owned folders are the source of procedure. SettingsStore alone owns their switches. */
export class Runbooks {
  private readonly entries: Entry[];
  constructor(
    root: string,
    private readonly settings: Pick<SettingsStore, "getRunbookStates" | "setRunbookStates">,
  ) {
    this.entries = readdirSync(root)
      .sort()
      .map((name) => {
        const dir = join(root, name);
        const manifest = runbookManifestSchema.parse(
          JSON.parse(readFileSync(join(dir, "runbook.json"), "utf8")),
        );
        return { manifest, dir };
      });
    if (new Set(this.entries.map(({ manifest }) => manifest.id)).size !== this.entries.length)
      throw new Error("Runbook names must be unique.");
  }
  list(): RunbookView[] {
    const states = this.settings.getRunbookStates();
    return this.entries.map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      enabled: states[manifest.id] !== false,
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
