import { machine, type as osType, userInfo } from "node:os";
import type { SetUpHere } from "@shared/joinByAddress";
import { offeredAddresses } from "../connection/addresses";
import { hostPlatform } from "../platform";
import { ownNetworkNames } from "./computerName";
import { farSystemOf } from "./farSystems";
import { type HostKeyRead, readOwnHostKey } from "./hostKey";

/**
 * Set up from your first mate's computer, at this app's first launch
 * (docs/view.md, "Joining"): what the person types or compares on their
 * first mate's computer to add this one by its address. Every reading needs
 * no administrator: the account, the addresses, the local network name, and
 * the key this computer's SSH server answers with, whose absence says
 * Remote Login is off. The address way is offered only where it sets a
 * computer up: a Mac, or an x64 Linux computer.
 */
export async function setUpHere(
  read: {
    system?: string;
    arch?: string;
    platform?: string;
    hostKey?: () => Promise<HostKeyRead>;
    names?: () => Promise<string[]>;
    addresses?: () => { address: string; network: "private" | "local" }[];
  } = {},
): Promise<SetUpHere> {
  const platform = read.platform ?? hostPlatform();
  const far = farSystemOf(read.system ?? osType());
  const offered = Boolean(far?.chips[read.arch ?? machine()]);
  const opensSharing = platform === "darwin";
  if (!offered)
    return {
      offered,
      user: null,
      privateAddress: null,
      localName: null,
      remoteLogin: "unknown",
      line: null,
      opensSharing,
    };
  const [key, names] = await Promise.all([
    (read.hostKey ?? readOwnHostKey)().catch(() => null),
    (read.names ?? (() => ownNetworkNames(platform)))().catch(() => []),
  ]);
  const user = userInfo().username;
  const remoteLogin =
    key && "line" in key ? "on" : key?.refusal === "remote-login-off" ? "off" : "unknown";
  return {
    offered,
    user: user && user.length <= 64 ? user : null,
    privateAddress:
      (read.addresses ?? offeredAddresses)().find((address) => address.network === "private")
        ?.address ?? null,
    // The name Bonjour announces, as the person set it, over the system's own.
    localName: names.at(-1) ?? null,
    remoteLogin,
    line: key && "line" in key ? key.line : null,
    opensSharing,
  };
}
