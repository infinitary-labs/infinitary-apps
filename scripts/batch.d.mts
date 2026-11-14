/** Octokit instances, as actions/github-script passes them. */
export function readMainPush(
  github: unknown,
  repo: { owner: string; repo: string },
  push: { sha: string; tree: string },
): Promise<{ kind: "full" | "covered"; run?: number }>;
