/**
 * The check each Linux package job makes of its downloaded copy before it
 * installs anything (docs/linux-packages.md, "The checks"). The build job
 * lists every file it hands those jobs in SHA256SUMS and passes the list on
 * as its `sums` output, so a job compares its copy with the build's own list,
 * never with a list that came down in the same download.
 *
 *   node scripts/linux-package-sums.ts check
 *     Environment: PACKAGES, the folder the copy is in; SUMS, the build's
 *     SHA256SUMS; ATTEMPT, `first` or `again`; FINISHED, the download step's
 *     download-path output, which actions/download-artifact sets only once
 *     every file arrived; GITHUB_OUTPUT.
 *
 * A whole copy writes `whole=true`. A damaged first copy is named in a
 * warning and removed, so the job fetches the packages again into an empty
 * folder; a damaged second copy fails the job, naming each file. Run
 * 42292187705's Ubuntu 24.04 container job is why: its download step stopped
 * partway and still reported success, and apt then failed on the cut-short
 * Ubuntu package with "Invalid archive member header".
 *
 * Plain Node 24 type stripping, no imports from the app.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SumsEntry = { sha256: string; file: string };

/** The list's own name in the folder, beside the files it names. */
const LIST = "SHA256SUMS";
/** One line of `sha256sum` output, text or binary mode. */
const LINE = /^([0-9a-f]{64}) [ *](.+)$/;

/** The entries of a SHA256SUMS list as `sha256sum` writes it; a line it cannot read throws. */
export function parseSums(text: string): SumsEntry[] {
  const entries = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = LINE.exec(line);
      if (!match) throw new Error(`the build's SHA256SUMS holds a line that is not a checksum: ${line}`);
      const [, sha256, file] = match as unknown as [string, string, string];
      if (isAbsolute(file) || file.split("/").includes(".."))
        throw new Error(`the build's SHA256SUMS names a file outside its folder: ${file}`);
      return { sha256, file };
    });
  if (entries.length === 0) throw new Error("the build passed no SHA256SUMS");
  return entries;
}

/** A file's SHA-256 in hex, read a piece at a time so a large AppImage never sits in memory whole. */
function sha256Of(path: string): string {
  const hash = createHash("sha256");
  const piece = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, piece); read > 0; read = readSync(fd, piece))
      hash.update(piece.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Each way the copy in `dir` differs from the build's list, one plain
 * sentence each, or none when every file the list names matches it. The
 * copy's own SHA256SUMS must be the build's list too.
 */
export function damage(dir: string, sums: string): string[] {
  const problems: string[] = [];
  for (const { sha256, file } of parseSums(sums)) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const found = sha256Of(path);
    if (found !== sha256)
      problems.push(
        `${file} differs: ${statSync(path).size} bytes with SHA-256 ${found}, where the build's is ${sha256}`,
      );
  }
  const list = join(dir, LIST);
  if (!existsSync(list)) problems.push(`${LIST} is missing`);
  else if (readFileSync(list, "utf8").trim() !== sums.trim())
    problems.push(`${LIST} differs from the build's list`);
  return problems;
}

/** A workflow command's message: GitHub reads one line, with `%`, CR and LF escaped. */
function command(level: "warning" | "error", title: string, message: string): string {
  const escape = (text: string) =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::${level} title=${escape(title).replaceAll(":", "%3A").replaceAll(",", "%2C")}::${escape(message)}`;
}

/** PACKAGES, SUMS, ATTEMPT, FINISHED and GITHUB_OUTPUT, as the action's step passes them. */
export type CheckEnv = Record<string, string | undefined>;

/** The `check` command: its exit code, with every line it prints passed to `log`. */
export function check(env: CheckEnv, log: (line: string) => void = console.log): number {
  const { PACKAGES: dir, SUMS: sums = "", ATTEMPT: attempt, FINISHED: finished = "" } = env;
  if (!dir || (attempt !== "first" && attempt !== "again")) {
    log(command("error", "Package check misused", "linux-package-sums.ts check needs PACKAGES, and ATTEMPT set to first or again."));
    return 1;
  }
  let problems: string[];
  try {
    problems = damage(dir, sums);
  } catch (error) {
    log(command("error", "No list to check the packages against", `This job cannot check its copy of the Linux packages: ${(error as Error).message}.`));
    return 1;
  }
  const output = (whole: boolean) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `whole=${whole}\n`);
  };
  if (problems.length === 0) {
    const files = parseSums(sums).map(({ file }) => file);
    log(`Every file of this copy matches the build's SHA256SUMS: ${[...files, LIST].join(", ")}.`);
    output(true);
    return 0;
  }
  const cause = finished
    ? "The download step finished, so the copy changed on its way here or on this machine's disk"
    : "The download step stopped before it finished: it sets its download path only once every file arrived, and it set none";
  const named = `${problems.join("; ")}. ${cause}.`;
  output(false);
  if (attempt === "first") {
    log(command("warning", "Damaged download, fetched again", `This job's copy of the Linux packages is not the one the build made: ${named} Nothing was installed from it; the job fetches the packages again.`));
    rmSync(dir, { recursive: true, force: true });
    return 0;
  }
  log(command("error", "Damaged download, twice", `This job's second copy of the Linux packages is not the one the build made either: ${named} Nothing was installed. The build listed these files as it made them, so the fault lies between the build and this job, not in the packages.`));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [name] = process.argv.slice(2);
  if (name !== "check") {
    console.error("usage: node scripts/linux-package-sums.ts check  (PACKAGES, SUMS, ATTEMPT, FINISHED from the environment)");
    process.exit(2);
  }
  process.exit(check(process.env));
}
