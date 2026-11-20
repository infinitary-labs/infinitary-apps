import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/**
 * Detaches a read-only disk image the check mounted, through the release
 * checks' one detach (scripts/detach-disk-image.sh): a moment's hold by one of
 * macOS's own scans does not fail the check. Its account of a busy image goes
 * to the job's log.
 */
export function detachDiskImage(mount: string, env: NodeJS.ProcessEnv): void {
  const script = fileURLToPath(new URL("./detach-disk-image.sh", import.meta.url));
  runInstallerCommand("/bin/bash", [script, mount], env, { stdio: ["ignore", "pipe", "inherit"] });
}
