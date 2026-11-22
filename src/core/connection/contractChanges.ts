import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The contract's changes, by name (docs/contract.md, "Changes by name";
 * src/shared/contract-changes/README.md).
 *
 * Each change to the published contract adds one Markdown file to
 * `src/shared/contract-changes/`, named for the change and never for a
 * number. The folder holds exactly one `major-<N>.md`, the current major,
 * which `PROTOCOL_VERSION`'s major matches; every other file is a minor
 * change, and its name, without `.md`, is what this build lists in its hello
 * and its welcome (`changes`, src/shared/connection.ts). A minor file moves
 * no version, so two changes open at once each add a file of their own and
 * merge cleanly; two majors at once both add the next major's file, and
 * conflict on purpose.
 *
 * A feature that needs the other side to have a change waits for its name:
 * it names the change once with `contractChange`, which refuses a name no
 * file has, and asks `listsChange` of what the other side listed. A side
 * that listed nothing has no change.
 *
 * This module imports only Node, as `src/core/prompts/contractVersion.ts`
 * does: a packaged app has no source folder to read, so its build lists the
 * files once and bakes the list in (`electron.vite.config.ts`); tests read
 * the folder.
 */

export function contractChangesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "contract-changes");
}

export function contractChangeFiles(dir: string = contractChangesDir()): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

export type ContractChanges = { major: number; names: readonly string[] };

const MAJOR_FILE = /^major-(\d+)\.md$/;
const CHANGE_FILE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/;

/** The last minor typed by hand, before changes had names: major 10 stays at 10.1. */
const LAST_TYPED = { major: 10, minor: 1 } as const;

/**
 * Reads a folder's file names, refusing one the rule does not allow: no
 * major file or more than one, or a file not named in lowercase words
 * joined by hyphens, starting with a letter.
 */
export function readContractChanges(files: readonly string[]): ContractChanges {
  const majors = files.filter((file) => MAJOR_FILE.test(file));
  if (majors.length !== 1)
    throw new Error(
      `The contract changes hold ${majors.length === 0 ? "no major file" : `${majors.length} major files (${majors.join(", ")})`}; exactly one, major-<N>.md, names the current major (src/shared/contract-changes/README.md).`,
    );
  const odd = files.find((file) => !CHANGE_FILE.test(file));
  if (odd)
    throw new Error(
      `${odd} is not a contract change's name: name it in lowercase words joined by hyphens (src/shared/contract-changes/README.md).`,
    );
  return {
    major: Number(MAJOR_FILE.exec(majors[0] as string)?.[1]),
    names: files.filter((file) => !MAJOR_FILE.test(file)).map((file) => file.slice(0, -3)),
  };
}

/**
 * The one `PROTOCOL_VERSION` a folder's files allow: the major file's
 * number, at minor 0 and patch 0. A minor file moves nothing. Major 10
 * keeps 10.1, the last minor typed, until the next major.
 */
export function protocolVersionOf(changes: ContractChanges): string {
  return `${changes.major}.${changes.major === LAST_TYPED.major ? LAST_TYPED.minor : 0}.0`;
}

/** The change files the packaged app's build listed; undefined everywhere else. */
declare const __INF_CONTRACT_CHANGES__: readonly string[] | undefined;

/** This build's contract changes, which its hello and its welcome list. */
export const CONTRACT_CHANGES: ContractChanges = readContractChanges(
  typeof __INF_CONTRACT_CHANGES__ === "undefined"
    ? contractChangeFiles()
    : __INF_CONTRACT_CHANGES__,
);

/** A change's name that a file in the folder has (`contractChange`). */
export type ContractChangeName = string & { readonly contractChange: unique symbol };

/**
 * The change a feature waits for, named once beside the feature, such as
 * `const PLAN_LABEL_LIMITS = contractChange("plan-label-limits")` for the
 * change in `plan-label-limits.md`. A name no file has is refused when the
 * module loads, so a wait can never name a change no build lists.
 */
export function contractChange(
  name: string,
  changes: ContractChanges = CONTRACT_CHANGES,
): ContractChangeName {
  if (!changes.names.includes(name))
    throw new Error(
      `No contract change is named ${name}: add src/shared/contract-changes/${name}.md, or wait for a change that has a file (src/shared/contract-changes/README.md).`,
    );
  return name as ContractChangeName;
}

/**
 * Whether the other side listed a change in its hello or its welcome. A side
 * that listed nothing, such as one built before changes had names, has none.
 */
export function listsChange(
  listed: readonly string[] | null | undefined,
  change: ContractChangeName,
): boolean {
  return listed?.includes(change) ?? false;
}

/**
 * Something a computer that runs work cannot do until it is updated: its
 * hello did not list `change`. A crewmate turn it refuses waits for that
 * computer's update with its task open, and carries on once the computer
 * lists the change (docs/helper.md, "Waiting for its update").
 */
export class ComputerBehindError extends Error {
  constructor(
    message: string,
    readonly deviceId: string,
    readonly change: ContractChangeName,
  ) {
    super(message);
    this.name = "ComputerBehindError";
  }
}

/**
 * What a major's file says it did to views (src/shared/contract-changes/README.md,
 * "Adding a major change"): `keep`, when nothing a view sends or reads broke,
 * or `break`, which moves `VIEW_FLOOR` to that major. Refuses a file that
 * says neither, or both.
 */
export function viewsDeclaration(text: string): "keep" | "break" {
  const said = [...text.matchAll(/^Views: (keep|break)\.$/gm)].map((match) => match[1]);
  if (said.length !== 1)
    throw new Error(
      `A major's file says once whether views break, on a line of its own: "Views: keep." or "Views: break." (src/shared/contract-changes/README.md).`,
    );
  return said[0] as "keep" | "break";
}

export function viewFloorAgrees(major: number, views: "keep" | "break", floor: number): boolean {
  return views === "break" ? floor === major : floor < major;
}
