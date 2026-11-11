import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/core/workspace/git";
import { scratchDir } from "../helpers/scratchDirs";
import { startContributionForge } from "./contributionForge";
import { seedGitHubSignIn, seedRepo } from "./githubStub";
import { contributionGitHome } from "./homeFixtures";
import { launchApp } from "./launch";
import type { Scenario } from "./mockProvider";

/** One isolated contributor, a public-looking upstream and a real local fork, with no real sign-ins. */
export async function startContributionWorld(imported = false, scenarios: Scenario[] = []) {
  const root = scratchDir("infinitary-fork-journey-");
  const homeDir = scratchDir("infinitary-fork-home-");
  const userDataDir = scratchDir("infinitary-fork-app-");
  const seed = seedRepo(root);
  const upstreamDir = join(root, "upstream.git");
  const forkDir = join(root, "fork.git");
  await git(root, ["clone", "--bare", "--quiet", seed.repoDir, upstreamDir]);
  await git(root, ["clone", "--bare", "--quiet", seed.repoDir, forkDir]);
  // Upstream advanced after the fork: its older main must not become a contribution's base.
  writeFileSync(join(seed.repoDir, "README.md"), "Upstream progressed after the fork.\n");
  await git(seed.repoDir, ["add", "README.md"]);
  await git(seed.repoDir, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "docs: improve the upstream example",
  ]);
  await git(seed.repoDir, ["push", "--quiet", upstreamDir, "main"]);
  const forge = await startContributionForge();
  if (imported) forge.setExistingFork();
  contributionGitHome(homeDir, [
    { origin: forge.upstream.clone_url, local: upstreamDir },
    { origin: forge.fork.clone_url, local: forkDir },
  ]);
  seedGitHubSignIn(userDataDir);
  const app = await launchApp({
    withMockProvider: true,
    scenarios,
    userDataDir,
    homeDir,
    env: { ...forge.env, GIT_CONFIG_GLOBAL: join(homeDir, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
  const { repo } = await app.page.evaluate(
    async ({ origin }) =>
      window.infinitary.repos.setup({ kind: "clone", origin, name: "sample-project" }),
    { origin: imported ? forge.fork.clone_url : forge.upstream.clone_url },
  );
  // Read the pushed fork branch's actual commit, not a synthetic successful head.
  forge.headOf((project, branch) => {
    const dir =
      project === forge.upstream.full_name
        ? upstreamDir
        : project === forge.fork.full_name
          ? forkDir
          : undefined;
    if (!dir) throw new Error(`Unexpected contribution project: ${project}`);
    return execFileSync("git", ["-C", dir, "rev-parse", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim();
  });
  return {
    app,
    forge,
    repo,
    homeDir,
    userDataDir,
    upstreamDir,
    forkDir,
    close: async () => {
      await app.close();
      await forge.close();
    },
  };
}
