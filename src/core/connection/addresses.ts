import { BlockList, isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { HERE } from "@shared/deviceNames";
import type { DeviceAddressNetwork } from "@shared/devices";

/** The connection always listens here, for a device on this Mac itself. */
export const LOOPBACK_ADDRESS = "127.0.0.1";

/**
 * The private ranges a chosen address may sit in: the three home and office
 * ranges, the shared range a private network service such as Tailscale gives
 * each device, and IPv6's unique local range. Link-local addresses are left
 * out: they change with the cable and need a zone to dial.
 */
const PRIVATE_RANGES = new BlockList();
PRIVATE_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_RANGES.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6");

/** The shared range a private network service hands out. */
const SHARED_RANGE = new BlockList();
SHARED_RANGE.addSubnet("100.64.0.0", 10, "ipv4");

/**
 * A network interface's place in the order a link offers addresses:
 * Ethernet and Wi-Fi first - a Mac's `en`, Linux's `en`, `eth` and `wl` -
 * then any other, and last the bridges Linux makes for containers and
 * virtual machines (Docker's `docker0` and `br-`, libvirt's `virbr`), whose
 * private addresses no other computer can reach.
 */
function interfaceRank(name: string): number {
  if (/^(en|eth|wl)/.test(name)) return 0;
  if (/^(docker|br-|virbr|veth|lxc|lxd|podman|cni|flannel)/.test(name)) return 3;
  return 1;
}

/** Link-local addresses: never offered to a link, but on the local network all the same. */
const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");

/**
 * Where the connection listens (docs/connection.md): loopback, plus at most
 * one chosen address that is private and belongs to one of this Mac's own
 * network interfaces. Never a wildcard, never a public address, never a name
 * to resolve. A refused choice throws its reason.
 */
export function listenAddresses(
  chosen: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  if (chosen === undefined || chosen === LOOPBACK_ADDRESS) return [LOOPBACK_ADDRESS];
  const family = isIP(chosen);
  if (family === 0)
    throw new Error(`${chosen} is not an address. Choose one of ${HERE.this}'s own.`);
  if (chosen === "0.0.0.0" || chosen === "::" || /^[0:]+$/.test(chosen))
    throw new Error("The connection never listens on every address at once. Choose one.");
  if (!PRIVATE_RANGES.check(chosen, family === 4 ? "ipv4" : "ipv6"))
    throw new Error(`${chosen} is not a private address, so the connection does not listen there.`);
  const own = Object.values(interfaces)
    .flat()
    .some((entry) => entry?.address.toLowerCase() === chosen.toLowerCase());
  if (!own) throw new Error(`${chosen} does not belong to ${HERE.this} right now.`);
  return [LOOPBACK_ADDRESS, chosen];
}

/** A Linux bridge for containers or virtual machines: no other computer reaches it. */
export function isBridgeInterface(name: string): boolean {
  return interfaceRank(name) >= 3;
}

/**
 * The addresses a link may carry and the connection may listen on: this
 * computer's own private IPv4 addresses, local network first, then the
 * private network, with container bridges left out.
 */
export function offeredAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): { address: string; network: DeviceAddressNetwork }[] {
  const found: { address: string; network: DeviceAddressNetwork; rank: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (isBridgeInterface(name)) continue;
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (entry.internal || !ipv4 || isIP(entry.address) !== 4) continue;
      if (!PRIVATE_RANGES.check(entry.address, "ipv4")) continue;
      if (found.some((candidate) => candidate.address === entry.address)) continue;
      const network = SHARED_RANGE.check(entry.address, "ipv4") ? "private" : "local";
      const rank = network === "private" ? 2 : interfaceRank(name);
      found.push({ address: entry.address, network, rank });
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .map(({ address, network }) => ({ address, network }));
}

/**
 * Where the connection listens when a link may name every offered address:
 * loopback, plus each offered address that is still this computer's own.
 * A name, a public address or one it no longer has is skipped, never bound.
 */
export function listenOn(
  hosts: readonly string[],
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const bound = [LOOPBACK_ADDRESS];
  for (const host of hosts) {
    if (bound.includes(host)) continue;
    try {
      const extra = listenAddresses(host, interfaces).find(
        (address) => address !== LOOPBACK_ADDRESS,
      );
      if (extra && !bound.includes(extra)) bound.push(extra);
    } catch {
      // Never a wildcard, a public address, a name or an address this computer lacks.
    }
  }
  return bound;
}

/** Where a host a device dialed sits, for the row that says so. A name is this network. */
export function reachedNetwork(host: string): "local" | "private" | null {
  if (isLoopback(host)) return null;
  if (isIP(host) === 0) return /\.local$/i.test(host) ? "local" : null;
  if (SHARED_RANGE.check(host, isIP(host) === 4 ? "ipv4" : "ipv6")) return "private";
  return onLocalNetwork(host) ? "local" : null;
}

/** Interfaces a development picture stands in, never read by a packaged app. */
export function interfacesFromAddresses(
  addresses: readonly string[],
): NodeJS.Dict<NetworkInterfaceInfo[]> {
  const entry = (address: string): NetworkInterfaceInfo =>
    ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    }) as NetworkInterfaceInfo;
  return { en0: addresses.map(entry) };
}

export function privateAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): { address: string; network: DeviceAddressNetwork }[] {
  const found: { address: string; network: DeviceAddressNetwork; rank: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Older Node versions spell the family as a number.
      const ipv4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (entry.internal || !ipv4 || isIP(entry.address) !== 4) continue;
      if (!PRIVATE_RANGES.check(entry.address, "ipv4")) continue;
      if (found.some((candidate) => candidate.address === entry.address)) continue;
      const network = SHARED_RANGE.check(entry.address, "ipv4") ? "private" : "local";
      const rank = network === "private" ? 2 : interfaceRank(name);
      found.push({ address: entry.address, network, rank });
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .map(({ address, network }) => ({ address, network }));
}

/**
 * Whether an address is this Mac's own: loopback, or an address on one of
 * its network interfaces right now (an IPv4 address mapped into IPv6 counts
 * as itself). The home reads it off a device's socket to know the device
 * dialed from this Mac (docs/helper.md); a device reads it off a link's
 * address to know its home is on this Mac. A name is never resolved here.
 */
export function isThisMachine(
  address: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): boolean {
  if (!address) return false;
  if (isLoopback(address)) return true;
  // A link-local address from a socket or sshd names its zone ("fe80::1%en0"),
  // which the interface list never does (review INF-255 S1).
  const plain = plainAddress(address).replace(/%.*$/, "");
  return Object.values(interfaces)
    .flat()
    .some((entry) => entry?.address.toLowerCase() === plain);
}

/**
 * Whether an address is on the local network, where macOS asks the person at
 * a Mac before a program there dials it (docs/devices.md, "Through macOS's own
 * nc"): a home or office range, or a link-local address. Loopback is not, and
 * neither is the shared range a private network service hands out, which
 * macOS does not ask about. A name is never resolved here.
 */
export function onLocalNetwork(address: string): boolean {
  const plain = plainAddress(address);
  const family = isIP(plain);
  if (family === 0 || isLoopback(plain)) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (SHARED_RANGE.check(plain, type)) return false;
  return PRIVATE_RANGES.check(plain, type) || LINK_LOCAL.check(plain, type);
}

/**
 * Whether an address is loopback, which reaches this Mac whatever network it is on.
 * Socket addresses include mapped IPv4; relay selection keeps its literal-host policy.
 */
export function isLoopback(address: string, mappedIPv4 = true): boolean {
  const plain = mappedIPv4 ? plainAddress(address) : address.toLowerCase().replace(/^\[|\]$/g, "");
  if (plain === "::1" || plain === "localhost") return true;
  return isIP(plain) === 4 && plain.startsWith("127.");
}

/** An address without brackets, with an IPv4 address mapped into IPv6 as itself. */
function plainAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
}
