import type { TaskShell } from "../session/session";
import { APP_GIT_EMAIL, APP_GIT_NAME, git } from "./git";

export type CommitName = { name: string; email: string };

/**
 * The name a crew commit carries when the computer's saved git settings give
 * none: the app's own identity, whose address has no account behind it.
 */
export const CREW_FALLBACK_COMMIT_NAME: CommitName = {
  name: APP_GIT_NAME,
  email: APP_GIT_EMAIL,
};

/** A hung git must not hold a session's open. */
const RESOLVE_TIMEOUT_MS = 10 * 1000;

/**
 * The name git would commit under in `cwd` from saved settings alone: the
 * repository's, then the person's, then the system's. `useConfigOnly` stops
 * git guessing one from the account and computer names, so a computer with
 * none saved gets the Infinitary name instead of a made-up one.
 */
export async function resolveCommitName(cwd: string): Promise<CommitName> {
  const ident = await git(cwd, ["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], {
    timeoutMs: RESOLVE_TIMEOUT_MS,
  }).catch(() => "");
  // "Name <email> 1764000000 -0800"
  const [, name, email] = /^(.+?) <([^<>]+)> \d+ [+-]\d{4}$/.exec(ident) ?? [];
  return name && email ? { name, email } : CREW_FALLBACK_COMMIT_NAME;
}

/**
 * A crewmate session's shell with its commit name laid over it. Git reads
 * these variables ahead of `-c user.name` and every saved setting, so a
 * command that passes another name still commits under this one; only
 * `--author` outranks the author pair.
 */
export function withCommitName(shell: TaskShell | undefined, commit: CommitName): TaskShell {
  return {
    env: {
      ...shell?.env,
      GIT_AUTHOR_NAME: commit.name,
      GIT_AUTHOR_EMAIL: commit.email,
      GIT_COMMITTER_NAME: commit.name,
      GIT_COMMITTER_EMAIL: commit.email,
    },
    path: shell?.path ?? [],
  };
}
