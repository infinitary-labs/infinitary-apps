/**
 * The Careful review check (docs/public-ci.md, "The Careful review check").
 * It sets one commit status, STATUS, on a pull request's newest commit:
 *
 * - a pull request from one of this project's own branches, the crew's and
 *   the merge batches', passes at once;
 * - an outside pull request passes when its description carries Infinitary's
 *   Careful record for its newest version (`readRecord`);
 * - otherwise it fails and keeps one comment, edited in place, saying how to
 *   raise the pull request with Infinitary at the Careful rigor level.
 *
 * The record is the one Infinitary writes at the end of a pull request's
 * story once an independent review passed and live validation the review
 * accepted cover that version (src/core/forge/pipelineAttestation.ts): no-mistakes'
 * signature line and v1 attestation, with `producer` "infinitary" and a
 * `live_validation` object. no-mistakes writes `live_validation` too but no
 * `producer`, so `producer` tells the two records apart. The author can type
 * it by hand, so the check is a guardrail for contributors, never a proof
 * that a review happened; the guards stay GitHub's approval of each outside
 * run and the fork guard on the project's own runners.
 *
 * It reads the description and newest version live from GitHub's API, never
 * from the event, since a rerun replays its first event's payload. Started by
 * hand with a pull request number it reads any pull request of the project;
 * on one of the project's own it writes only the job summary, so the reading
 * can be proved there without touching that pull request's status.
 *
 * The workflow that runs it (careful-review-check.yml) checks out only this
 * project's own copy of this file, never the pull request's code, and reads
 * the description only as data.
 */

export const STATUS = "PR raised with Infinitary's Careful review";
/** no-mistakes' own markers, byte for byte, as src/core/forge/pipelineAttestation.ts writes them. */
export const SIGNATURE =
  "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
export const RECORD_PREFIX = "<!-- no-mistakes-pipeline-attestation:v1 ";
const RECORD_CLOSING = " -->";
const REQUIRED_STEPS = ["review", "test", "document"];
const MARK = "<!-- careful-review-check -->";
/** The account the workflow's token writes as, the only author of the check's comment. */
const BOT = "github-actions[bot]";

/**
 * Why a description's record does not pass, as one short status line and a
 * sentence for the comment. GitHub cuts a status description at 140 characters.
 */
const PROBLEMS = {
  "no record": {
    status: "No Careful record: raise this pull request with Infinitary at the Careful rigor level.",
    sentence: "the description carries no Careful record.",
  },
  unreadable: {
    status: "The description's record cannot be read: raise it with Infinitary at the Careful rigor level.",
    sentence: "the description's record cannot be read.",
  },
  "another version": {
    status: "The Careful record is for another version; it must name this pull request's newest version.",
    sentence: null,
  },
  "steps incomplete": {
    status: "The record does not mark review, test and document all completed.",
    sentence: "the record does not mark review, test and document all completed.",
  },
  "not careful": {
    status: "The record is not Infinitary's Careful record with live validation.",
    sentence:
      "the record is not Infinitary's Careful record: this project takes only the record Infinitary writes with its live validation.",
  },
};

/**
 * The verdict on one description at one version, as no-mistakes' own check
 * reads its record, plus Infinitary's producer and live validation: the
 * signature line, then the first record, which must parse, be Infinitary's
 * with its live validation, name `head`, and mark review, test and document
 * completed, a later entry for a step replacing an earlier one. The producer
 * is read before the version, so a contributor holding another tool's record
 * hears first that only Infinitary's counts. Returns `{ok: true, live}` or
 * `{ok: false, problem, named}`.
 */
export function readRecord(body, head) {
  const text = String(body ?? "");
  if (!text.includes(SIGNATURE)) return { ok: false, problem: "no record" };
  const start = text.indexOf(RECORD_PREFIX);
  if (start < 0) return { ok: false, problem: "no record" };
  const from = start + RECORD_PREFIX.length;
  const end = text.indexOf(RECORD_CLOSING, from);
  if (end < 0) return { ok: false, problem: "unreadable" };
  let record;
  try {
    record = JSON.parse(text.slice(from, end));
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record.head_sha !== "string" ||
    !Array.isArray(record.steps)
  )
    return { ok: false, problem: "unreadable" };
  const live = record.live_validation;
  const count = (value) => Number.isInteger(value) && value >= 0;
  if (
    record.producer !== "infinitary" ||
    !live ||
    typeof live !== "object" ||
    typeof live.verdict !== "string" ||
    !live.verdict ||
    !count(live.live) ||
    !count(live.total)
  )
    return { ok: false, problem: "not careful" };
  if (!record.head_sha || record.head_sha !== head)
    return { ok: false, problem: "another version", named: record.head_sha };
  const statuses = new Map();
  for (const item of record.steps) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.step !== "string" ||
      !item.step ||
      typeof item.status !== "string"
    )
      return { ok: false, problem: "unreadable" };
    statuses.set(item.step, item.status);
  }
  if (REQUIRED_STEPS.some((step) => statuses.get(step) !== "completed"))
    return { ok: false, problem: "steps incomplete" };
  // The verdict is the author's text, shown in the status and the rendered job
  // summary, so only letters and hyphens are kept, as `version` keeps a hash's.
  const verdict = live.verdict.replace(/[^A-Za-z-]/g, "");
  if (!verdict) return { ok: false, problem: "not careful" };
  return { ok: true, live: { verdict, live: live.live, total: live.total } };
}

/** A version as inert Markdown: only its first twelve hexadecimal characters, in a code span. */
const version = (sha) => `\`${String(sha ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 12) || "none"}\``;

/** The status line for a verdict, at most 140 characters. */
export function statusLine(verdict) {
  const line = verdict.ok
    ? `Infinitary's Careful record covers this version: live validation ${verdict.live.verdict}, ${verdict.live.live} of ${verdict.live.total} passed live.`
    : PROBLEMS[verdict.problem].status;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** The one comment a failing outside pull request gets, kept up to date. */
export function failureComment(verdict, head, guideUrl) {
  const why =
    PROBLEMS[verdict.problem].sentence ??
    `the record names version ${version(verdict.named)}, but this pull request's newest version is ${version(head)}.`;
  return [
    MARK,
    `This project merges an outside pull request only when it was raised with Infinitary at the Careful rigor level: an independent review, and live validation that the review accepted, of the pull request's newest version. Infinitary then writes a record at the end of the description, and the "${STATUS}" check reads it.`,
    "",
    `The check did not pass: ${why}`,
    "",
    "To pass it:",
    "",
    "- open the pull request from your own copy of the project with Infinitary at the Careful rigor level, so Infinitary writes its story and record into the description;",
    "- after each later push, let Infinitary review and validate that version too, so the record names it.",
    "",
    `[How to contribute](${guideUrl}) says more.`,
  ].join("\n");
}

/** What the comment says once a later version passes. */
export const PASSED_COMMENT = `${MARK}\nThe newest version carries Infinitary's Careful record, so the "${STATUS}" check passes.`;

/**
 * Runs the check for one event, through actions/github-script's `github`
 * client and `context`. A hand-started run names its pull request in
 * `pullNumber`.
 */
export async function check({ github, context, core, pullNumber }) {
  const { owner, repo } = context.repo;
  const project = `${owner}/${repo}`;
  const byHand = context.eventName === "workflow_dispatch";
  const number = byHand ? Number(pullNumber) : context.payload.pull_request?.number;
  if (!Number.isInteger(number) || number <= 0) {
    core.setFailed(`No pull request number: ${JSON.stringify(pullNumber ?? null)}`);
    return "no pull request";
  }
  const guideUrl = `${context.serverUrl ?? "https://github.com"}/${project}/blob/${
    context.payload.repository?.default_branch ?? "main"
  }/CONTRIBUTING.md#infinitarys-careful-review`;
  const pull = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
  const head = pull.head.sha;
  const own = pull.head.repo?.full_name === project;
  const status = (state, description) =>
    github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: head,
      state,
      context: STATUS,
      description,
      target_url: guideUrl,
    });

  if (own && !byHand) {
    await status("success", "A pull request from this project's own branch needs no record.");
    return "own branch";
  }
  const verdict = readRecord(pull.body, head);
  const outcome = verdict.ok ? "passed" : `failed: ${verdict.problem}`;
  core.summary.addRaw(`#${number} at ${version(head)}: ${statusLine(verdict)}\n`);
  await core.summary.write();
  if (own) return `read ${outcome}`;

  const comment = (
    await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    })
  ).find((each) => each.user?.login === BOT && each.body?.startsWith(MARK));
  const write = async (body) => {
    if (comment?.body === body) return;
    if (comment)
      await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
    else await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  };
  if (verdict.ok) {
    if (comment) await write(PASSED_COMMENT);
    await status("success", statusLine(verdict));
  } else {
    await write(failureComment(verdict, head, guideUrl));
    await status("failure", statusLine(verdict));
  }
  return outcome;
}
