import { execFile } from "node:child_process";
import { settingFrom } from "@shared/envSettings";
import { hostEnv } from "../hostEnv";
import { findOnPath } from "../userBin";

/**
 * GitHub CLI's own sign-in, for a person whose organization blocks
 * third-party OAuth apps such as the app's own (`docs/forge.md`, "GitHub
 * CLI's sign-in"). GitHub lists GitHub CLI among the GitHub-owned apps a
 * person may authorize even where an organization owner restricted OAuth
 * app access, so its sign-in reaches what the app's cannot.
 *
 * The app never keeps GitHub CLI's token: it asks the program the person
 * installed (`gh auth token --hostname <host>`) each time a sign-in is
 * needed, and GitHub CLI refreshes an expiring token of its own first. The
 * app never runs GitHub CLI's sign-in, never installs it and never signs
 * it out.
 */

/** The program's name on the search path. */
export const GITHUB_CLI_NAME = "gh";

/** GitHub CLI answers from its config or the Keychain at once; a hung one is given this long. */
export const GITHUB_CLI_TIMEOUT_MS = 10_000;

/** GitHub CLI's answer is reused this long, so a burst of requests asks it once. */
export const GITHUB_CLI_KEPT_MS = 60_000;

/**
 * What GitHub CLI answered for a host: its token; that it holds no sign-in
 * for the host (`none`); that the program is gone (`missing`); or that it
 * could not be asked (`failed`). The reason never carries the token.
 */
export type GitHubCliToken =
  | { token: string }
  | { problem: "none" | "missing" | "failed"; reason: string };

/** How the sign-in service reaches GitHub CLI; tests hand in a scripted one. */
export type GitHubCli = {
  /** The program's path on this computer, or nothing where it is not installed. */
  find: () => string | undefined;
  token: (program: string, host: string) => Promise<GitHubCliToken>;
};

/** A path the git helper can read back from the one-line sign-in file with a line tool. */
export function isGitHubCliPath(path: string): boolean {
  return path.startsWith("/") && !/["\\\n\r]/.test(path);
}

/** A token GitHub CLI prints: one line of letters, digits and underscores, as GitHub issues them. */
const TOKEN = /^[A-Za-z0-9_]{1,1024}$/;

export function readGitHubCliToken(
  program: string,
  host: string,
  env: NodeJS.ProcessEnv = hostEnv(),
): Promise<GitHubCliToken> {
  return new Promise((resolve) => {
    execFile(
      program,
      ["auth", "token", "--hostname", host],
      { timeout: GITHUB_CLI_TIMEOUT_MS, env, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES") {
            resolve({ problem: "missing", reason: `GitHub CLI was not found at ${program}` });
          } else if ((error as { killed?: boolean }).killed) {
            resolve({ problem: "failed", reason: "GitHub CLI did not answer in time" });
          } else if (/no oauth token|not logged in/i.test(String(stderr))) {
            resolve({ problem: "none", reason: `GitHub CLI holds no sign-in for ${host}` });
          } else {
            resolve({ problem: "failed", reason: `GitHub CLI exited with ${String(code)}` });
          }
          return;
        }
        const token = String(stdout).trim();
        resolve(
          TOKEN.test(token)
            ? { token }
            : { problem: "none", reason: `GitHub CLI holds no sign-in for ${host}` },
        );
      },
    );
  });
}

/**
 * The person's own GitHub CLI, found on the search path the app captured.
 * `INFINITARY_GITHUB_CLI` stands in for it in dev and e2e only, gated like
 * the GitHub endpoint overrides: a program's path, or `none` for no GitHub
 * CLI at all, so no test finds the one installed on the computer it runs on.
 */
export function githubCliFor(options: { packaged: boolean; env?: NodeJS.ProcessEnv }): GitHubCli {
  const override = options.packaged
    ? undefined
    : settingFrom(options.env ?? process.env, "GITHUB_CLI")?.trim();
  return {
    find: () => {
      const found =
        override !== undefined
          ? override === "none" || override === ""
            ? undefined
            : override
          : findOnPath(GITHUB_CLI_NAME, hostEnv());
      return found && isGitHubCliPath(found) ? found : undefined;
    },
    token: (program, host) => readGitHubCliToken(program, host),
  };
}
