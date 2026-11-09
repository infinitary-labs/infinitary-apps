import { isIP } from "node:net";

/**
 * Which addresses a task browser may connect to on the internet
 * (docs/task-browser.md, "Where a page may go"): a public one, and nothing
 * on this Mac, a private network, a shared carrier network, a link, a
 * multicast group, or a range kept for documentation, benchmarks or later
 * use. The connection guard (`connectionGuard.ts`) asks this of every
 * address a name resolves to, and the destination policy of every address
 * written into a URL.
 *
 * Pure: an address in, a verdict out.
 */

/** IPv4 ranges that are not the public internet, as [first address, prefix length]. */
const IPV4_NOT_PUBLIC: readonly [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared carrier network
  ["127.0.0.0", 8], // this Mac
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relays
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

/**
 * IPv6 ranges that are not the public internet. Everything outside
 * `2000::/3` is refused before these are read; the two that carry an IPv4
 * address inside them (`::ffff:0:0/96`, `64:ff9b::/96`) are read by that
 * address instead.
 */
const IPV6_NOT_PUBLIC: readonly [string, number][] = [
  ["2001::", 23], // protocol assignments, Teredo among them
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which can carry a private IPv4 address
  ["3fff::", 20], // documentation
];

function ipv4Value(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inIpv4(value: number, [base, prefix]: readonly [string, number]): boolean {
  const size = 2 ** (32 - prefix);
  const start = ipv4Value(base);
  return value >= start && value < start + size;
}

/** An IPv6 address as one 128-bit number, its IPv4 tail read as the last 32 bits. */
function ipv6Value(address: string): bigint {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ipv4Value(last);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const groups = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...new Array<number>(fill).fill(0), ...right].reduce(
    (value, group) => (value << 16n) | BigInt(group),
    0n,
  );
}

function inIpv6(value: bigint, [base, prefix]: readonly [string, number]): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === ipv6Value(base) >> shift;
}

function ipv4OfValue(value: bigint): string {
  const v4 = Number(value & 0xffffffffn);
  return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".");
}

/** Whether an IP address is on the public internet; anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    return !IPV4_NOT_PUBLIC.some((range) => inIpv4(value, range));
  }
  if (family !== 6) return false;
  const value = ipv6Value(address);
  // An IPv4 address mapped into IPv6, or translated by NAT64: read the IPv4 one.
  if (inIpv6(value, ["::ffff:0:0", 96]) || inIpv6(value, ["64:ff9b::", 96])) {
    return isPublicAddress(ipv4OfValue(value));
  }
  // Only global unicast is on the internet: loopback, unspecified, unique
  // local, link-local, multicast and every other prefix are not.
  if (!inIpv6(value, ["2000::", 3])) return false;
  return !IPV6_NOT_PUBLIC.some((range) => inIpv6(value, range));
}

/**
 * What kind of address a name answered, as a refusal names it
 * (docs/task-browser.md, "Where a page may go"): public, this computer,
 * a private network such as an office or VPN network (10/8, 172.16/12,
 * 192.168/16, the shared range 100.64/10 that VPN services such as
 * Tailscale give, and IPv6 unique local fc00::/7), or reserved - every
 * other address that is not on the internet, such as the 0.0.0.0 a DNS
 * filter answers or the 198.18/15 a proxy app gives. An IPv4 address mapped
 * into IPv6 or translated by NAT64 is read by its IPv4 address.
 */
export type AddressKind = "public" | "this-computer" | "private" | "reserved";

const IPV4_PRIVATE: readonly [string, number][] = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

export function addressKind(address: string): AddressKind {
  if (isPublicAddress(address)) return "public";
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    if (inIpv4(value, ["127.0.0.0", 8])) return "this-computer";
    return IPV4_PRIVATE.some((range) => inIpv4(value, range)) ? "private" : "reserved";
  }
  if (family !== 6) return "reserved";
  const value = ipv6Value(address);
  if (inIpv6(value, ["::ffff:0:0", 96]) || inIpv6(value, ["64:ff9b::", 96])) {
    return addressKind(ipv4OfValue(value));
  }
  if (value === 1n) return "this-computer";
  return inIpv6(value, ["fc00::", 7]) ? "private" : "reserved";
}

/**
 * The IP address a URL's hostname writes out, without an IPv6 address's
 * brackets; nothing when it names a host instead. `URL` has already turned
 * every other way of writing an IPv4 address into dotted decimal.
 */
export function literalAddress(hostname: string): string | undefined {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) ? bare : undefined;
}
