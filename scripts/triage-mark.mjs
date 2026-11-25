/**
 * The triage mark (docs/public-ci.md, "Intake"). A maintainer's reply on an
 * issue or pull request may end with a hidden mark,
 * `<!-- infinitary-triage v1 disposition=<one of DISPOSITIONS> -->`, and this
 * applies that disposition: it sets its labels, takes "needs triage" off and
 * closes the item with GitHub's reason where the disposition closes it.
 *
 * Anyone can type the mark, so it acts only on a comment whose author can
 * write to the project, judged by GitHub's collaborator permission API. It
 * never reads the comment's author_association, because GitHub tells the
 * Actions token that an organization member whose membership is private is
 * only a contributor.
 *
 * One more rule moves the queue: when an item's own author replies while it
 * is labeled "waiting on author", the label comes off and "needs triage"
 * goes on, so the next round reads the answer.
 *
 * The workflow that runs it (triage-mark.yml) checks out only this project's
 * own copy of this file and intake-labels.mjs, never a pull request's code,
 * and reads the comment only as data.
 */

import { ACCEPTED, NEEDS_TRIAGE, RELEASED, removeLabel, WAITING } from "./intake-labels.mjs";

const MARK = /<!-- infinitary-triage v1 disposition=([a-z-]+)(?: [^>]*)?-->/;
const WRITERS = new Set(["admin", "write"]);

/**
 * What each disposition does: labels to add, and whether and why it closes.
 * Every one takes "needs triage" off, and every one that does not wait on
 * the author takes "waiting on author" off too.
 */
export const DISPOSITIONS = Object.freeze({
  duplicate: { add: ["duplicate"], close: "not_planned" },
  "needs-info": { add: [WAITING] },
  accepted: { add: [ACCEPTED] },
  declined: { add: [], close: "not_planned" },
  answered: { add: [], close: "completed" },
  "changes-requested": { add: [WAITING], pullOnly: true },
  // The intake round thanks an accepted issue's reporter at its work's first
  // release and closes it then, unless a change already closed it.
  released: { add: [RELEASED], close: "completed" },
});

/** The disposition a comment's mark names, or null for none or one not on the list. */
export function readMark(body) {
  const name = MARK.exec(String(body ?? ""))?.[1];
  return name && Object.hasOwn(DISPOSITIONS, name) ? name : null;
}

/** Whether an account can write to the project. */
async function canWrite({ github, owner, repo, login }) {
  if (!login) return false;
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: login,
  });
  return WRITERS.has(data.permission);
}

/**
 * Runs for one new comment, through actions/github-script's `github` client
 * and `context`.
 */
export async function applyMark({ github, context, core }) {
  const { owner, repo } = context.repo;
  const { issue, comment } = context.payload;
  if (!issue || !comment) return "no comment";
  const number = issue.number;
  const labels = new Set((issue.labels ?? []).map((label) => label.name));
  const isPull = Boolean(issue.pull_request);
  const add = (names) => {
    const missing = names.filter((name) => !labels.has(name));
    return missing.length > 0
      ? github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: missing })
      : undefined;
  };
  const remove = async (names) => {
    for (const name of names)
      if (labels.has(name)) await removeLabel({ github, owner, repo, number, name });
  };

  const disposition = readMark(comment.body);
  if (disposition && (await canWrite({ github, owner, repo, login: comment.user?.login }))) {
    const rule = DISPOSITIONS[disposition];
    if (rule.pullOnly && !isPull) {
      core.info(`"${disposition}" applies only to a pull request.`);
      return "not a pull request";
    }
    await remove([NEEDS_TRIAGE, ...(rule.add.includes(WAITING) ? [] : [WAITING])]);
    await add(rule.add);
    if (rule.close && issue.state === "open")
      await github.rest.issues.update({
        owner,
        repo,
        issue_number: number,
        state: "closed",
        // A pull request closes with no reason; GitHub keeps reasons for issues.
        ...(isPull ? {} : { state_reason: rule.close }),
      });
    return disposition;
  }

  if (issue.user?.id != null && comment.user?.id === issue.user.id && labels.has(WAITING)) {
    await remove([WAITING]);
    await add([NEEDS_TRIAGE]);
    return "author replied";
  }
  return disposition ? "not a maintainer" : "no mark";
}
