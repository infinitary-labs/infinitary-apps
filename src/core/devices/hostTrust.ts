import { createHash } from "node:crypto";
import { z } from "zod";
import { hostPlatform } from "../platform";

/**
 * The check Firstmate keeps for a Mac it reached by its address
 * (docs/devices.md, "Your yes on the check line"). The captain compares the
 * line with the one that Mac shows, and a yes is remembered here, never in
 * the captain's SSH settings. A later reach of that address is checked
 * against this, and one that answers unlike it is refused before anything
 * is sent.
 */

export const hostKeySchema = z.strictObject({
  /** SSH's name for the key, such as `ssh-ed25519`. */
  type: z.string().min(1).max(64),
  /** The key itself, base64, as a known-hosts line carries it. */
  publicKey: z.string().min(1).max(4096),
  /** The line the captain compared, such as `ED25519 SHA256:…`. */
  line: z.string().min(1).max(160),
});
export type HostKey = z.infer<typeof hostKeySchema>;

export const hostTrustFileSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.record(z.string().min(1).max(255), hostKeySchema),
});
export type HostTrustFile = z.infer<typeof hostTrustFileSchema>;

/** The file DevicePairing keeps the yeses in, beside the device list. */
export const HOST_TRUST_FILE = "host-trust.json";
/** The known-hosts file SSH reads for those yeses, never the captain's. */
export const HOST_TRUST_KNOWN_HOSTS = "known_hosts";

/** Modern signature algorithms for an RSA host key, still stored as `ssh-rsa`. */
export const RSA_HOST_KEY_ALGORITHMS = "rsa-sha2-512,rsa-sha2-256";

const TYPE_LABEL: Record<string, string> = {
  "ssh-ed25519": "ED25519",
  "ecdsa-sha2-nistp256": "ECDSA",
  "ecdsa-sha2-nistp384": "ECDSA",
  "ecdsa-sha2-nistp521": "ECDSA",
  "ssh-rsa": "RSA",
};

/** Which key to show when a Mac offers more than one: the one SSH prefers. */
const TYPE_RANK = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ssh-rsa"];

/** The check line for a key: its type, then the SHA256 line that Mac shows. */
export function checkLine(type: string, publicKey: string): string {
  const label = TYPE_LABEL[type] ?? type;
  return `${label} SHA256:${sha256Fingerprint(publicKey)}`;
}

/** SHA256 of the key, base64 without padding, as OpenSSH prints it. */
export function sha256Fingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
}

/** The key to remember when a scan printed several, or null when none is one. */
export function preferHostKey(
  keys: readonly { type: string; publicKey: string }[],
): HostKey | null {
  const ranked = [...keys].sort((left, right) => rank(left.type) - rank(right.type));
  const chosen = ranked[0];
  if (!chosen || !/^[A-Za-z0-9+/=]+$/.test(chosen.publicKey)) return null;
  return { ...chosen, line: checkLine(chosen.type, chosen.publicKey) };
}

function rank(type: string): number {
  const at = TYPE_RANK.indexOf(type);
  return at === -1 ? TYPE_RANK.length : at;
}

/** Whether two keys are the same key, not merely the same line. */
export function sameHostKey(left: HostKey, right: HostKey): boolean {
  return left.type === right.type && left.publicKey === right.publicKey && left.line === right.line;
}

/**
 * The name SSH looks the key up under, so the captain's own known hosts are
 * never read and a port in their settings cannot point the check elsewhere.
 * Letters and digits only, never a dash at the start.
 */
export function hostAlias(address: string): string {
  return `fm${createHash("sha256").update(address).digest("hex").slice(0, 32)}`;
}

export function knownHostsLine(address: string, key: HostKey): string {
  return `${hostAlias(address)} ${key.type} ${key.publicKey}`;
}

/**
 * A path as one word of an SSH option. SSH splits an option's value at
 * spaces, and a known-hosts option takes several files, so Firstmate's own
 * folder under Application Support would read as two files that do not
 * exist. Quoted, it stays one. SSH reads a backslash in a quoted word as an
 * escape, so a Windows path is written with forward slashes, which Windows'
 * own ssh reads as the same path.
 */
export function sshPathWord(path: string, platform: string = hostPlatform()): string {
  const written = platform === "win32" ? path.replace(/\\/g, "/") : path;
  if (/["\\]/.test(written))
    throw new Error("A path SSH reads may not hold a quote or a backslash.");
  return `"${written}"`;
}

/**
 * What an ssh Firstmate starts adds so it checks the remembered key and
 * writes nothing of the captain's. Empty when nothing is remembered: SSH
 * then reads the captain's own, as it always has. A command that asks
 * known hosts elsewhere is turned off, so the remembered key is the only
 * one SSH takes.
 */
export function hostTrustSshOptions(
  knownHostsFile: string,
  address: string,
  key: HostKey,
): string[] {
  return [
    "-o",
    `UserKnownHostsFile=${sshPathWord(knownHostsFile)}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "HashKnownHosts=no",
    "-o",
    `HostKeyAlias=${hostAlias(address)}`,
    "-o",
    `HostKeyAlgorithms=${key.type === "ssh-rsa" ? RSA_HOST_KEY_ALGORITHMS : key.type}`,
  ];
}
