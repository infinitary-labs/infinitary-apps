import { machine, type as osType, userInfo } from "node:os";
import type { SetUpHere } from "@shared/joinByAddress";
import { parseRemoteLoginAddress } from "@shared/remoteLogin";
import { interfacesFromAddresses, offeredAddresses } from "../connection/addresses";
import { hostPlatform } from "../platform";
import type { StandIns } from "../standIns";
import { ownNetworkNames } from "./computerName";
import { farSystemOf } from "./farSystems";
import { type HostKeyRead, readOwnHostKey } from "./hostKey";

/**
 * Set up from your first mate's computer, at this app's first launch
 * (docs/view.md, "Joining"): what the person types or compares on their
 * first mate's computer to add this one by its address. Every reading needs
 * no administrator: the account, the addresses, the local network name, and
 * the key this computer's SSH server answers with on its own loopback,
 * whose absence says Remote Login is off. The line to compare is the key
 * the first address shown answers with, and names that address. On a Mac
 * the local name is the one Bonjour announces; elsewhere, where nothing may
 * announce one, it is the local network address. Each address shown is one
 * the address rules take. The address way is offered only where it sets a
 * computer up: a Mac, or an x64 Linux computer.
 */
export async function setUpHere(
  read: {
    system?: string;
    arch?: string;
    platform?: string;
    hostKey?: (host: string) => Promise<HostKeyRead>;
    names?: () => Promise<string[]>;
    addresses?: () => { address: string; network: "private" | "local" }[];
    /** The account the address names, instead of this run's own. */
    user?: string;
    /** Whether the address way is offered here, alone: no account, address or key is read. */
    eligibilityOnly?: boolean;
  } = {},
): Promise<SetUpHere> {
  const platform = read.platform ?? hostPlatform();
  const far = farSystemOf(read.system ?? osType());
  const offered = Boolean(far?.chips[read.arch ?? machine()]);
  const opensSharing = platform === "darwin";
  if (!offered || read.eligibilityOnly)
    return {
      offered,
      user: null,
      privateAddress: null,
      localName: null,
      remoteLogin: "unknown",
      line: null,
      lineAt: null,
      opensSharing,
    };
  const hostKey = read.hostKey ?? ((host: string) => readOwnHostKey(host));
  const names = await (read.names ?? (() => ownNetworkNames(platform)))().catch(() => []);
  const addresses = (read.addresses ?? offeredAddresses)();
  const account = read.user ?? userInfo().username;
  // The account as an address names it, or none when the address rules refuse it there.
  const user = account && parseRemoteLoginAddress(`${account}@here`) ? account : null;
  const usable = (address: string | null | undefined) =>
    address && parseRemoteLoginAddress(user ? `${user}@${address}` : address) ? address : null;
  const privateAddress = usable(addresses.find((entry) => entry.network === "private")?.address);
  // The name Bonjour announces on a Mac, as the person set it, over the system's own.
  const localName = usable(
    platform === "darwin"
      ? names.at(-1)
      : addresses.find((entry) => entry.network === "local")?.address,
  );
  const lineAt = privateAddress ?? localName;
  const [key, there] = await Promise.all([
    hostKey("127.0.0.1").catch(() => null),
    lineAt ? hostKey(lineAt).catch(() => null) : null,
  ]);
  const remoteLogin =
    key && "line" in key ? "on" : key?.refusal === "remote-login-off" ? "off" : "unknown";
  const line = there && "line" in there ? there.line : null;
  return {
    offered,
    user,
    privateAddress,
    localName,
    remoteLogin,
    line,
    lineAt: line ? lineAt : null,
    opensSharing,
  };
}

/**
 * A development or end-to-end run's own stand-ins for what this computer
 * reads of itself (`StandIns`): its addresses, its network name, its
 * account, and a throwaway SSH server that answers for every address, so a
 * journey reads neither the runner's network identity nor its SSH.
 */
export function setUpStandIns(
  standIns: Pick<StandIns, "addresses" | "networkName" | "user" | "ownSshPort">,
): Pick<NonNullable<Parameters<typeof setUpHere>[0]>, "addresses" | "names" | "user" | "hostKey"> {
  const { addresses, networkName, user, ownSshPort } = standIns;
  return {
    ...(addresses ? { addresses: () => offeredAddresses(interfacesFromAddresses(addresses)) } : {}),
    ...(networkName ? { names: async () => [networkName] } : {}),
    ...(user ? { user } : {}),
    ...(ownSshPort ? { hostKey: () => readOwnHostKey("127.0.0.1", ownSshPort) } : {}),
  };
}
