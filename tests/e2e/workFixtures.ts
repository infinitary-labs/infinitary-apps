import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellWord } from "../../src/core/devices/joinCommand";

/**
 * INF-2394 measure 4: isolated background-manager behavior and retained-file fixtures have one owner.
 * @journey-area src/core/helper/background.ts
 * @journey-area src/core/helper/
 */
export function writeWorkServiceManager(
  homeDir: string,
  systemd: boolean,
): { manager: string; asked: string; agentPid: string } {
  const manager = join(homeDir, systemd ? "systemctl" : "launchctl");
  const asked = join(homeDir, "manager.asked");
  const agentPid = join(homeDir, "agent.pid");
  const stops = systemd ? '[ "$2" = stop ] || [ "$2" = restart ]' : '[ "$1" = bootout ]';
  writeFileSync(
    manager,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellWord(asked)}`,
      ...(systemd ? ['if [ "$2" = show ]; then echo active; fi'] : []),
      `if { ${stops}; } && [ -f ${shellWord(agentPid)} ]; then`,
      `  pid=$(cat ${shellWord(agentPid)}); rm -f ${shellWord(agentPid)}`,
      `  kill -TERM "$pid" 2>/dev/null`,
      `  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(manager, 0o755);
  return { manager, asked, agentPid };
}

/** Retained legacy sign-in data is a deletion-protection sentinel, never a connected account. */
export function seedRetainedAccountDirectory(userDataDir: string): void {
  mkdirSync(join(userDataDir, "accounts", "codex"), { recursive: true });
}

export function seedRetainedSignInSentinel(userDataDir: string): void {
  mkdirSync(join(userDataDir, "accounts"), { recursive: true });
  writeFileSync(join(userDataDir, "accounts", "kept"), "a sign-in\n");
}
