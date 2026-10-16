/**
 * A task's repository on the host, and its private GitHub mirror.
 *
 * The source is the task image's own `/app`, never the upstream repository:
 * DeepSWE's image build checks the default branch out AT the base commit and
 * garbage-collects every later commit and tag, so the reference solution
 * cannot leak from history. `exportBundle` packs that repository once into a
 * git bundle under the pool; a checkout (the crewmate's repository for the
 * Quick and Default arms) and a mirror (the Careful arm's pull-request
 * target) are both made from it.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execIn, removeContainer, startTaskContainer } from "./containers.ts";
import { type BenchTask, benchDir, git } from "./pool.ts";

export function bundlePath(task: BenchTask): string {
  return join(benchDir(), "repos", `${task.id}.bundle`);
}

/** Packs the task image's `/app` repository (every ref) into a bundle, once. */
export async function exportBundle(task: BenchTask): Promise<string> {
  const bundle = bundlePath(task);
  if (existsSync(bundle)) return bundle;
  const out = join(benchDir(), "repos", `.export-${randomBytes(4).toString("hex")}`);
  mkdirSync(out, { recursive: true });
  const name = `fmb-x-${randomBytes(4).toString("hex")}`;
  await startTaskContainer({
    name,
    task,
    role: "export",
    mounts: [{ host: out, container: "/out" }],
  });
  try {
    let stderr = "";
    const run = await execIn({
      name,
      argv: [
        "bash",
        "-c",
        "git -c safe.directory=/app -C /app bundle create /out/repo.bundle --all",
      ],
      stderr: (chunk) => {
        stderr += chunk.toString();
      },
    });
    if (run.code !== 0) throw new Error(`exporting ${task.id} failed: ${stderr.trim()}`);
    renameSync(join(out, "repo.bundle"), bundle);
    return bundle;
  } finally {
    removeContainer(name);
    rmSync(out, { recursive: true, force: true });
  }
}

/** The branch the image checked out at the base commit (the repository's default). */
export function defaultBranch(bundle: string): string {
  const heads = git(benchDir(), ["bundle", "list-heads", bundle]);
  const head = heads.match(/^[0-9a-f]+ HEAD$/m)?.[0].split(" ")[0];
  const branch = heads
    .split("\n")
    .map((line) => line.split(" "))
    .find(([sha, ref]) => sha === head && ref?.startsWith("refs/heads/"))?.[1];
  if (!branch) throw new Error(`${bundle} has no branch at HEAD`);
  return branch.slice("refs/heads/".length);
}

/**
 * Clones the task's repository to `dest`, at the base commit on its default
 * branch, with no remote. This is the host repository a crewmate works in.
 */
export async function checkoutTask(task: BenchTask, dest: string): Promise<string> {
  const target = resolve(dest);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const bundle = await exportBundle(task);
  git(benchDir(), ["clone", "--quiet", bundle, target]);
  git(target, ["remote", "remove", "origin"]);
  const head = git(target, ["rev-parse", "HEAD"]).trim();
  if (head !== task.baseCommit) {
    throw new Error(`${task.id}: the image's HEAD is ${head}, not base ${task.baseCommit}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Mirrors
// ---------------------------------------------------------------------------

/**
 * The mirror's repository name: the upstream repository's own name and a
 * short hash of the task id, e.g. `tomlkit-5c1f0a`. Neither the name nor
 * the description names the benchmark or the task: the crewmate working in
 * the mirror sees both, and a task id leads straight to the public task
 * repository and its hidden tests.
 */
export function mirrorName(task: BenchTask): string {
  const upstream = task.repositoryUrl
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .at(-1);
  const hash = createHash("sha256").update(task.id).digest("hex").slice(0, 6);
  return `${upstream}-${hash}`;
}

function gh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

type RepoView = { private: boolean; html_url: string; ssh_url: string; clone_url: string };

function viewRepo(fullName: string): RepoView | null {
  const result = spawnSync("gh", ["api", `repos/${fullName}`], { encoding: "utf8" });
  if (result.status !== 0) {
    if (/Not Found|HTTP 404/.test(result.stderr)) return null;
    throw new Error(`gh api repos/${fullName} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as RepoView;
}

export type Mirror = { url: string; fullName: string; branch: string; baseCommit: string };

/**
 * Opens the task's private GitHub mirror, `<owner>/<mirrorName>`:
 * the image's repository pushed at the base commit on its default branch,
 * with Actions disabled before the first push (the arm's evidence is the
 * local gate, and a mirror must never spend the owner's CI minutes), and
 * issues, wiki and projects off. Re-running on an existing mirror checks it
 * is private and at the base commit and changes nothing.
 */
export async function openMirror(task: BenchTask, owner?: string): Promise<Mirror> {
  const login = owner ?? gh(["api", "user", "--jq", ".login"]).trim();
  const fullName = `${login}/${mirrorName(task)}`;
  const bundle = await exportBundle(task);
  const branch = defaultBranch(bundle);
  let repo = viewRepo(fullName);
  if (repo && !repo.private)
    throw new Error(`${fullName} exists and is public; refusing to use it`);
  if (!repo) {
    const self = gh(["api", "user", "--jq", ".login"]).trim();
    const endpoint = login === self ? "user/repos" : `orgs/${login}/repos`;
    repo = JSON.parse(
      gh([
        "api",
        "--method",
        "POST",
        endpoint,
        "-f",
        `name=${mirrorName(task)}`,
        "-f",
        `description=Private mirror of ${task.repositoryUrl} at ${task.baseCommit.slice(0, 12)}`,
        "-F",
        "private=true",
        "-F",
        "has_issues=false",
        "-F",
        "has_wiki=false",
        "-F",
        "has_projects=false",
      ]),
    ) as RepoView;
    if (!repo.private) throw new Error(`${fullName} was created public; delete it by hand`);
  }
  gh(["api", "--method", "PUT", `repos/${fullName}/actions/permissions`, "-F", "enabled=false"]);

  const protocol = spawnSync("gh", ["config", "get", "git_protocol"], { encoding: "utf8" });
  const remote = protocol.stdout.trim() === "ssh" ? repo.ssh_url : repo.clone_url;
  const scratch = mkdtempSync(join(tmpdir(), "infinitary-bench-mirror-"));
  try {
    const clone = join(scratch, "repo");
    git(scratch, ["clone", "--quiet", "--bare", bundle, clone]);
    const remoteHead = git(clone, ["ls-remote", remote, `refs/heads/${branch}`]).split("\t")[0];
    if (remoteHead && remoteHead !== task.baseCommit) {
      throw new Error(`${fullName} ${branch} is at ${remoteHead}, not base ${task.baseCommit}`);
    }
    if (!remoteHead)
      git(clone, ["push", "--quiet", remote, `${task.baseCommit}:refs/heads/${branch}`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  gh(["api", "--method", "PATCH", `repos/${fullName}`, "-f", `default_branch=${branch}`]);
  return { url: repo.html_url, fullName, branch, baseCommit: task.baseCommit };
}
