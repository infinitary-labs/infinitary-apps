/**
 * The labels that sort outside issues and pull requests (docs/public-ci.md,
 * "Intake"), and the one rule the two required checks share for "waiting on
 * author": a pull request waits on its author while either check fails, and
 * goes back to triage once both pass.
 *
 * The workflows that run this (contributor-agreement.yml,
 * careful-review-check.yml) check out only this project's own copy of this
 * file, never the pull request's code.
 */

export const NEEDS_TRIAGE = "needs triage";
export const WAITING = "waiting on author";
export const ACCEPTED = "accepted";
/** On an issue whose fix a release holds, once its reporter was thanked; it closes nothing. */
export const RELEASED = "released";

/** The commit statuses main's branch rule requires of an outside pull request. */
export const REQUIRED = Object.freeze([
  "Contributor License Agreement",
  "PR raised with Infinitary's Careful review",
]);

/**
 * Takes a label off an item. The other required check may run at the same
 * time and take it off first, which GitHub answers with 404; the label is
 * off either way.
 */
export async function removeLabel({ github, owner, repo, number, name }) {
  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
}

/** The state of each REQUIRED status on one commit, in REQUIRED's order; undefined until it writes one. */
export async function requiredStates({ github, owner, repo, sha }) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    owner,
    repo,
    ref: sha,
    per_page: 100,
  });
  // GitHub lists a commit's statuses newest first; the first of each name is its state.
  return REQUIRED.map((name) => statuses.find((each) => each.context === name)?.state);
}

/**
 * Sets "waiting on author" on an outside pull request from the required
 * statuses on its newest version, after a check wrote its own:
 *
 * - either failed: the label is added;
 * - both passed, the label is on and the event is the author's own (a push,
 *   an edit, a reopening or an acceptance): it comes off, and "needs
 *   triage" goes on, so the new version is read again;
 * - otherwise nothing changes: the other check has not written yet, or a
 *   maintainer's event left the label on.
 *
 * Only the author's own event takes the label off, so a maintainer's reply
 * asking for changes keeps it although both checks pass.
 *
 * Each check writes its status before calling this, so of two checks running
 * at once the later reader always sees both.
 */
export async function syncWaiting({ github, context, pullNumber }) {
  const { owner, repo } = context.repo;
  const number = Number(
    context.payload.pull_request?.number ?? context.payload.issue?.number ?? pullNumber,
  );
  if (!Number.isInteger(number) || number <= 0) return "no pull request";
  const pull = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
  if (pull.head.repo?.full_name === `${owner}/${repo}`) return "own branch";
  if (pull.state !== "open") return "closed";

  const states = await requiredStates({ github, owner, repo, sha: pull.head.sha });
  const labels = new Set((pull.labels ?? []).map((label) => label.name));

  if (states.some((each) => each === "failure" || each === "error")) {
    if (labels.has(WAITING)) return "still waiting";
    await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [WAITING] });
    return "waiting";
  }
  const byAuthor = context.payload.sender?.id === pull.user?.id;
  if (states.every((each) => each === "success") && labels.has(WAITING) && byAuthor) {
    await removeLabel({ github, owner, repo, number, name: WAITING });
    if (!labels.has(NEEDS_TRIAGE))
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: number,
        labels: [NEEDS_TRIAGE],
      });
    return "back to triage";
  }
  return "unchanged";
}
