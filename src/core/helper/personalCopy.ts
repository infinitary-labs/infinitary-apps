import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import type { WorkOrderRequest, WorkOrderResponse } from "@shared/work";
import { z } from "zod";
import { listsChange } from "../connection/contractChanges";
import { PERSONAL_SYNC } from "../placed/personalSync";
import { folderLinkType } from "../platform";
import { PERSONAL_INSTRUCTION_FILES } from "../session/personalResources";
import { type PersonalVersion, personalFingerprintOf } from "../session/personalSet";

/** What `inf:session:personal` carries: the home's set, whole. */
export type PersonalKeep = {
  version: string;
  since: number;
  files: { path: string; data: string; exec?: boolean }[];
};

const keptSchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/),
  since: z.number(),
  files: z.number().int().nonnegative(),
});

/** Where a skill may sit in the set: beneath one of the reader's two skill folders. */
const SKILL_ROOTS = [".agents/skills/", ".claude/skills/"];

/** A path the set may hold: the reader's instruction files, or a file inside a skill. */
export function allowedPersonalPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.includes("\0") || path.includes("\\"))
    return false;
  if (posix.isAbsolute(path) || posix.normalize(path) !== path) return false;
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return false;
  if ((PERSONAL_INSTRUCTION_FILES as readonly string[]).includes(path)) return true;
  return SKILL_ROOTS.some((root) => {
    if (!path.startsWith(root)) return false;
    // `<root><skill>/<file...>`: a skill's folder, never a file beside the skills.
    return path.slice(root.length).split("/").length >= 2;
  });
}

/**
 * The one writer over `userData/work/personal/` on a computer that runs work
 * (docs/personal-resources.md, "One set, kept on each computer"): the home's
 * personal instructions and skills as the home last sent them, in
 * `v-<fingerprint>/`, laid out as the home's own folder holds them, with
 * `v-<fingerprint>.json` saying since when the home has had that version.
 * `current` is a link to the version kept now, swapped in one rename, so a
 * crewmate reading it never meets half a set; the reader reads `current` in
 * place of this user's home folder, whose own files are never read for the
 * home's crew. Folders 0700, files 0600, or 0700 where the home's was
 * executable.
 */
export class PersonalCopy {
  constructor(private readonly dir: string) {}

  /**
   * What a conversation asked to read the personal set reads: the set as the
   * home last sent it, for a home that sends one (`personal-sync`), so this
   * user's own files are never read for its crew; otherwise nothing here.
   */
  forHome(
    homeChanges: readonly string[] | null,
  ): { root: string; held?: PersonalVersion } | undefined {
    if (!listsChange(homeChanges, PERSONAL_SYNC)) return undefined;
    return { root: this.root(), held: this.held() };
  }

  /** The folder the reader reads for a conversation here: it holds nothing until a set arrives. */
  root(): string {
    return join(this.dir, "current");
  }

  /** The version kept now, or none before the home first sent one. */
  held(): PersonalVersion | undefined {
    let name: string;
    try {
      name = linkedName(this.root());
    } catch {
      return undefined;
    }
    try {
      return keptSchema.parse(JSON.parse(readFileSync(join(this.dir, `${name}.json`), "utf8")));
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps the home's set in place of the one kept before, once what it wrote
   * has the fingerprint the home named; a set already kept is left as it is.
   */
  keep(set: PersonalKeep): PersonalVersion {
    keptSchema.shape.version.parse(set.version);
    const held = this.held();
    if (held?.version === set.version) return held;
    for (const file of set.files)
      if (!allowedPersonalPath(file.path))
        throw new Error(`The personal set names a file outside its folders: ${file.path}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const incoming = join(this.dir, `.incoming-${randomUUID()}`);
    try {
      mkdirSync(incoming, { mode: 0o700 });
      for (const file of set.files) {
        const path = join(incoming, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, Buffer.from(file.data, "base64"), {
          mode: file.exec ? 0o700 : 0o600,
          flag: "wx",
        });
        chmodSync(path, file.exec ? 0o700 : 0o600);
      }
      const written = personalFingerprintOf(incoming);
      if (written !== set.version)
        throw new Error("The personal set arrived with another fingerprint than the home named.");
      const name = `v-${set.version}`;
      const kept: PersonalVersion = {
        version: set.version,
        since: set.since,
        files: set.files.length,
      };
      writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(kept), { mode: 0o600 });
      rmSync(join(this.dir, name), { recursive: true, force: true });
      renameSync(incoming, join(this.dir, name));
      const link = join(this.dir, `.current-${randomUUID()}`);
      // On Windows a junction, which a standard account may make; it names
      // its folder in full, and a rename never replaces a folder there, so
      // the link before it goes first (`folderLinkType`).
      if (folderLinkType() === "junction") {
        symlinkSync(join(this.dir, name), link, "junction");
        rmSync(this.root(), { force: true });
      } else symlinkSync(name, link);
      renameSync(link, this.root());
      this.prune(name);
      return kept;
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }

  /** Every version but the one kept now, and anything an interrupted keep left. */
  prune(keep: string | undefined = this.keptName()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "current" || name === keep || name === `${keep}.json`) continue;
      rmSync(join(this.dir, name), { recursive: true, force: true });
    }
  }

  private keptName(): string | undefined {
    try {
      return linkedName(this.root());
    } catch {
      return undefined;
    }
  }
}

/** The answer to `inf:session:personal`: the home's set kept here, by the copy this computer keeps. */
export function keepOrdered(
  copy: PersonalCopy | undefined,
  request: WorkOrderRequest<"inf:session:personal">,
): WorkOrderResponse<"inf:session:personal"> {
  if (!copy) throw new Error("This computer keeps no personal instructions.");
  const [set] = request;
  return { personal: copy.keep(set) };
}

/** The version a `current` link names: its folder's own name, whether the link names it alone or in full. */
function linkedName(link: string): string {
  return basename(readlinkSync(link).replace(/[\\/]+$/, ""));
}
