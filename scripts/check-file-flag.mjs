/**
 * The check-file flag (docs/public-ci.md, "Outside contributors"). A pull
 * request runs the check files it carries, so an outside one that edits them
 * can send itself to the project's own machines once its run is approved.
 * This marks such a pull request before anyone approves a run: it reads the
 * pull request's changed files from GitHub, matches them against
 * CHECK_FILES, and
 *
 * - adds the label LABEL and one comment naming the check files it edits;
 * - removes the label, and says so in that comment, once a later version no
 *   longer edits check files;
 * - otherwise changes nothing.
 *
 * It marks and never fails or blocks a pull request. On a pull request event
 * it reads only outside pull requests; started by hand on a pull request
 * number it reads any, so the crew can prove it without an outside copy.
 *
 * The workflow that runs it (check-file-flag.yml) checks out only this
 * project's own copy of this file, never the pull request's code, and reads
 * the file names only as data.
 */

export const LABEL = "edits checks";
const MARK = "<!-- check-file-flag -->";
/** The account the workflow's token writes as, the only author of the flag's comment. */
const BOT = "github-actions[bot]";

/**
 * The check files: what decides which checks run, on which machines, and
 * what installs. A path matches when it starts with a folder here, or its
 * name is one of the files here at any depth.
 */
export const CHECK_FILES = Object.freeze({
  folders: [".github/", "scripts/", "patches/", "packaging/"],
  names: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
  /** The packaging settings at the project's top, electron-builder.yml and its variants. */
  top: /^electron-builder[^/]*\.yml$/,
});

/** Whether one path is a check file. */
export function isCheckFile(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    CHECK_FILES.folders.some((folder) => path.startsWith(folder)) ||
    CHECK_FILES.names.includes(name) ||
    CHECK_FILES.top.test(path)
  );
}

/**
 * The check files among a pull request's changed files, as GitHub's list of
 * them returns them, sorted. A renamed file counts by its old name too, so
 * moving a file out of a check folder is flagged.
 */
export function checkFilesIn(files) {
  const paths = files.flatMap((file) => [file.filename, file.previous_filename ?? []].flat());
  return [...new Set(paths.filter(isCheckFile))].toSorted();
}

/** The one comment a flagged pull request gets, kept up to date. */
export function flagComment(paths) {
  if (paths.length === 0)
    return [
      MARK,
      `The newest version of this pull request edits no check files, so the \`${LABEL}\` label is removed.`,
    ].join("\n");
  return [
    MARK,
    `This pull request edits files that decide which checks run, where they run, or what installs, so it is labeled \`${LABEL}\`. A maintainer reads these changes before approving any run of its checks:`,
    "",
    ...paths.map((path) => `- \`${path}\``),
  ].join("\n");
}

/**
 * Runs the flag for one event, through actions/github-script's `github`
 * client and `context`. A hand-started run names its pull request in
 * `pullNumber`.
 */
export async function flag({ github, context, core, pullNumber }) {
  const { owner, repo } = context.repo;
  const project = `${owner}/${repo}`;
  const byHand = context.eventName === "workflow_dispatch";
  const number = byHand ? Number(pullNumber) : context.payload.pull_request?.number;
  if (!Number.isInteger(number) || number <= 0) {
    core.setFailed(`No pull request number: ${JSON.stringify(pullNumber ?? null)}`);
    return "no pull request";
  }
  const pull = byHand
    ? (await github.rest.pulls.get({ owner, repo, pull_number: number })).data
    : context.payload.pull_request;
  if (!byHand && pull.head.repo?.full_name === project) return "own branch";

  const paths = checkFilesIn(
    await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    }),
  );
  const labeled = (pull.labels ?? []).some((label) => label.name === LABEL);
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

  if (paths.length > 0) {
    if (!labeled)
      await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [LABEL] });
    await write(flagComment(paths));
    core.summary.addRaw(`#${number} edits check files:\n\n${paths.map((p) => `- ${p}`).join("\n")}\n`);
    await core.summary.write();
    return `flagged ${paths.length}`;
  }
  if (labeled) {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name: LABEL });
    if (comment) await write(flagComment([]));
    return "unflagged";
  }
  return "no check files";
}
