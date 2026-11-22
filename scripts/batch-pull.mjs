/** A batch pull request's run (docs/testing.md, "A batch pull request").
 *
 * A batch of your own is one pull request from a branch of this repository
 * whose name starts with infinitary-batch/, one commit per change.
 * batch-pull-request.yml runs the swept batch on its version, and its last
 * job names the tree it passed. This module holds what the readers of that
 * run share: main's sort (scripts/batch.mjs), the alpha's proof
 * (scripts/main-alpha-proof.mjs) and the run's own failure reader
 * (scripts/batch-failures.mjs).
 */

export const BATCH_BRANCH = "infinitary-batch/";

/** The workflow a batch pull request starts, as GitHub names a run's file. */
export const BATCH_PULL_RUN = ".github/workflows/batch-pull-request.yml";

/** What every job of the batch's checks starts with: the one job that calls batch-checks.yml. */
export const BATCH_PULL_CHECKS = "Merge batch · Batch checks / ";

/** What each confirm job's own name starts with, under the checks. */
export const BATCH_PULL_CONFIRM = "Merge batch · Confirm failed tests (";

/**
 * What each Linux test group's own confirm starts with, under the checks: it
 * runs in the sweep beside its group (verify.yml's linux-tests-confirm), as
 * `Confirm failed <the group's own name>`.
 */
export const BATCH_PULL_GROUP_CONFIRM = "Merge batch · Desktop checks / Merge batch · Confirm failed ";

/** Whether a job of the run, by its full name, is a confirm: the checks' own or a test group's. */
export const isConfirmJob = (name) =>
  name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_CONFIRM}`) ||
  name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_GROUP_CONFIRM}`);

/** Whether `pull` is a batch pull request of `repository` itself, never a fork's branch of that name. */
export const isBatchPull = (pull, repository) =>
  (pull.head?.ref ?? "").startsWith(BATCH_BRANCH) &&
  pull.head.repo?.full_name === repository &&
  pull.base?.repo?.full_name === repository;

/**
 * Whether `run` is a batch pull request's own run in `repository`: started by
 * a pull request from a batch branch of the repository itself.
 */
export const isBatchPullRun = (run, repository) =>
  run.path === BATCH_PULL_RUN &&
  run.event === "pull_request" &&
  (run.head_branch ?? "").startsWith(BATCH_BRANCH) &&
  run.head_repository?.full_name === repository &&
  run.repository?.full_name === repository;

// The checks' last job (batch-checks.yml) names the tree the batch's version
// holds and the main version the batch left main at.
const PASSED_JOB = /^Merge batch · Batch passed \(tree ([0-9a-f]{40,64}); base ([0-9a-f]{40,64})\)$/;

/** The tree a batch pull request's run passed, from its jobs, or null when its last job did not pass. */
export function batchPullTree(jobs) {
  for (const job of jobs) {
    if (!job.name.startsWith(BATCH_PULL_CHECKS) || job.status !== "completed" || job.conclusion !== "success")
      continue;
    const match = PASSED_JOB.exec(job.name.slice(BATCH_PULL_CHECKS.length));
    if (match) return match[1];
  }
  return null;
}

// Where the workflows and the actions they run live. A pull request's run
// reads them from the pull request's own version, so a batch that changes one
// its run reads chose its own check.
const CHECK_FILES = ".github/";

// A path under .github/ as a workflow or action names it: in a step's uses,
// such as ./.github/actions/pnpm or ./Application Support/firstmate/.github/actions/pnpm,
// in a sparse checkout, or in a command that runs a file there.
const CHECK_PATH = /\.github\/[\w.\/-]*[\w-]/g;

/**
 * The check files a batch pull request's own run reads, from every file
 * under .github/ at the batch's version (`checkFiles`, path to text): the
 * batch's workflow, and each workflow, action or other file under .github/
 * that a file it reads names outside a comment, read the same way in turn.
 * A named folder, such as an action's, counts with every file in it, and is
 * listed too, ending in a slash, so a file removed from it counts as well. It
 * reads what a run could reach, whether or not a job of that run started, so
 * a file it lists may have stayed unread, never the other way.
 */
export function batchRunCheckFiles(checkFiles, without) {
  const paths = [...checkFiles.keys()];
  const read = new Set();
  const folders = new Set();
  const queue = [BATCH_PULL_RUN];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === without || read.has(path) || !checkFiles.has(path)) continue;
    read.add(path);
    const text = checkFiles
      .get(path)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const [named] of text.matchAll(CHECK_PATH)) {
      const folder = `${named}/`;
      for (const candidate of paths) {
        if (candidate === named) queue.push(candidate);
        else if (candidate.startsWith(folder)) {
          folders.add(folder);
          queue.push(candidate);
        }
      }
    }
  }
  return new Set([...read, ...folders]);
}

// The Windows check's workflow: the batch's run starts it whenever the batch
// touches a file it is made of (scripts/windows-paths.ts), and nothing else of
// the run reads it.
const WINDOWS_CHECK = ".github/workflows/windows.yml";

/**
 * The check files only the Windows check drives: its workflow and the
 * actions that workflow uses by a step's `uses`, which no other file the
 * batch's run reads names. A batch that changes only these ran the Windows
 * check on its own version and chose no other part of its check, so main's
 * full check and the alpha's journeys have nothing to redo for it. A file the
 * workflow reaches only through a command, or one other workflows share, is
 * not listed.
 */
export function windowsOnlyCheckFiles(checkFiles) {
  const text = checkFiles.get(WINDOWS_CHECK);
  if (text === undefined) return new Set();
  const others = batchRunCheckFiles(checkFiles, WINDOWS_CHECK);
  const all = batchRunCheckFiles(checkFiles);
  const used = new Set(
    [...text.matchAll(/uses:\s*\.\/(\.github\/actions\/[\w-]+)/g)].map((use) => `${use[1]}/`),
  );
  const own = new Set();
  for (const path of all) {
    if (others.has(path)) continue;
    if (path === WINDOWS_CHECK || [...used].some((folder) => path === folder || path.startsWith(folder)))
      own.add(path);
  }
  return own;
}

/**
 * Whether a batch changed a file its own run reads, from the files its pull
 * request changed as GitHub lists them, the count GitHub gives for all of
 * them, and the check files its run reads (batchRunCheckFiles). A list GitHub
 * cut short may hide one, so it counts as changed. A file under .github/ the
 * run never reads, such as the release's workflow, chose nothing of the
 * batch's check, so main does not check the batch again for it.
 */
export function changedCheckFile(files, total, runCheckFiles, skipped = new Set()) {
  if (files.length < total) return true;
  return files.some((file) =>
    [file.filename, file.previous_filename].some(
      (path) =>
        path?.startsWith(CHECK_FILES) &&
        !skipped.has(path) &&
        (runCheckFiles.has(path) ||
          [...runCheckFiles].some((read) => read.endsWith("/") && path.startsWith(read))),
    ),
  );
}

/**
 * How main's check treats a push that merged a batch pull request, from the
 * pushed files' `tree`, the pull request's runs newest first, each with its
 * latest jobs, its changed `files` with their `total`, and every file under
 * .github/ in the pushed version (`checkFiles`, path to text):
 * - covered: a run passed on exactly these files and the batch changed no
 *   check file that run reads, so nothing runs again;
 * - full otherwise: main moved under the batch, no run passed, or the batch
 *   changed a file its own check is made of.
 * The pushed version is the batch's whenever a run passed on its tree, so
 * its check files are the ones that run read.
 */
export function sortBatchPull({ tree, runs, files, total, checkFiles }) {
  if (changedCheckFile(files, total, batchRunCheckFiles(checkFiles), windowsOnlyCheckFiles(checkFiles)))
    return { kind: "full" };
  const run = runs.find((candidate) => batchPullTree(candidate.jobs) === tree);
  return run ? { kind: "covered", run: run.id } : { kind: "full" };
}
