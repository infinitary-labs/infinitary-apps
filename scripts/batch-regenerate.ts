import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A merge batch regenerates the phone's generated files itself, before its
 * checks run (docs/testing.md, "The swept batch"; the captain's pick in the
 * daily velocity review). Each approved change regenerated them from its
 * own base, so changes combined in one batch can leave a generated phone
 * file out of step with the sources they changed together, which `pnpm
 * check` then fails. batch-checks.yml's first job runs this on the batch's
 * version:
 *
 *   node scripts/batch-regenerate.ts --out <folder>
 *
 * It runs the phone's generators, and when they change files it writes the
 * difference and the commit's words into <folder> for the job after it,
 * which commits and pushes them onto the batch branch and runs no code of
 * the project. The app takes that commit as the batch's version and pushes
 * it again, so every check runs on it (docs/forge.md, "A generated commit").
 * A version that already is such a commit is not regenerated again, so its
 * checks read whether the generators agree with it.
 *
 * It writes `changed=true|false` to $GITHUB_OUTPUT when that is set, and
 * fails, naming them, when a generator changed a file the project does not
 * mark generated in .gitattributes, since the app would never take that
 * commit.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The phone's generators, each writing only files under ios/ the project marks generated. */
export const PHONE_GENERATORS = [
  "scripts/generate-phone-contract.ts",
  "scripts/generate-phone-theme.ts",
  "scripts/generate-phone-scene.ts",
  "scripts/generate-phone-cards.ts",
  "scripts/generate-phone-settings.ts",
] as const;

/** The trailer the regenerated commit carries, by which a version that is one is known. */
export const REGENERATED_TRAILER = "Batch-regenerated: phone";

/** The regenerated commit's subject. */
export const REGENERATED_SUBJECT = "chore(phone): regenerate the phone's generated files in the batch";

/** The attribute the project marks its generated files with, as the app reads it. */
const GENERATED_ATTRIBUTE = "linguist-generated";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Whether a commit's words carry the regenerated commit's trailer on a line of its own. */
export function isRegenerated(message: string): boolean {
  return message.split("\n").some((line) => line.trim() === REGENERATED_TRAILER);
}

/** The files the working copy changed or added since its version, tracked and untracked. */
export function changedFiles(root: string): string[] {
  const entries = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  const files: string[] = [];
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] as string;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename names its former path in the next entry.
    if (entry[0] === "R" || entry[0] === "C") at += 1;
  }
  return files;
}

/**
 * The files of `files` the project does not mark generated, by the
 * .gitattributes of the version checked out (its index), never one a
 * generator wrote: the same rule the app takes the commit by.
 */
export function notGenerated(root: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const answer = git(root, ["check-attr", "-z", "--cached", GENERATED_ATTRIBUTE, "--", ...files]).split("\0");
  const left: string[] = [];
  for (let at = 0; at + 2 < answer.length; at += 3) {
    const value = answer[at + 2];
    if (value !== "set" && value !== "true") left.push(answer[at] as string);
  }
  return left;
}

/** The regenerated commit's words: its subject, what it is, the files, and its trailer. */
export function commitMessage(files: readonly string[]): string {
  return [
    REGENERATED_SUBJECT,
    "",
    "The merge batch's own check ran the phone's generators on the batch's combined changes before its checks, and they changed these files:",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    REGENERATED_TRAILER,
    "",
  ].join("\n");
}

function output(changed: boolean): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const out = at >= 0 ? args[at + 1] : undefined;
  if (!out) throw new Error("usage: node scripts/batch-regenerate.ts --out <folder>");
  if (isRegenerated(git(ROOT, ["log", "-1", "--format=%B", "HEAD"]))) {
    console.log("This version is the batch's regenerated commit; its checks read whether the generators agree with it.");
    output(false);
    return;
  }
  // What the install or anything before it left in the checkout is not the generators'.
  const before = new Set(changedFiles(ROOT));
  // The generators read the desktop's compiled messages, as `pnpm check` builds them first.
  for (const script of ["scripts/generate-messages.ts", ...PHONE_GENERATORS])
    execFileSync(process.execPath, script.endsWith("generate-messages.ts") ? [script, "--compiled"] : [script], {
      cwd: ROOT,
      stdio: "inherit",
    });
  const files = changedFiles(ROOT).filter((file) => !before.has(file));
  if (files.length === 0) {
    console.log("The phone's generated files agree with the batch's sources; nothing to regenerate.");
    output(false);
    return;
  }
  const outside = notGenerated(ROOT, files);
  if (outside.length > 0) {
    console.log(
      `::error title=A phone generator changed a file not marked generated::${outside.join(", ")}. Mark it generated in .gitattributes or keep the generator to files that are.`,
    );
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  git(ROOT, ["add", "--", ...files]);
  writeFileSync(join(out, "regenerated.patch"), git(ROOT, ["diff", "--cached", "--binary"]));
  writeFileSync(join(out, "message.txt"), commitMessage(files));
  console.log(`The phone's generators changed ${files.length} file(s) on the batch: ${files.join(", ")}`);
  output(true);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
