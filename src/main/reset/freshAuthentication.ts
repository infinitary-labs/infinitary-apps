import type { FreshAuthentication } from "@core/secrets/approvals";
import { createDarwinFreshAuthentication } from "../host/darwinFreshAuthentication";
import { createLinuxFreshAuthentication } from "../host/linuxFreshAuthentication";
import { createWindowsFreshAuthentication } from "../host/windowsFreshAuthentication";
import type { UserDataChoice } from "../userDataDir";

/**
 * The system's own confirmation of the person at this computer, where no
 * Secrets were composed yet - the could-not-start screen and the reset
 * command (docs/reset.md, "Where a reset can start"): the same Touch ID or
 * password, polkit prompt and Windows Hello Secrets use. None on an isolated
 * or chosen folder, as Secrets have none there.
 */
export function freshAuthenticationFor(
  choice: UserDataChoice,
  platform: NodeJS.Platform,
  window?: () => Buffer | undefined,
): FreshAuthentication | undefined {
  if (choice.kind !== "flavor") return undefined;
  if (platform === "darwin") return createDarwinFreshAuthentication();
  if (platform === "linux") return createLinuxFreshAuthentication();
  if (platform === "win32") return createWindowsFreshAuthentication(window ? { window } : {});
  return undefined;
}
