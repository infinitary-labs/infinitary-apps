import type { BatchChange, BatchMember } from "@shared/batches";
import { git, gitFailure, REMOTE_TIMEOUT_MS } from "../workspace/git";

/**
 * The combine of batches of your own (docs/forge.md, "Batches of your
 * own"): approved changes, in approval order, onto the freshly fetched
 * default branch, one commit per change. It runs in the project's own
 * folder with git's plumbing alone, so no file of that folder moves and
 * no branch of it changes; the fetched and written commits are kept under
 * `refs/infinitary/batch/`.
 */

const BASE_REF = "refs/infinitary/batch/base";
const CHANGE_REF = "refs/infinitary/batch/change";
const HEAD_REF = "refs/infinitary/batch/head";
const STACK_REF = "refs/infinitary/batch/stack";

/** Git's exit code for a merge it could not finish cleanly. */
const CONFLICT = 1;

/**
 * How a fetch or push goes where the project lives: git never waits on a
 * terminal nobody sees, and a remote that stops answering ends the call,
 * because every writer of the project's batch waits behind it.
 */
const network = (timeoutMs = REMOTE_TIMEOUT_MS) => ({
  env: { GIT_TERMINAL_PROMPT: "0" },
  timeoutMs,
});

/**
 * A branch that cannot be fetched reads as gone. A fetch the time limit
 * ended says nothing about the branch, so it fails the call instead: the
 * next pass reads again, and no change is left out for a slow remote.
 */
function unread(caught: unknown): null {
  if ((caught as { killed?: unknown }).killed === true) throw caught;
  return null;
}

export type CombineInput = {
  /** The project's folder at home. */
  repoDir: string;
  defaultBranch: string;
  /** The changes to combine, in approval order. */
  changes: readonly BatchChange[];
  /** The commits' date (epoch ms). */
  at: number;
  remote?: string;
  /** Bound on each fetch; a test shortens it. */
  timeoutMs?: number;
};

export type Combined = {
  /** The default branch's commit the batch was combined onto. */
  base: string;
  /** The batch's version: the last member's commit, or `base` when nothing combined. */
  head: string;
  members: BatchMember[];
  /** The changes that did not combine, each with why. */
  leftOut: { change: BatchChange; reason: string }[];
};

/** Why a change was left out, in words its crewmate reads. */
export const LEFT_OUT_WORDS = {
  moved:
    "its pushed branch is no longer at the approved version, so the batch could not carry what was approved",
  conflict:
    "it no longer combines with the default branch and the approved changes ahead of it in the batch",
  nothing: "it changes nothing on the default branch as it is now",
  stacked: (base: string) =>
    `it builds on ${base}, whose work is not merged or ahead of it in the batch, so the batch would carry work that was not approved with it`,
} as const;

/**
 * Fetch the default branch and each change's pushed branch, then write one
 * commit per change on top: the change's title as its subject and its
 * story's words as its body. A change that does not combine is left out
 * with its reason, and the rest go on.
 */
export async function combine(input: CombineInput): Promise<Combined> {
  const origin = input.remote ?? "origin";
  const fetch = (from: string, to: string) =>
    git(
      input.repoDir,
      ["fetch", "--quiet", "--no-tags", origin, `+refs/heads/${from}:${to}`],
      network(input.timeoutMs),
    );
  await fetch(input.defaultBranch, BASE_REF);
  const base = await git(input.repoDir, ["rev-parse", "--verify", `${BASE_REF}^{commit}`]);
  let head = base;
  const members: BatchMember[] = [];
  const leftOut: Combined["leftOut"] = [];
  for (const change of input.changes) {
    const fetched = await fetch(change.branch, CHANGE_REF)
      .then(() => git(input.repoDir, ["rev-parse", "--verify", `${CHANGE_REF}^{commit}`]))
      .catch(unread);
    if (fetched !== change.head) {
      leftOut.push({ change, reason: LEFT_OUT_WORDS.moved });
      continue;
    }
    if (change.base && !(await carries(input.repoDir, head, change.base, fetch))) {
      leftOut.push({ change, reason: LEFT_OUT_WORDS.stacked(change.base) });
      continue;
    }
    const tree = await mergedTree(input.repoDir, head, change.head);
    if (tree === null) {
      leftOut.push({ change, reason: LEFT_OUT_WORDS.conflict });
      continue;
    }
    if (tree === (await git(input.repoDir, ["rev-parse", `${head}^{tree}`]))) {
      leftOut.push({ change, reason: LEFT_OUT_WORDS.nothing });
      continue;
    }
    head = await commit(input.repoDir, tree, head, change, input.at);
    members.push({ ...change, commit: head });
  }
  // Kept until the next combine, so the written commits outlive a cleanup before their push.
  await git(input.repoDir, ["update-ref", HEAD_REF, head]);
  return { base, head, members, leftOut };
}

/**
 * Whether `head` already holds everything `branch` carries where the
 * project lives: merging the branch onto it changes nothing. A branch that
 * cannot be read is not known to be carried.
 */
async function carries(
  repoDir: string,
  head: string,
  branch: string,
  fetch: (from: string, to: string) => Promise<unknown>,
): Promise<boolean> {
  const base = await fetch(branch, STACK_REF)
    .then(() => git(repoDir, ["rev-parse", "--verify", `${STACK_REF}^{commit}`]))
    .catch(unread);
  if (base === null) return false;
  const tree = await mergedTree(repoDir, head, base);
  return tree !== null && tree === (await git(repoDir, ["rev-parse", `${head}^{tree}`]));
}

/** The tree of `theirs` merged onto `ours`; null when they do not combine. */
async function mergedTree(repoDir: string, ours: string, theirs: string): Promise<string | null> {
  try {
    return await git(repoDir, ["merge-tree", "--write-tree", "--no-messages", ours, theirs]);
  } catch (caught) {
    if ((caught as { code?: unknown }).code === CONFLICT) return null;
    throw caught;
  }
}

/** One commit for a change, under the name its own last commit carries. */
async function commit(
  repoDir: string,
  tree: string,
  parent: string,
  change: BatchChange,
  at: number,
): Promise<string> {
  const [name = "", email = ""] = (
    await git(repoDir, ["log", "-1", "--format=%an%n%ae", change.head])
  ).split("\n");
  const date = `${Math.floor(at / 1000)} +0000`;
  const message = change.body.trim() ? `${change.title}\n\n${change.body.trim()}\n` : change.title;
  return git(repoDir, ["commit-tree", tree, "-p", parent, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    },
  });
}

/**
 * Push the combined version to the batch branch the app owns. `expected`
 * is the version the branch is at where the project lives, as the app last
 * pushed it or just read it, or null for a new branch: a branch that moved
 * since then is refused, and the next pass reads it again.
 */
export async function pushBatch(input: {
  repoDir: string;
  branch: string;
  head: string;
  expected: string | null;
  remote?: string;
  /** Bound on the push; a test shortens it. */
  timeoutMs?: number;
}): Promise<void> {
  await git(
    input.repoDir,
    [
      "push",
      "--quiet",
      `--force-with-lease=refs/heads/${input.branch}:${input.expected ?? ""}`,
      input.remote ?? "origin",
      `${input.head}:refs/heads/${input.branch}`,
    ],
    network(input.timeoutMs),
  );
}

/**
 * Each member's own commit on the default branch after its batch merged.
 * A merge that kept the batch's commits answers them as they were written;
 * a rebase merge wrote new ones, read as the last commits of the default
 * branch up to the merge, in the batch's order, each matched by its title.
 * A commit that cannot be read stays undefined, never guessed.
 */
export async function landedCommits(input: {
  repoDir: string;
  defaultBranch: string;
  members: readonly BatchMember[];
  /** The commit the host says the merge wrote. */
  merged?: string;
  remote?: string;
  /** Bound on the fetch; a test shortens it. */
  timeoutMs?: number;
}): Promise<Map<string, string | undefined>> {
  const landed = new Map<string, string | undefined>();
  for (const member of input.members) landed.set(member.taskId, undefined);
  try {
    await git(
      input.repoDir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remote ?? "origin",
        `+refs/heads/${input.defaultBranch}:${BASE_REF}`,
      ],
      network(input.timeoutMs),
    );
    const tip = await git(input.repoDir, ["rev-parse", "--verify", `${BASE_REF}^{commit}`]);
    const kept = await Promise.all(
      input.members.map((member) =>
        git(input.repoDir, ["merge-base", "--is-ancestor", member.commit, tip]).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (kept.every(Boolean)) {
      for (const member of input.members) landed.set(member.taskId, member.commit);
      return landed;
    }
    const end = input.merged ?? tip;
    const rewritten = (
      await git(input.repoDir, [
        "rev-list",
        "--first-parent",
        "-n",
        String(input.members.length),
        end,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .reverse();
    if (rewritten.length !== input.members.length) return landed;
    for (const [index, member] of input.members.entries()) {
      const sha = rewritten[index] as string;
      const subject = await git(input.repoDir, ["log", "-1", "--format=%s", sha]);
      if (subject === member.title) landed.set(member.taskId, sha);
    }
  } catch (caught) {
    console.warn(`[batches] reading the merged commits: ${gitFailure(caught)}`);
  }
  return landed;
}
