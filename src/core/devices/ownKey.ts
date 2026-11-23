import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hostEnv } from "../hostEnv";
import { systemSshTool } from "./ssh";

/**
 * Firstmate's own SSH key (docs/devices.md, "The password, once"): made the
 * first time a Mac does not let the captain's key in, and kept in its own
 * folder in the devices folder, 0700, with both halves 0600. Its public half
 * is what the captain's password places on that Mac, once. A later reach of
 * an address where it was placed offers it first and only it, with the keys
 * the captain's SSH settings name, so the captain's agent is not asked there.
 * The private half never leaves this Mac and is never added to an agent.
 */

/** The folder in the devices folder that holds the key; it appears whole or not at all. */
export const OWN_KEY_FOLDER = "ssh-key";
/** The addresses where the key was placed, beside it. */
export const OWN_KEY_PLACED_FILE = "ssh-key-placed.json";
const PRIVATE_FILE = "id_ed25519";
const PUBLIC_FILE = `${PRIVATE_FILE}.pub`;
/** How the key names itself in that Mac's `authorized_keys`. */
export const OWN_KEY_COMMENT = "infinitary";
/**
 * Every comment a key of this kind may carry: the one this app writes, and
 * Firstmate 3000's, which a key made before the Infinitary rename keeps.
 */
export const OWN_KEY_COMMENTS = [OWN_KEY_COMMENT, "firstmate-3000"] as const;
const KEYGEN_TIMEOUT_MS = 15_000;

export const ownKeyPlacedSchema = z.strictObject({
  version: z.literal(1),
  addresses: z.array(z.string().min(1).max(255)).max(4096),
});

/** The public half as one `authorized_keys` line. */
const PUBLIC_LINE = new RegExp(
  `^ssh-ed25519 [A-Za-z0-9+/]+={0,2} (?:${OWN_KEY_COMMENTS.join("|")})$`,
);

export type OwnKey = {
  /** The private half, which `ssh -i` reads. */
  privatePath: string;
  /** The public half, as that Mac's `authorized_keys` takes it. */
  publicLine: string;
};

export function readOwnKey(dir: string): OwnKey | null {
  const folder = join(dir, OWN_KEY_FOLDER);
  const privatePath = join(folder, PRIVATE_FILE);
  try {
    const publicLine = readFileSync(join(folder, PUBLIC_FILE), "utf8").trim();
    if (!PUBLIC_LINE.test(publicLine) || !existsSync(privatePath)) return null;
    return { privatePath, publicLine };
  } catch {
    return null;
  }
}

/**
 * The key in `dir`, made when there is none: ssh-keygen writes both halves
 * into a fresh folder only this user may enter, which then takes its place
 * in one step, so a key is never half there. One left broken is replaced.
 */
export async function makeOwnKey(dir: string): Promise<OwnKey> {
  const kept = readOwnKey(dir);
  if (kept) return kept;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = mkdtempSync(join(dir, `.${OWN_KEY_FOLDER}-`));
  try {
    chmodSync(fresh, 0o700);
    const made = await keygen(join(fresh, PRIVATE_FILE));
    if (made !== 0) throw new Error("Infinitary could not make its own SSH key.");
    chmodSync(join(fresh, PRIVATE_FILE), 0o600);
    chmodSync(join(fresh, PUBLIC_FILE), 0o600);
    const folder = join(dir, OWN_KEY_FOLDER);
    // Another add made one meanwhile: that one stays.
    const raced = readOwnKey(dir);
    if (raced) return raced;
    rmSync(folder, { recursive: true, force: true });
    renameSync(fresh, folder);
    const key = readOwnKey(dir);
    if (!key) throw new Error("Infinitary could not make its own SSH key.");
    return key;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

/**
 * What an ssh Firstmate starts adds for an address where its key is placed:
 * the key first, only the keys named (`IdentitiesOnly`), and none of them
 * handed to an agent.
 */
export function ownKeySshOptions(key: OwnKey): string[] {
  return ["-i", key.privatePath, "-o", "IdentitiesOnly=yes", "-o", "AddKeysToAgent=no"];
}

/** ssh-keygen's exit code, with no passphrase and Firstmate's comment. */
function keygen(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      systemSshTool("ssh-keygen"),
      ["-q", "-t", "ed25519", "-N", "", "-C", OWN_KEY_COMMENT, "-f", path],
      { env: hostEnv(), stdio: ["ignore", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), KEYGEN_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}
