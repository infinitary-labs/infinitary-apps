import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

/**
 * A key of the home's or a device's own (docs/devices.md, "Keys"): an ECDSA
 * P-256 key pair and a self-signed certificate that carries it, so each side
 * can show it in TLS. The other side trusts it because the key hashes to the
 * pin it holds - never because of a name or a date in the certificate,
 * which is only the envelope TLS needs.
 */
export type KeyIdentity = {
  /** The private key, PKCS#8 PEM. */
  readonly key: string;
  /** The self-signed certificate, PEM. */
  readonly cert: string;
  /** SHA-256 of the public key's SubjectPublicKeyInfo, base64url. */
  readonly pin: string;
};

const KEY_FILE = "home-key.pem";
const CERT_FILE = "home-cert.pem";

export function keyPin(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url");
}

export function peerPin(socket: unknown): string | null {
  const tls = socket as Partial<TLSSocket> | null;
  const certificate =
    typeof tls?.getPeerX509Certificate === "function" ? tls.getPeerX509Certificate() : undefined;
  return certificate ? keyPin(certificate.publicKey) : null;
}

/** A fresh key and its certificate, kept nowhere: the caller keeps them. */
export function createKeyIdentity(name: string): KeyIdentity {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return identityOf(privateKey, name);
}

function identityOf(privateKey: KeyObject, name: string): KeyIdentity {
  const publicKey = createPublicKey(privateKey);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: selfSignedCertificate(privateKey, publicKey, name).toString(),
    pin: keyPin(publicKey),
  };
}

/**
 * Reads the home's key from `dir`, or makes one when there is none. Both
 * files are 0600 in a 0700 folder. The key is never replaced while it is
 * there, since a new key would cut every paired device off: a missing
 * certificate is built again from it, and a certificate that does not
 * carry it is refused.
 */
export function loadOrCreateHomeIdentity(dir: string): KeyIdentity {
  const keyPath = join(dir, KEY_FILE);
  const certPath = join(dir, CERT_FILE);
  if (existsSync(keyPath)) {
    chmodSync(dir, 0o700);
    chmodSync(keyPath, 0o600);
    const key = readFileSync(keyPath, "utf8");
    if (!existsSync(certPath)) {
      const rebuilt = identityOf(createPrivateKey(key), "Firstmate home");
      writePrivate(certPath, rebuilt.cert);
      return { ...rebuilt, key };
    }
    chmodSync(certPath, 0o600);
    const cert = readFileSync(certPath, "utf8");
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(createPrivateKey(key)))
      throw new Error("The home's saved key does not match its certificate.");
    return { key, cert, pin: keyPin(parsed.publicKey) };
  }
  const made = createKeyIdentity("Firstmate home");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(certPath, made.cert);
  // The key lands last: a folder holding a key always holds its certificate.
  writePrivate(keyPath, made.key);
  return made;
}

export function writePrivate(path: string, text: string | Uint8Array): void {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// The smallest DER a TLS stack accepts as a certificate: X.509 v3, an
// ECDSA-with-SHA-256 signature by the key it carries, one common name, a
// century of validity (no side reads it), and no extensions. Dates before
// 2050 are UTCTime and later ones GeneralizedTime, as RFC 5280 asks, so a
// strict parser reads it too.
function selfSignedCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  commonName: string,
): X509Certificate {
  // A positive serial whose first byte is never zero, so its DER is minimal.
  const serial = randomBytes(16);
  serial[0] = 0x40 | ((serial[0] ?? 0) & 0x3f);
  const name = sequence(set(sequence(objectId("2.5.4.3"), utf8(commonName))));
  const signatureAlgorithm = sequence(objectId("1.2.840.10045.4.3.2"));
  const tbs = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    signatureAlgorithm,
    name,
    sequence(certificateTime(Date.UTC(2020, 0, 1)), certificateTime(Date.UTC(2120, 0, 1))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return new X509Certificate(
    sequence(tbs, signatureAlgorithm, tagged(0x03, Buffer.from([0]), signature)),
  );
}

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tagged(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
const sequence = (...parts: Buffer[]) => tagged(0x30, ...parts);
const set = (...parts: Buffer[]) => tagged(0x31, ...parts);
const utf8 = (text: string) => tagged(0x0c, Buffer.from(text, "utf8"));
function integer(bytes: Buffer): Buffer {
  return tagged(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}
function certificateTime(ms: number): Buffer {
  const digits = new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return new Date(ms).getUTCFullYear() < 2050
    ? tagged(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"))
    : tagged(0x18, Buffer.from(`${digits}Z`, "ascii"));
}
function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const encoded = [arc & 0x7f];
    for (let high = arc >> 7; high > 0; high >>= 7) encoded.unshift(0x80 | (high & 0x7f));
    bytes.push(...encoded);
  }
  return tagged(0x06, Buffer.from(bytes));
}
