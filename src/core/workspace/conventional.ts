import { git } from "./git";

/** Release-please recognises these conventional subjects; scopes are open-ended. */
const SUBJECT = /^(feat|fix|chore|test|refactor|docs|perf)(?:\([a-z0-9][a-z0-9./-]*\))?!?: \S.+$/;

export function requireConventional(subject: string, what = "commit"): string {
  if (!SUBJECT.test(subject) || subject.includes("\n")) {
    throw new Error(
      `The ${what} needs a conventional name such as "fix(crew): correct naming" or "feat: add a feature". Choose the accurate type (feat, fix, chore, test, refactor, docs, perf); do not call a fix a feature just to make a release. Received: ${JSON.stringify(subject)}.`,
    );
  }
  return subject;
}

/** A conventional breaking marker is title metadata, not an exclamation in its copy. */
export function conventionalTitleCopy(subject: string): string {
  if (!SUBJECT.test(subject) || subject.includes("\n")) return subject;
  const colon = subject.indexOf(":");
  return subject[colon - 1] === "!" ? subject.slice(0, colon - 1) + subject.slice(colon) : subject;
}

/**
 * Check only commits introduced by the branch, not historical commits on its
 * base. Merge commits that take newer work in are skipped: git names them,
 * and they bring in no work of the branch's own.
 */
export async function requireConventionalRange(
  dir: string,
  base: string,
  head: string,
): Promise<void> {
  const lines = await git(dir, ["log", "--no-merges", "--format=%s", `${base}..${head}`]);
  for (const subject of lines.split("\n").filter(Boolean)) requireConventional(subject);
}
