import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { settingFrom } from "@shared/envSettings";
import { CODEX_SAVED_RESET_FLOOR } from "@shared/savedResets";
import { compareVersions } from "../claude/claudeCli";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { installerDirs, isExecutable, lookupThroughLoginShell, programFiles } from "../userBin";

/**
 * The Codex CLI the person installed (docs/codex-client.md). Infinitary
 * ships none: Codex is a large program the person keeps up to date
 * themselves, as the Claude client is (docs/claude-client.md). It is looked
 * for at `INFINITARY_CODEX_CLI` when it is set, else on the host search
 * path, then in the installers' usual folders, then through the login
 * shell, and its `--version` is read each time, since the person may
 * update it between two uses.
 */

/** A `--version` that does not answer in this long is a Codex that cannot be used now. */
const VERSION_TIMEOUT_MS = 10_000;

export type CodexCliCheck =
  | { state: "ready"; executable: string; version: string }
  | { state: "missing" }
  | { state: "old"; executable: string; version: string };

/** How the check finds and reads the program; a test hands in its own. */
export type CodexCliReach = {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  readVersion?: (executable: string) => Promise<string | undefined>;
  lookup?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
};

/** The first x.y.z in Codex's `--version` line (`codex-cli 0.155.1`). */
export function parseCodexVersion(text: string): string | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

const readCodexVersion = (executable: string, env: NodeJS.ProcessEnv) =>
  new Promise<string | undefined>((resolve) => {
    execFile(
      executable,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, env, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : parseCodexVersion(String(stdout))),
    );
  });

/** Where `codex` is, without asking the login shell; undefined when nowhere. */
export function findCodex(env: NodeJS.ProcessEnv, platform: string): string | undefined {
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...installerDirs(env)];
  for (const dir of dirs)
    for (const file of programFiles(dir, "codex", env, platform))
      if (isExecutable(file)) return file;
  return undefined;
}

/**
 * Whether this computer's Codex can use a saved reset: found and at least
 * `CODEX_SAVED_RESET_FLOOR`. A version it cannot read is treated as old,
 * so the words say to update rather than to install.
 */
export async function checkCodexCli(reach: CodexCliReach = {}): Promise<CodexCliCheck> {
  const env = reach.env ?? hostEnv();
  const platform = reach.platform ?? hostPlatform();
  // An explicit INFINITARY_CODEX_CLI wins outright, and a missing one is no
  // Codex, never a fallback: a test points it at a stand-in, so the
  // person's real Codex is never started by one.
  const override = settingFrom(env, "CODEX_CLI")?.trim();
  const executable = override
    ? isExecutable(override)
      ? override
      : undefined
    : (findCodex(env, platform) ??
      (await (reach.lookup ?? ((shellEnv) => lookupThroughLoginShell("codex", shellEnv)))(env)));
  if (!executable) return { state: "missing" };
  const version = await (reach.readVersion ?? ((path) => readCodexVersion(path, env)))(executable);
  if (!version || compareVersions(version, CODEX_SAVED_RESET_FLOOR) < 0)
    return { state: "old", executable, version: version ?? "unknown" };
  return { state: "ready", executable, version };
}
