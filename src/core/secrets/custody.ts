import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Platform custody holds only what the Secrets owner cannot protect on its own
 * (docs/secrets.md, "Native custody"): the root key that seals every value and
 * keys every integrity check, and the head of the protected authority record,
 * which stops an older valid record from being put back. Values never live here.
 */
export type CustodySlot = "root" | "authority-head";

export type CustodyRead =
  | { kind: "value"; bytes: Buffer }
  | { kind: "absent" }
  /** The store exists but is locked; reading it would need the person. */
  | { kind: "locked" }
  /** No protected store is reachable: no Keychain, no Secret Service, no session. */
  | { kind: "unavailable" };

export type CustodyWrite = "stored" | "locked" | "unavailable";

/**
 * Host capability, effects only: macOS Keychain (`src/main/host/darwinSecretCustody.ts`)
 * and the Linux Secret Service (`src/main/host/linuxSecretCustody.ts`). An
 * adapter reports what the platform answered and never falls back to a file,
 * an environment variable or a plaintext store.
 */
export interface SecretCustody {
  read(slot: CustodySlot): Promise<CustodyRead>;
  /** A lost write reply rejects; it is not a definite locked/unavailable refusal. */
  write(slot: CustodySlot, bytes: Buffer): Promise<CustodyWrite>;
}

/** Why the owner cannot open: the person must act, or this computer has no custody. */
export type CustodyRefusal = "locked" | "unavailable" | "uninitialized" | "lost";

/** What each derived key protects. One root, separate keys, so no key does two jobs. */
type Purpose = "values" | "entries" | "authority" | "journal";

const ROOT_BYTES = 32;

/**
 * The root key, read from custody once per open and never written anywhere
 * else. Subkeys are derived (HKDF-SHA256) so a value seal, an entry check, the
 * authority record and the journal never share a key.
 */
export class RootKeys {
  private readonly keys: Map<Purpose, Buffer>;
  /** Fingerprint of the root, to notice a different key under the same custody slot. */
  readonly fingerprint: string;

  private constructor(root: Buffer) {
    const purposes: Purpose[] = ["values", "entries", "authority", "journal"];
    this.keys = new Map(
      purposes.map((purpose) => [
        purpose,
        Buffer.from(hkdfSync("sha256", root, "infinitary-secrets", purpose, 32)),
      ]),
    );
    this.fingerprint = createHash("sha256").update(root).digest("hex").slice(0, 16);
    root.fill(0);
  }

  /**
   * Read the root from custody. `initialize` creates one only when nothing has
   * ever been sealed here: a missing root beside existing records is `lost`,
   * never silently replaced (that would orphan every sealed value).
   */
  static async open(
    custody: SecretCustody,
    options: { initialize: boolean; hasRecords: boolean },
  ): Promise<RootKeys | CustodyRefusal> {
    let read: CustodyRead;
    try {
      read = await custody.read("root");
    } catch {
      return "unavailable";
    }
    if (read.kind === "value") {
      try {
        if (read.bytes.length !== ROOT_BYTES) return "lost";
        return new RootKeys(read.bytes);
      } finally {
        read.bytes.fill(0);
      }
    }
    if (read.kind !== "absent") return read.kind;
    if (options.hasRecords) return "lost";
    if (!options.initialize) return "uninitialized";
    const root = randomBytes(ROOT_BYTES);
    let written: CustodyWrite;
    const copy = Buffer.from(root);
    try {
      written = await custody.write("root", copy);
    } catch {
      written = "unavailable";
    } finally {
      copy.fill(0);
    }
    if (written !== "stored") {
      root.fill(0);
      return written;
    }
    return new RootKeys(root);
  }

  destroy(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  key(purpose: Purpose): Buffer {
    const key = this.keys.get(purpose);
    if (!key) throw new Error("Unknown key purpose.");
    return key;
  }

  mac(purpose: Purpose, text: string): string {
    return createHmac("sha256", this.key(purpose)).update(text).digest("hex");
  }

  verify(purpose: Purpose, text: string, mac: unknown): boolean {
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    return timingSafeEqual(Buffer.from(this.mac(purpose, text), "hex"), Buffer.from(mac, "hex"));
  }
}

/** Canonical JSON: sorted keys, so one fact has one digest whatever built it. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Write a private file whole or not at all: a 0600 temporary file, synced,
 * renamed over the old one, and the directory synced so the rename survives a
 * power cut. Nothing reads a half-written record.
 */
export async function writePrivateFile(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch {
    // Some filesystems refuse to sync a directory; the rename itself is still atomic.
  } finally {
    await handle.close();
  }
}
