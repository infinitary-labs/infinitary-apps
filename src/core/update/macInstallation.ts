import receipt from "../../../packaging/mac-installation.json" with { type: "json" };
import type { UpdateChannel } from "../../shared/updateChannel";
import { FIRSTMATE_TAP, INFINITARY_TAP, type TapNames } from "./updateChannels";

/** INF-643: ownership belongs to this installed copy, never its shared data folder. */
export type MacInstallation =
  | { kind: "direct" }
  | { kind: "homebrew"; channel: UpdateChannel; tap: TapNames }
  | { kind: "unknown" };

export const MAC_INSTALLATION_ATTRIBUTE = receipt.attribute;
export const MAC_INSTALLATION_RESOURCE = receipt.path;
export const DIRECT_MAC_INSTALLATION = receipt.direct;

export function homebrewInstallationReceipt(channel: UpdateChannel, tap: TapNames): string {
  return `${receipt.homebrewPrefix}${tap.tap}/${tap.caskTokens[channel]}`;
}

export function parseMacInstallation(value: string): MacInstallation {
  if (value === receipt.direct) return { kind: "direct" };
  for (const tap of [INFINITARY_TAP, FIRSTMATE_TAP]) {
    for (const channel of ["stable", "alpha"] as const) {
      if (value === homebrewInstallationReceipt(channel, tap))
        return { kind: "homebrew", channel, tap };
    }
  }
  // Missing or unreadable ownership is not permission to replace a Homebrew copy.
  return { kind: "unknown" };
}
