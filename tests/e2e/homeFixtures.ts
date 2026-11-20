import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plantProgram } from "../../src/core/loginShellStub";

/**
 * INF-2394 measure 4: external home inputs have one layout owner, not inline launch callbacks.
 * @journey-area src/core/hostEnv.ts
 * @journey-area src/core/workspace/
 * @journey-area src/core/session/
 */

/** Git itself reads this config, so cloning exercises real git against a scratch-local origin. */
export function redirectGitClone(homeDir: string, origin: string, local: string): void {
  redirectGitClones(homeDir, [{ origin, local }]);
}

/** Several public-looking clone addresses, each answered by its local repository. */
export function redirectGitClones(
  homeDir: string,
  routes: readonly { origin: string; local: string }[],
): void {
  writeFileSync(
    join(homeDir, ".gitconfig"),
    routes.map(({ origin, local }) => `[url "${local}"]\n\tinsteadOf = ${origin}\n`).join(""),
  );
}

export function gitCloneHome(origin: string, local: string): (homeDir: string) => void {
  return (homeDir) => redirectGitClone(homeDir, origin, local);
}

/** The contribution journey's two real local hosts, behind their public-looking addresses. */
export function contributionGitHome(
  homeDir: string,
  routes: { origin: string; local: string }[],
): void {
  writeFileSync(
    join(homeDir, ".gitconfig"),
    `[user]\n\tname = Example contributor\n\temail = contributor@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n` +
      routes.map(({ origin, local }) => `[url "${local}"]\n\tinsteadOf = ${origin}\n`).join(""),
  );
}

/**
 * A person's own git identity, as their computer has one: git authors a new
 * project's first commit, a crewmate's commit and a local merge with it.
 */
export function gitIdentityHome(name: string, email: string): (homeDir: string) => void {
  return (homeDir) =>
    writeFileSync(join(homeDir, ".gitconfig"), `[user]\n\tname = ${name}\n\temail = ${email}\n`);
}

/** The projects-folder journey chooses an existing folder under its scratch home. */
export function catalogProjectsHome(homeDir: string): void {
  mkdirSync(join(homeDir, "catalog-projects"));
}

/** Interactive shell startup, including its greeting, as the Dock-launch journey supplies it. */
export function nodeLoginHome(version: string): (homeDir: string) => void {
  return (homeDir) => {
    const nvmBin = join(homeDir, ".nvm", "versions", "node", "v99.0.0", "bin");
    plantProgram(nvmBin, "node", version);
    writeFileSync(
      join(homeDir, ".zshrc"),
      `echo "Welcome back"\nexport NVM_DIR="$HOME/.nvm"\nPATH="${nvmBin}:$PATH"\n`,
    );
  };
}

/** Personal resource files are authored input; the session loader reads their real formats. */
export function personalResourcesHome(
  marker: string,
  skillName: string,
): (homeDir: string) => void {
  return (homeDir) => {
    writeFileSync(join(homeDir, "AGENTS.md"), marker);
    const dir = join(homeDir, ".agents", "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Local rivet guidance.\n---\nCount rivets locally.\n`,
    );
  };
}
