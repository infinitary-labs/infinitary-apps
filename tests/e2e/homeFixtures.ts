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
  writeFileSync(join(homeDir, ".gitconfig"), `[url "${local}"]\n\tinsteadOf = ${origin}\n`);
}

export function gitCloneHome(origin: string, local: string): (homeDir: string) => void {
  return (homeDir) => redirectGitClone(homeDir, origin, local);
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
