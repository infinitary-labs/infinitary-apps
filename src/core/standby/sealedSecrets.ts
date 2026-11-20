import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writePrivate } from "../devices/identity";

/**
 * The first mate's secrets as each computer that keeps a copy holds them
 * (docs/devices.md, "Secrets on a computer that keeps a copy"): one sealed
 * archive of the values (`sealRecovery`, under a fresh random key each time),
 * and that key sealed again to each such computer's own lock, an X25519 key
 * whose private half never leaves that computer's own keychain. The file is
 * part of the record, so it reaches every copy like any other change; only a
 * computer whose lock has a key in it can open the archive.
 */

/**
 * The one file, one of `RECORD_ROOTS`: the archive and its keys change
 * together, in one write. It sits beside the other device files, whose folder
 * the stream watches from the start, so each write reaches the copies at once.
 */
export const SEALED_SECRETS_FILE = "devices/standby-secrets.json";
/** Each computer's lock the captain confirmed there, by its id: part of the record, so a move or a takeover keeps them. */
export const STANDBY_LOCKS_FILE = "devices/standby-locks.json";

const INFO = "infinitary-standby-secrets/1";
// File-format fields, not resource limits.
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

const lockKeySchema = z.object({
  device: z.string().min(1).max(64),
  /** The lock's public half, X25519 SPKI DER as base64. */
  key: base64.max(200),
});

const sealedKeySchema = lockKeySchema.extend({
  /** The one-time X25519 key the archive's key was sealed with, SPKI DER as base64. */
  ephemeral: base64.max(200),
  nonce: base64.max(32),
  /** The archive's key and its tag, under the key both halves agree on. */
  sealed: base64.max(128),
});

export const sealedSecretsSchema = z.object({
  format: z.literal(1),
  /** The Secrets home that wrote it (`Authority.home`): a home never opens its own. */
  source: z.string().min(1).max(64),
  /** What it was made of, so the home writes it again only when that changed. */
  made: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.number().int().nonnegative(),
  /** The recovery archive (`sealRecovery`) as base64. */
  archive: base64,
  keys: z.array(sealedKeySchema).max(64),
});
export type SealedSecrets = z.infer<typeof sealedSecretsSchema>;

export const standbyLocksSchema = z.object({
  locks: z.array(lockKeySchema.extend({ at: z.number().int().nonnegative() })).max(64),
});
export type StandbyLocks = z.infer<typeof standbyLocksSchema>;
export type StandbyLockKey = z.infer<typeof lockKeySchema>;

/** A computer's lock as its keychain keeps it: never sent anywhere but its public half. */
const heldLockSchema = z.object({
  format: z.literal(1),
  privateKey: base64,
  publicKey: base64,
});
export type HeldLock = z.infer<typeof heldLockSchema>;

/** A new lock, made on the computer that keeps it, once the captain confirmed there. */
export function makeLock(): HeldLock {
  const pair = generateKeyPairSync("x25519");
  return {
    format: 1,
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** A lock read back from its keychain item; undefined when it is not one. */
export function readHeldLock(bytes: Buffer): HeldLock | undefined {
  try {
    const parsed = heldLockSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function publicKeyOf(base64Key: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Key, "base64"), format: "der", type: "spki" });
}

/** Whether a public half is an X25519 key this format can seal to. */
export function isLockKey(base64Key: string): boolean {
  try {
    return publicKeyOf(base64Key).asymmetricKeyType === "x25519";
  } catch {
    return false;
  }
}

function keyEncryptionKey(
  shared: Buffer,
  ephemeral: string,
  lock: string,
  archiveDigest: Buffer,
): Buffer {
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        Buffer.concat([Buffer.from(ephemeral, "base64"), Buffer.from(lock, "base64")]),
        Buffer.concat([Buffer.from(INFO), archiveDigest]),
        KEY_BYTES,
      ),
    );
  } finally {
    shared.fill(0);
  }
}

/**
 * Seals the archive's key to each lock, bound to that exact archive: a key
 * from one archive never opens another.
 */
export function sealKeyTo(
  lock: StandbyLockKey,
  archive: Buffer,
  key: Buffer,
): SealedSecrets["keys"][number] {
  const one = generateKeyPairSync("x25519");
  const ephemeral = one.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const digest = createHash("sha256").update(archive).digest();
  const kek = keyEncryptionKey(
    diffieHellman({ privateKey: one.privateKey, publicKey: publicKeyOf(lock.key) }),
    ephemeral,
    lock.key,
    digest,
  );
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    cipher.setAAD(digest);
    const sealed = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
    return {
      device: lock.device,
      key: lock.key,
      ephemeral,
      nonce: nonce.toString("base64"),
      sealed: sealed.toString("base64"),
    };
  } finally {
    kek.fill(0);
  }
}

/**
 * The archive's key, opened with this computer's own lock: undefined when
 * the file holds no key for it, or one that does not open.
 */
export function openKeyWith(held: HeldLock, sealed: SealedSecrets): Buffer | undefined {
  const mine = sealed.keys.find((each) => each.key === held.publicKey);
  if (!mine) return undefined;
  const archive = Buffer.from(sealed.archive, "base64");
  const digest = createHash("sha256").update(archive).digest();
  const privateDer = Buffer.from(held.privateKey, "base64");
  let kek: Buffer | undefined;
  try {
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    kek = keyEncryptionKey(
      diffieHellman({ privateKey, publicKey: publicKeyOf(mine.ephemeral) }),
      mine.ephemeral,
      mine.key,
      digest,
    );
    const body = Buffer.from(mine.sealed, "base64");
    if (body.length !== KEY_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(mine.nonce, "base64"));
    decipher.setAAD(digest);
    decipher.setAuthTag(body.subarray(KEY_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, KEY_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  } finally {
    privateDer.fill(0);
    kek?.fill(0);
  }
}

/** The sealed file in a record, or undefined when there is none or it is not one. */
export function readSealedSecrets(record: string): SealedSecrets | undefined {
  try {
    const parsed = sealedSecretsSchema.safeParse(
      JSON.parse(readFileSync(join(record, ...SEALED_SECRETS_FILE.split("/")), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the record's sealed file holds a key for this computer: what both
 * the Ready list for a copy and a move's say, so they never disagree.
 */
export function sealedFor(record: string, deviceId: string): boolean {
  return readSealedSecrets(record)?.keys.some((each) => each.device === deviceId) ?? false;
}

/** Written whole, in one rename, so a copy never holds an archive beside another's keys. */
export function writeSealedSecrets(record: string, sealed: SealedSecrets | null): void {
  const file = join(record, ...SEALED_SECRETS_FILE.split("/"));
  if (sealed === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writePrivate(file, `${JSON.stringify(sealed)}\n`);
}

/**
 * The exact sealed file this computer's first mate took the values from,
 * kept beside the record and never in it: a copy that still holds that very
 * file after the values were taken - the app stopped before sealing again -
 * is known as taken, not as values of this computer's own. A later file from
 * the same home, sealed after newer changes, never matches.
 */
export const TAKEN_SECRETS_FILE = "standby-secrets-taken.json";

/** What names one sealed file exactly: its home, what it was made from, and when. */
export function sealedFileId(sealed: SealedSecrets): string {
  return `${sealed.source}:${sealed.made}:${sealed.at}`;
}

export function readTakenFile(userData: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(userData, TAKEN_SECRETS_FILE), "utf8")) as unknown;
    return parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { file?: unknown }).file === "string"
      ? (parsed as { file: string }).file
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeTakenFile(userData: string, sealed: SealedSecrets): void {
  mkdirSync(userData, { recursive: true });
  writePrivate(
    join(userData, TAKEN_SECRETS_FILE),
    `${JSON.stringify({ file: sealedFileId(sealed) })}\n`,
  );
}

export function readStandbyLocks(record: string): StandbyLocks {
  try {
    return standbyLocksSchema.parse(
      JSON.parse(readFileSync(join(record, ...STANDBY_LOCKS_FILE.split("/")), "utf8")),
    );
  } catch {
    return { locks: [] };
  }
}

export function writeStandbyLocks(record: string, locks: StandbyLocks): void {
  const file = join(record, ...STANDBY_LOCKS_FILE.split("/"));
  if (locks.locks.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writePrivate(file, `${JSON.stringify(locks, null, 2)}\n`);
}
