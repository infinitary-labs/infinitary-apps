import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The orchestrator contract's version, in its own leaf module.
 *
 * It lives here rather than beside the persona text for one mechanical
 * reason: the offline exporters (`scripts/export-corpus.ts` and friends) are
 * plain-Node scripts that Node 24 type-strips with no bundler, so a module
 * they import must resolve without the `@core` aliases or extensionless
 * relative paths the core uses everywhere else. `piResources.ts` stopped
 * being such a leaf at v3.6, when the persona began including
 * `CARD_AUTHORING`; the version a corpus record is stamped with did not have
 * to move with it. `piResources.ts` re-exports this so every other importer
 * is unchanged.
 *
 * The version is counted, never written: each contract revision adds one
 * file to `contract-revisions/` beside this module, and the version is 4.72,
 * the last one written by hand, plus one per file. Two changes open at once
 * each add their own file, so neither edits a line the other edits. The
 * folder's README says how to write one and keeps the ledger through 4.72.
 *
 * A packaged app has no source folder to read, so its build lists the files
 * once and bakes the list in (`electron.vite.config.ts`); tests, the e2e
 * specs and the plain-Node exporters read the folder.
 */

/** The last version written by hand; each revision file since adds one to its minor. */
const LAST_WRITTEN = { major: 4, minor: 72 } as const;

export function contractRevisionsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "contract-revisions");
}

/** A revision is any Markdown file in the folder but its README. */
function isRevision(name: string): boolean {
  return name.endsWith(".md") && name !== "README.md";
}

export function contractRevisionFiles(dir: string = contractRevisionsDir()): string[] {
  return readdirSync(dir).filter(isRevision).sort();
}

export function contractVersionOf(revisionFiles: readonly string[]): string {
  return `${LAST_WRITTEN.major}.${LAST_WRITTEN.minor + revisionFiles.filter(isRevision).length}`;
}

/** The revision files the packaged app's build listed; undefined everywhere else. */
declare const __FM_CONTRACT_REVISIONS__: readonly string[] | undefined;

export const FIRSTMATE_CONTRACT_VERSION = contractVersionOf(
  typeof __FM_CONTRACT_REVISIONS__ === "undefined"
    ? contractRevisionFiles()
    : __FM_CONTRACT_REVISIONS__,
);
