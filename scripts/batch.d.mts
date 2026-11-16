/** Every file under .github/ in the checkout at `root`, path to text. */
export function readCheckFiles(root: string): Promise<Map<string, string>>;
/** Octokit instances, as actions/github-script passes them. */
export function readMainPush(
  github: unknown,
  repo: { owner: string; repo: string },
  push: { sha: string; tree: string; checkFiles: ReadonlyMap<string, string> },
): Promise<{ kind: "full" | "covered"; run?: number }>;
