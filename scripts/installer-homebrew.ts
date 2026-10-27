import assert from "node:assert/strict";
import { join } from "node:path";

export function installerHomebrewEnvironment(env: NodeJS.ProcessEnv, work: string): NodeJS.ProcessEnv {
  return {
    ...env,
    HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_FROM_API: "1",
    HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_CACHE: join(work, "homebrew-cache"), HOMEBREW_LOGS: join(work, "homebrew-logs"),
    HOMEBREW_TEMP: join(work, "homebrew-tmp"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/** Resolve Homebrew's real prerequisite before GitHub points at the fixture server. */
export function prepareInstallerHomebrew(
  brewPath: string,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => string,
): { repository: string; commit: string } {
  const options = { env, timeout: 180_000 };
  const brew = (args: string[]) => run(brewPath, args, options);
  const taps = () => brew(["tap"]).split("\n");
  // The full core tap is needed with the API disabled even for a cask-only
  // upgrade. Do not replace it with an empty tap or bypass Homebrew's check.
  // A guest image without the tap clones all of homebrew-core once, which took
  // longer than three minutes on the Mac mini's virtual Mac (run 40444437680).
  if (!taps().includes("homebrew/core")) {
    run(brewPath, ["tap", "--force", "homebrew/core"], { env, timeout: 900_000 });
  }
  assert(taps().includes("homebrew/core"), "Homebrew core must be present before GitHub is redirected");
  const repository = brew(["--repository", "homebrew/core"]).split("\n").at(-1)!;
  const commit = run("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"], options);
  return { repository, commit };
}
