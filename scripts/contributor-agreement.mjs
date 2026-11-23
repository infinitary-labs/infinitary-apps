/**
 * The contributor agreement check (`CLA.md`; docs/public-ci.md, "Outside
 * contributors"). It sets one commit status, "Contributor License Agreement",
 * on a pull request's newest commit:
 *
 * - a pull request from one of this project's own branches, the crew's and
 *   the merge batches', passes and is never asked;
 * - an outside pull request passes when its author's numeric GitHub id has
 *   accepted the agreement's current version, read from the record;
 * - otherwise the author accepts by ticking the template's box in the
 *   description or by replying with the sentence; the check writes one entry
 *   to the record and passes;
 * - otherwise it fails and posts one comment saying how to accept.
 *
 * The record is a locked issue of this project titled RECORD_TITLE, opened
 * by an account that can write to the project. Each entry is a comment the
 * check writes there, read back only from the Actions bot, so a comment by
 * anyone else adds no one. The agreement's version is `CLA.md`'s
 * "Version N" line, so a new version asks everyone again.
 *
 * It reads the contributor's words only as data, and the workflow that runs
 * it (contributor-agreement.yml) checks out only this project's own copy of
 * this file and `CLA.md`, never the pull request's code.
 */

export const STATUS = "Contributor License Agreement";
export const RECORD_TITLE = "Contributor License Agreement record";
export const SENTENCE = "I agree that my submission is governed by the Contributor License Agreement";
/** The account the workflow's token writes as, the only author of record entries. */
export const BOT = "github-actions[bot]";
const ASK_MARK = "<!-- contributor-license-agreement:ask -->";
const ENTRY = /<!-- contributor-license-agreement:entry (\{.*\}) -->/;
/**
 * Who may have opened the record issue: an account whose permission on the
 * project is one of these, GitHub's legacy roles, where maintain reads as
 * write.
 */
const KEEPERS = new Set(["admin", "write"]);

/** The agreement's version, from its "Version N" line. */
export function agreementVersion(text) {
  const match = /^Version (\d+)$/m.exec(text);
  if (!match) throw new Error('CLA.md has no "Version N" line');
  return Number(match[1]);
}

/** A comment's words as one line: links read as their words, spaces folded, case and a final period ignored. */
function plain(words) {
  return String(words ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

/** Whether a reply is the sentence, and nothing else. */
export const isAcceptance = (body) => plain(body) === SENTENCE.toLowerCase();

/** Whether a description carries the template's box, ticked. */
export function hasTickedBox(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .some((line) => {
      const box = /^\s*[-*]\s+\[[xX]\]\s+(.*)$/.exec(line);
      return box ? plain(box[1]) === SENTENCE.toLowerCase() : false;
    });
}

/** The entries the bot wrote to the record, oldest first. */
export function readEntries(comments) {
  return comments.flatMap((comment) => {
    if (comment.user?.login !== BOT || comment.user?.type !== "Bot") return [];
    const match = ENTRY.exec(comment.body ?? "");
    if (!match) return [];
    try {
      return [JSON.parse(match[1])];
    } catch {
      return [];
    }
  });
}

/** One record entry, in words a reader of the issue follows and with its data for the check. */
export function entryComment(entry) {
  return [
    `**${entry.login}** accepted the Contributor License Agreement, version ${entry.version}.`,
    "",
    `- GitHub id: ${entry.id}`,
    `- Pull request: #${entry.pull}`,
    `- Accepted in: ${entry.link}`,
    `- Time: ${entry.at}`,
    "",
    `<!-- contributor-license-agreement:entry ${JSON.stringify(entry)} -->`,
  ].join("\n");
}

/** The one comment an outside pull request gets until its author accepts. */
export function askComment(agreementUrl) {
  return [
    ASK_MARK,
    `Thank you for your pull request. Before it can be merged, please accept the [Contributor License Agreement](${agreementUrl}), once for this and every later contribution:`,
    "",
    "- tick the box at the end of your pull request's description, or",
    "- reply to this pull request with exactly this sentence:",
    "",
    `> I agree that my submission is governed by the [Contributor License Agreement](${agreementUrl})`,
    "",
    "Only the pull request's author can accept. The check records your GitHub account and passes.",
  ].join("\n");
}

/**
 * Runs the check for one event, through actions/github-script's `github`
 * client and `context`. `agreement` is `CLA.md`'s text from this project's
 * own default branch; `now` stamps a new entry.
 */
export async function check({ github, context, core, agreement, now = () => new Date() }) {
  const { owner, repo } = context.repo;
  const project = `${owner}/${repo}`;
  const version = agreementVersion(agreement);
  const agreementUrl = `${context.serverUrl ?? "https://github.com"}/${project}/blob/${
    context.payload.repository?.default_branch ?? "main"
  }/CLA.md`;
  const comment = context.eventName === "issue_comment" ? context.payload.comment : null;

  let pull = context.payload.pull_request;
  if (comment) {
    if (!context.payload.issue?.pull_request) return "not a pull request";
    pull = (await github.rest.pulls.get({ owner, repo, pull_number: context.payload.issue.number }))
      .data;
  }
  const status = (state, description, target_url = agreementUrl) =>
    github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pull.head.sha,
      state,
      context: STATUS,
      description,
      target_url,
    });

  if (pull.head.repo?.full_name === project) {
    await status("success", "A pull request from this project's own branch needs no agreement.");
    return "own branch";
  }

  const author = pull.user;
  const record = await findRecord({ github, owner, repo });
  if (!record) {
    const why = `No locked issue titled "${RECORD_TITLE}" opened by a maintainer holds the record.`;
    await status("error", why.slice(0, 140));
    core.setFailed(why);
    return "no record";
  }
  const entries = readEntries(
    await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: record.number,
      per_page: 100,
    }),
  );
  const accepted = (who) => entries.some((e) => e.id === who.id && e.version === version);
  if (accepted(author)) {
    await status("success", `${author.login} accepted version ${version}.`);
    return "accepted before";
  }

  // The author's own reply, or the author's own description with the box ticked.
  const link = comment
    ? comment.user?.id === author.id && isAcceptance(comment.body)
      ? comment.html_url
      : null
    : context.payload.sender?.id === author.id && hasTickedBox(pull.body)
      ? pull.html_url
      : null;
  if (link) {
    const entry = {
      login: author.login,
      id: author.id,
      pull: pull.number,
      link,
      version,
      at: now().toISOString(),
    };
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: record.number,
      body: entryComment(entry),
    });
    await status("success", `${author.login} accepted version ${version}.`);
    return "accepted now";
  }
  // Anyone else's reply, or any other words, changes nothing.
  if (comment) return "no acceptance";

  const asked = (
    await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pull.number,
      per_page: 100,
    })
  ).some((each) => each.user?.login === BOT && each.body?.includes(ASK_MARK));
  if (!asked)
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull.number,
      body: askComment(agreementUrl),
    });
  await status(
    "failure",
    "Not accepted yet: tick the box in the description, or reply with the sentence.",
  );
  return "asked";
}

/**
 * The record issue: the oldest locked issue with its exact title that a
 * maintainer opened. The opener is judged by their permission on the project,
 * never by the issue's author_association: GitHub reads an organization
 * member whose membership is private as a contributor to the Actions token.
 */
async function findRecord({ github, owner, repo }) {
  const { data } = await github.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue in:title "${RECORD_TITLE}"`,
    per_page: 100,
  });
  const candidates = data.items
    .filter((issue) => issue.title === RECORD_TITLE && issue.locked && !issue.pull_request)
    .toSorted((a, b) => a.number - b.number);
  for (const issue of candidates)
    if (await canWrite({ github, owner, repo, login: issue.user?.login })) return issue;
  return null;
}

/** Whether an account can write to the project; one GitHub no longer knows cannot. */
async function canWrite({ github, owner, repo, login }) {
  if (!login) return false;
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: login,
    });
    return KEEPERS.has(data.permission);
  } catch (error) {
    if (error?.status === 404) return false;
    throw error;
  }
}
