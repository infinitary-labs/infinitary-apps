import { join } from "node:path";
import { settingFrom } from "@shared/envSettings";
import dugite from "dugite";
import { type BundledGit, configureBundledGit } from "../hostEnv";
import { isExecutable } from "../userBin";

/**
 * The app's own git (git integration phase 2, `docs/forge.md` "The app's
 * own git"): dugite-native's macOS git, both architectures shipped side by
 * side (`scripts/ensure-bundled-git.ts` vendors them; `electron-builder.yml`
 * ships them outside the archive), so a Mac with no developer tools - and
 * a Dock launch that sees none of the person's - still clones, commits and
 * sends up a change. Every host git runs it (`git.ts`), and a crewmate's
 * shell finds it first on its search path through the one-file directory
 * `git-bin/` (`hostEnv.ts`), whose `git` is the compiled launcher
 * `scripts/git-launcher.c`.
 *
 * That git is built to be told where its parts are, so each run carries
 * the environment dugite's `setupEnvironment` gives it (its programs, its
 * templates, its system config, which includes the Mac's /etc/gitconfig).
 * The person's own ~/.gitconfig - their name, their email - still applies.
 */

export type BundledGitApp = {
  readonly packaged: boolean;
  readonly appDir: string;
  readonly resourcesDir: string;
};

/**
 * Where this build keeps the app's git for `arch`, and the directory whose
 * only file is the `git` a crewmate's shell runs: next to the archive in a
 * packaged app, the checkout's `vendor/` otherwise, where `pnpm install`
 * built that launcher (`scripts/build-git-launcher.ts`).
 */
export function bundledGitLocation(
  app: BundledGitApp,
  arch: string = process.arch,
): { dir: string; shimDir: string } {
  return app.packaged
    ? {
        dir: join(app.resourcesDir, "git", `darwin-${arch}`),
        shimDir: join(app.resourcesDir, "git-bin"),
      }
    : {
        dir: join(app.appDir, "vendor", "git", `darwin-${arch}`),
        shimDir: join(app.appDir, "vendor", "git-bin"),
      };
}

/**
 * The app's git for this build, or nothing: then every git is the one the
 * search path finds, as before phase 2. An unpackaged checkout that has
 * not vendored the trees (any platform but macOS), or a Mac checkout with
 * no developer tools to build the launcher, runs the system git, and
 * `INFINITARY_SYSTEM_GIT=1` asks for that on purpose, for a test; a packaged
 * app ignores the variable.
 */
export function resolveBundledGit(
  app: BundledGitApp,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): BundledGit | undefined {
  if (!app.packaged && settingFrom(env, "SYSTEM_GIT") === "1") return undefined;
  const { dir, shimDir } = bundledGitLocation(app, arch);
  if (!isExecutable(join(dir, "bin", "git")) || !isExecutable(join(shimDir, "git"))) {
    return undefined;
  }
  const setup = dugite.setupEnvironment({ LOCAL_GIT_DIRECTORY: dir }, {});
  const { LOCAL_GIT_DIRECTORY: _named, ...gitEnv } = setup.env;
  const definedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(gitEnv)) {
    if (typeof value === "string") definedEnv[key] = value;
  }
  return { dir, binary: setup.gitLocation, shimDir, env: definedEnv };
}

/**
 * Takes the app's git for this build as the one every host git runs and
 * every child's search path finds first (`configureBundledGit`), and notes
 * which git that is. Each composition takes it once, before anything runs
 * git: the app's own (`createServices`) and the work mode's (`runCli`,
 * docs/helper.md "Running").
 */
export function adoptBundledGit(
  app: BundledGitApp,
  env: NodeJS.ProcessEnv = process.env,
): BundledGit | undefined {
  const appGit = resolveBundledGit(app, env);
  configureBundledGit(appGit);
  console.info(
    appGit
      ? `[host-env] git: the app's own, ${appGit.binary}`
      : "[host-env] git: this build carries none; children run the git on their search path",
  );
  return appGit;
}
