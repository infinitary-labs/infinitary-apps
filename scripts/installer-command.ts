import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

/** One bounded fixture command; the caller supplies its isolated environment. */
export function runInstallerCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
): string {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000, ...options });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stderr || result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} failed (status ${result.status}, signal ${result.signal}): ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}
