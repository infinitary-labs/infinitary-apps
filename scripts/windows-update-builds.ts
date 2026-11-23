import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDesktopPath } from "./desktop-build.ts";

/**
 * Whether the Windows update check can reuse an earlier run's four test
 * installers instead of building them again (docs/windows.md, "Reusing the
 * test versions"). The installers are made only from the app's code, the
 * Windows installer's config, the test versions' release source and the
 * build job's own steps, so a run whose inputs all match an earlier run's
 * would build the same four installers.
 *
 *   node scripts/windows-update-builds.ts   (windows.yml's build job, update check only)
 *
 * Plain Node with no install. It prints the inputs' key and, when an earlier
 * run kept installers under that key, which run; it writes `key=` and `run=`
 * (empty when the build runs) to $GITHUB_OUTPUT when that is set. A lookup
 * that fails builds.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/windows.yml";

/** The artifact a build of the update check keeps its four installers in, named by its inputs' key. */
export const INSTALLERS_PREFIX = "windows-update-installers-";

/** What the test installers hold beyond the desktop app's own build list. */
const WINDOWS_INPUTS = [
  "electron-builder.win.yml",
  "scripts/windows-update-source.ts",
  "tests/windows/updateVersions.ts",
];

/**
 * The build job's own lines in windows.yml: from its key to the next job's.
 * The other jobs install and check what it built and change nothing in it.
 */
export function buildJob(workflow: string): string {
  // A Windows checkout turns each line ending into CRLF; the key reads the text as git keeps it.
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf("  build:");
  if (start < 0) throw new Error(`${WORKFLOW} has no build job`);
  const end = lines.findIndex((line, at) => at > start && /^ {2}[\w-]+:\s*$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function buildActions(job: string): string[] {
  return [...new Set([...job.matchAll(/uses:\s*\.\/(\.github\/actions\/[\w-]+)/g)].map((m) => `${m[1]}/`))];
}

/** One tracked file, as `git ls-files -s` names it: its path and its content's object id. */
export type TrackedFile = { path: string; object: string };

/**
 * The key of everything the test installers are built from: each input
 * file's path and content, and the build job's text. Two checkouts with the
 * same key build the same four installers.
 */
export function inputsKey(files: readonly TrackedFile[], workflow: string): string {
  const job = buildJob(workflow);
  const actions = buildActions(job);
  const inputs = files
    .filter(
      ({ path }) =>
        isDesktopPath(path) || WINDOWS_INPUTS.includes(path) || actions.some((folder) => path.startsWith(folder)),
    )
    .map(({ path, object }) => `${object} ${path}`)
    .sort();
  const hash = createHash("sha256");
  hash.update(`${inputs.join("\n")}\n--- build job\n${job}\n`);
  return hash.digest("hex").slice(0, 40);
}

function trackedFiles(root: string): TrackedFile[] {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta, path] = entry.split("\t") as [string, string];
      return { path, object: meta.split(" ")[1] as string };
    });
}

/** An artifact as GitHub's list of a repository's artifacts gives it, with what is read here. */
export type ListedArtifact = {
  name: string;
  expired: boolean;
  expires_at: string | null;
  created_at: string | null;
  workflow_run?: { id: number; repository_id: number; head_repository_id: number } | null;
};

/** A run as GitHub's read of one workflow run gives it, with what is read here. */
export type ReadRun = { id: number; path: string; event: string; repository: { id: number } };

/**
 * The newest earlier run whose kept installers this run may take: an
 * artifact under this key, not expiring before this run's update jobs can
 * have read it (`until`), from a run of this project's own windows.yml that
 * someone with write access asked for. A pull request from another project
 * can run its own workflow here and keep an artifact under any name, so the
 * name alone is never trusted.
 */
export async function earlierRun(
  key: string,
  artifacts: readonly ListedArtifact[],
  readRun: (id: number) => Promise<ReadRun>,
  now: Date,
  until: number,
  currentRun: number,
): Promise<number | null> {
  const candidates = artifacts
    .filter((artifact) => artifact.name === `${INSTALLERS_PREFIX}${key}` && !artifact.expired)
    .filter((artifact) => artifact.expires_at !== null && Date.parse(artifact.expires_at) - now.getTime() > until)
    .filter(
      (artifact) =>
        artifact.workflow_run &&
        artifact.workflow_run.id !== currentRun &&
        artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id,
    )
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
  for (const artifact of candidates) {
    const run = await readRun(artifact.workflow_run!.id);
    if (
      run.path.split("@")[0] === WORKFLOW &&
      run.event === "workflow_dispatch" &&
      run.repository.id === artifact.workflow_run!.repository_id
    ) {
      return run.id;
    }
  }
  return null;
}

/**
 * How long a reused artifact must still be kept: each update job's own
 * time limit in windows.yml (60 minutes) for each job the run may start one
 * after another, two channels per round, and one more for the build's queue.
 */
export function keptFor(rounds: number): number {
  return (2 * rounds + 1) * 60 * 60 * 1000;
}

async function github<T>(path: string): Promise<T> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${path}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const key = inputsKey(trackedFiles(ROOT), readFileSync(join(ROOT, WORKFLOW), "utf8"));
  let run: number | null = null;
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
    const listed = await github<{ artifacts: ListedArtifact[] }>(
      `/repos/${repository}/actions/artifacts?name=${INSTALLERS_PREFIX}${key}&per_page=100`,
    );
    const rounds = Number(process.env.ROUNDS || "1");
    run = await earlierRun(
      key,
      listed.artifacts,
      (id) => github<ReadRun>(`/repos/${repository}/actions/runs/${id}`),
      new Date(),
      keptFor(Number.isInteger(rounds) && rounds > 0 ? rounds : 1),
      Number(process.env.GITHUB_RUN_ID || "0"),
    );
  } catch (error) {
    console.log(`Could not look for earlier test installers (${(error as Error).message}); this run builds them.`);
  }
  console.log(
    run === null
      ? `No earlier run kept test installers for inputs ${key}; this run builds them.`
      : `Run ${run} built the test installers from the same app code, installer config and build steps (inputs ${key}); this run takes them.`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\nrun=${run ?? ""}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
