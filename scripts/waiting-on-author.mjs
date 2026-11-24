/**
 * The waiting-on-author timer (docs/public-ci.md, "Intake"). Once a day it
 * reads every open issue and pull request labeled "waiting on author":
 *
 * - REMIND_DAYS after it started waiting, it leaves one reminder;
 * - CLOSE_DAYS - REMIND_DAYS after that reminder, it closes the item with a
 *   note saying how to pick it up again.
 *
 * An item starts waiting at the later of the label's newest addition and its
 * author's newest comment, reopening or push, so anything the author does
 * starts the count again. It touches no item without the label.
 *
 * The workflow that runs it (waiting-on-author.yml) checks out only this
 * project's own copy of this file and intake-labels.mjs.
 */

import { WAITING } from "./intake-labels.mjs";

export const REMIND_DAYS = 14;
export const CLOSE_DAYS = 28;
const DAY = 24 * 60 * 60 * 1000;
const REMINDER_MARK = "<!-- waiting-on-author reminder -->";
const CLOSE_MARK = "<!-- waiting-on-author close -->";
const BOT = "github-actions[bot]";

const kind = (item) => (item.pull_request ? "pull request" : "issue");

export function reminderComment(item) {
  return [
    REMINDER_MARK,
    `@${item.user.login}, this ${kind(item)} is waiting on you: the newest reply above says what it needs. If nothing changes in the next ${CLOSE_DAYS - REMIND_DAYS} days, it closes on its own. Any reply from you puts it back in line for a maintainer.`,
  ].join("\n");
}

export function closeComment(item) {
  return [
    CLOSE_MARK,
    `This ${kind(item)} closes because it waited on its author for ${CLOSE_DAYS} days. Thank you for it. You are welcome to pick it up again: open a new ${kind(item)} that links this one.`,
  ].join("\n");
}

/** When an item started waiting, from its timeline, as milliseconds; null when the label's addition is not found. */
export function waitingSince(item, timeline) {
  const author = item.user?.id;
  const times = timeline.flatMap((event) => {
    if (event.event === "labeled" && event.label?.name === WAITING) return [event.created_at];
    if (event.event === "committed") return [event.committer?.date];
    const actor = event.actor ?? event.user;
    if (
      actor?.id === author &&
      ["commented", "reopened", "head_ref_force_pushed"].includes(event.event)
    )
      return [event.created_at];
    return [];
  });
  const labeled = timeline.some(
    (event) => event.event === "labeled" && event.label?.name === WAITING,
  );
  if (!labeled) return null;
  return Math.max(...times.map((time) => Date.parse(time)).filter(Number.isFinite));
}

/** When the timer last reminded the item since `since`, as milliseconds, or null. */
function remindedAt(timeline, since) {
  const times = timeline
    .filter(
      (event) =>
        event.event === "commented" &&
        (event.actor ?? event.user)?.login === BOT &&
        event.body?.startsWith(REMINDER_MARK),
    )
    .map((event) => Date.parse(event.created_at))
    .filter((time) => time >= since);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Runs once, through actions/github-script's `github` client and `context`.
 * `now` is the moment the run judges ages against.
 */
export async function tick({ github, context, core, now = () => new Date() }) {
  const { owner, repo } = context.repo;
  const at = now().getTime();
  const items = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    labels: WAITING,
    per_page: 100,
  });
  const done = { reminded: [], closed: [] };
  for (const item of items) {
    const number = item.number;
    const timeline = await github.paginate(github.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    const since = waitingSince(item, timeline);
    if (since === null) continue;
    const reminded = remindedAt(timeline, since);
    if (reminded === null) {
      if (at - since < REMIND_DAYS * DAY) continue;
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: reminderComment(item),
      });
      done.reminded.push(number);
      continue;
    }
    if (at - reminded < (CLOSE_DAYS - REMIND_DAYS) * DAY) continue;
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: closeComment(item),
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      state: "closed",
      // A pull request closes with no reason; GitHub keeps reasons for issues.
      ...(item.pull_request ? {} : { state_reason: "not_planned" }),
    });
    done.closed.push(number);
  }
  const line = `Read ${items.length}; reminded ${done.reminded.length}${done.reminded.map((n) => ` #${n}`).join("")}; closed ${done.closed.length}${done.closed.map((n) => ` #${n}`).join("")}.`;
  core.info(line);
  return done;
}
