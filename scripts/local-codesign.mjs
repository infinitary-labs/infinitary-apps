#!/usr/bin/env node
// The stable local macOS code identity shared by `pnpm dev` and `pnpm package:mac`.
//
// macOS pins a Keychain "Always Allow" grant to the requesting binary's
// DESIGNATED REQUIREMENT. Ad-hoc code (`codesign -s -`) names no signer, so
// its designated requirement degrades to `cdhash H"..."` - the hash of that
// one build. Electron's downloaded Electron.app is linker-signed ad-hoc and
// the dev packaging overlay used to ad-hoc sign the local app too, so every
// `pnpm install`, Electron bump, or rebuild produced a new cdhash (and, for
// the dev run, a new pnpm store path) and the captain was asked for the
// Claude credential again.
//
// A self-signed LOCAL certificate fixes the identity rather than the prompt:
// a signature made with a real leaf certificate has the designated requirement
//
//   identifier "<signing identifier>" and certificate leaf = H"<cert sha1>"
//
// which mentions no path, no cdhash, and no Electron version. Both local
// forms sign with the same certificate AND the same identifier, so a single
// grant covers the dev run and the local package alike.
//
// The certificate, its key, and the keychain holding them are generated on
// the developer's machine, live outside the repository and outside
// node_modules (so a reinstall cannot take them with it), and never leave
// the machine. Nothing here touches the production Developer ID identity,
// which stays the only signer of release builds (docs/architecture.md
// section 10).
//
// Why a dedicated keychain and not the login keychain: the login keychain's
// password is the developer's, so an unattended import would have to ask for
// it. A generated keychain with a generated password can be created,
// unlocked, and made non-prompting (`set-key-partition-list`) with no
// interaction at all.
//
// Why the keychain joins the user search list ONLY while codesign runs:
// `codesign --keychain <file>` narrows the identity lookup to that file, but
// codesign still resolves the identity through the user search list - its
// manual says the file "will not be searched to resolve the signing
// identity's certificate chain unless it is also on the user's search list",
// and in practice an off-list file answers "no identity found", even by
// SHA-1. Leaving the file on the list for good makes every other `security`
// client (git's osxkeychain helper, on an HTTPS origin) trip over a keychain
// that locks after sleep, and `set-keychain-settings` (no password flag) on
// that locked file opens SecurityAgent - the dialog a routine `pnpm install`
// used to raise. So signing unlocks the file with its stored secret first,
// adds it to the list, signs, and takes it off again
// (`withLocalKeychainOnSearchList`); a routine install never adds it.
// `security find-identity -v` also hides this certificate (it is self-signed
// and untrusted - trusting it would need an authorization prompt we do not
// want in `pnpm install`). Untrusted is fine: codesign signs with it, and a
// designated requirement is a statement about which leaf certificate signed
// the code, not about who trusts that leaf.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Subject common name of the generated certificate, and the codesign identity name. */
export const LOCAL_IDENTITY_NAME = "Infinitary Local Dev";

/**
 * The code signature identifier both local forms sign with. It is the dev
 * overlay's appId (electron-builder.dev.yml), which the packaged app already
 * carries via its CFBundleIdentifier; the dev run's Electron.app is signed
 * with `--identifier` so the two produce the SAME designated requirement and
 * therefore share one Keychain grant.
 */
export const LOCAL_SIGNING_IDENTIFIER = "com.getinfinitary.infinitary.dev";

const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";
const CODESIGN = "/usr/bin/codesign";

/**
 * Written once the local keychain is known to be off the user search list,
 * and never removed by a signing step: a checkout from before the signing
 * lease decides its routine drop on this file alone, and must not take the
 * keychain off under a signer that holds a lease.
 */
const SEARCH_LIST_MARKER = "search-list-dropped";

/**
 * Present while a signing step may have the keychain on the list; removed
 * by the last one out. A signer killed mid-step leaves it behind, which is
 * how the next routine install knows to look.
 */
const SIGNING_IN_PROGRESS = "signing-in-progress";

/**
 * Held exclusively around every edit of the user search list, for as long as
 * a few `security` calls take - never across codesign.
 */
const SEARCH_LIST_LOCK = "search-list.lock";
const SEARCH_LIST_LOCK_TIMEOUT_MS = 60_000;

/** Held shared by every signing step, for as long as it needs the keychain on the list. */
const SIGNING_LEASE = "signing.lease";

// BSD open(2) flags that take a flock(2) lock atomically with the open. libuv
// passes open flags through untouched; node's fs.constants does not name them.
// The kernel drops the lock when the descriptor closes or the process dies, so
// a killed signer can never leave a lock or a lease behind.
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

/**
 * A setting by its name, `INFINITARY_<NAME>` or the older `FM3000_<NAME>`,
 * the newer winning when both are set (`src/shared/envSettings.ts`, which a
 * plain script cannot import), so a scratch folder named either way keeps
 * the real material out of reach.
 */
function setting(name) {
  return process.env[`INFINITARY_${name}`] ?? process.env[`FM3000_${name}`];
}

/**
 * Test seam. Honored only when the material directory is overridden, so a
 * normal install always uses the real tools.
 */
function tool(fallback, name) {
  const override = setting(name);
  if (override && setting("LOCAL_CODESIGN_DIR")) {
    return override;
  }
  return fallback;
}

function opensslBin() {
  return tool(OPENSSL, "OPENSSL_BIN");
}

function securityBin() {
  return tool(SECURITY, "SECURITY_BIN");
}

export function codesignBin() {
  return tool(CODESIGN, "CODESIGN_BIN");
}

/**
 * `security` exits with the low byte of the OSStatus. -25293,
 * errSecAuthFailed, is 51: the password does not open that keychain.
 */
const WRONG_PASSWORD_EXIT = 51;

/**
 * Run a tool and return its stdout. Errors name the tool and its subcommand
 * only: `security` takes the generated keychain secret on argv (it has no
 * stdin form), and that secret must never reach a log or a CI transcript.
 * The error carries the exit status.
 */
function run(file, args, input) {
  const result = spawnSync(file, args, { encoding: "utf8", input });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const what = `${file.split("/").pop()} ${args[0]}`;
    const error = new Error(`${what} failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout ?? "";
}

/**
 * Material directory. Overridable so tests never touch the real one.
 * The folder from before the Infinitary rename, ~/.firstmate-3000/local-codesign,
 * is never read, moved or deleted: it stays as it was, for a rollback.
 */
export function localCodesignDir() {
  return (
    setting("LOCAL_CODESIGN_DIR") ||
    join(homedir(), ".infinitary", "local-codesign")
  );
}

export function localCodesignPaths(dir = localCodesignDir()) {
  return {
    dir,
    certificate: join(dir, "local-codesign.cert.pem"),
    bundle: join(dir, "local-codesign.p12"),
    keychain: join(dir, "infinitary-local.keychain-db"),
    secret: join(dir, "secret"),
    requirement: join(dir, "designated-requirement.txt"),
  };
}

/** `SHA1 Fingerprint=85:E7:...` (openssl) -> `85e7...`. */
export function parseCertificateSha1(fingerprintOutput) {
  const match = /Fingerprint\s*=\s*([0-9A-Fa-f:]+)/.exec(fingerprintOutput);
  if (match === null) {
    throw new Error(`no SHA-1 fingerprint in openssl output: ${fingerprintOutput.trim()}`);
  }
  return match[1].replaceAll(":", "").toLowerCase();
}

/** The requirement macOS records when the grant is given, in codesign's own syntax. */
export function designatedRequirement(certificateSha1, identifier = LOCAL_SIGNING_IDENTIFIER) {
  return `identifier "${identifier}" and certificate leaf = H"${certificateSha1}"`;
}

/** `security list-keychains -d user` prints one indented, quoted path per line. */
export function parseKeychainSearchList(output) {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((line) => line.length > 0);
}

/**
 * `security find-identity <keychain>` lists every identity, valid or not -
 * ours is reported `(CSSMERR_TP_NOT_TRUSTED)`, which is expected and fine.
 * `-v` would hide it, so never use `-v` to decide whether to import.
 */
export function identityIsPresent(findIdentityOutput, name = LOCAL_IDENTITY_NAME) {
  return findIdentityOutput.includes(`"${name}"`);
}

function assertDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("local code signing is macOS-only");
  }
}

function generateMaterial(paths) {
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(paths.secret, `${secret}\n`, { mode: 0o600 });
  chmodSync(paths.secret, 0o600);

  const configPath = join(paths.dir, "openssl.cnf");
  const keyPath = join(paths.dir, "local-codesign.key.pem");
  writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3",
      "[dn]",
      `CN = ${LOCAL_IDENTITY_NAME}`,
      "[v3]",
      "basicConstraints = critical,CA:false",
      "keyUsage = critical,digitalSignature",
      "extendedKeyUsage = critical,codeSigning",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  try {
    // 20 years: the designated requirement pins the leaf certificate, so an
    // expiry would silently invalidate every grant made against it.
    run(opensslBin(), [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "7300",
      "-config", configPath, "-keyout", keyPath, "-out", paths.certificate,
    ]);
    chmodSync(keyPath, 0o600);
    run(opensslBin(), [
      "pkcs12", "-export", "-inkey", keyPath, "-in", paths.certificate,
      "-name", LOCAL_IDENTITY_NAME, "-out", paths.bundle, "-passout", `pass:${secret}`,
    ]);
    chmodSync(paths.bundle, 0o600);
  } finally {
    // The PKCS#12 bundle is the only copy of the key we keep; it is what lets
    // a lost keychain be rebuilt with the SAME certificate, which is what
    // keeps an existing grant valid.
    rmSync(keyPath, { force: true });
    rmSync(configPath, { force: true });
  }
}

function sameKeychain(left, right) {
  const resolve = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(left) === resolve(right);
}

/**
 * The list `security list-keychains -s` may write. Refuses an empty read and
 * a rewrite that would leave the developer with no keychain at all: `-s`
 * replaces the list, and dropping the login keychain is not ours to do.
 */
export function searchListWithout(current, keychainPath) {
  if (current.length === 0) {
    throw new Error("the user keychain search list read back empty - refusing to replace it");
  }
  const kept = current.filter((entry) => !sameKeychain(entry, keychainPath));
  if (kept.length === 0) {
    throw new Error("refusing to replace the user keychain search list with an empty list");
  }
  return { kept, removed: kept.length !== current.length };
}

/** Rewrite the list without the local keychain. Caller holds the search-list lock. */
function dropFromSearchList(paths, log) {
  const current = parseKeychainSearchList(run(securityBin(), ["list-keychains", "-d", "user"]));
  const { kept, removed } = searchListWithout(current, paths.keychain);
  if (removed) {
    run(securityBin(), ["list-keychains", "-d", "user", "-s", ...kept]);
    log("removed the local signing keychain from the user keychain search list");
  }
  writeFileSync(join(paths.dir, SEARCH_LIST_MARKER), "dropped\n", { mode: 0o600 });
  rmSync(join(paths.dir, SIGNING_IN_PROGRESS), { force: true });
  return removed;
}

/**
 * Take the keychain off the list unless a live signing step still needs it
 * there - that step takes it off itself when it is the last one out. Caller
 * holds the search-list lock.
 */
function dropUnlessSigning(paths, log) {
  const lease = tryLock(join(paths.dir, SIGNING_LEASE), O_EXLOCK);
  if (lease === null) {
    return false;
  }
  try {
    return dropFromSearchList(paths, log);
  } finally {
    closeSync(lease);
  }
}

/**
 * Take the local signing keychain off the user search list. `once` skips the
 * `security` call after a previous successful drop (the routine install path).
 * A signing step in progress keeps it on the list: this never pulls it out
 * from under another worktree's codesign.
 */
export function dropLocalKeychainFromSearchList({ log = () => {}, once = true } = {}) {
  assertDarwin();
  const paths = localCodesignPaths();
  const listKnownClean = () =>
    existsSync(join(paths.dir, SEARCH_LIST_MARKER)) &&
    !existsSync(join(paths.dir, SIGNING_IN_PROGRESS));
  if (once && listKnownClean()) {
    return false;
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return withSearchListLock(paths, () => {
    if (once && listKnownClean()) {
      return false;
    }
    return dropUnlessSigning(paths, log);
  });
}

/** The list with the local keychain appended, refusing an empty read like `searchListWithout`. */
export function searchListWith(current, keychainPath) {
  if (current.length === 0) {
    throw new Error("the user keychain search list read back empty - refusing to replace it");
  }
  if (current.some((entry) => sameKeychain(entry, keychainPath))) {
    return { list: current, added: false };
  }
  return { list: [...current, keychainPath], added: true };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Open `path` holding a `kind` flock, or null when a conflicting lock is held. */
function tryLock(path, kind) {
  try {
    return openSync(
      path,
      constants.O_RDONLY | constants.O_CREAT | constants.O_NONBLOCK | kind,
      0o600,
    );
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
      return null;
    }
    throw error;
  }
}

/**
 * One edit of the user search list at a time per machine. `security
 * list-keychains -s` replaces the whole list, so two read-modify-write
 * sequences that interleave lose one of the edits. Every worktree shares the
 * one material directory and the one user search list. The release workflow's
 * throwaway keychain edits that same list through `runUnderSearchListLock`.
 */
function withSearchListLock(paths, fn) {
  const path = join(paths.dir, SEARCH_LIST_LOCK);
  const deadline = Date.now() + SEARCH_LIST_LOCK_TIMEOUT_MS;
  let fd = tryLock(path, O_EXLOCK);
  while (fd === null) {
    if (Date.now() > deadline) {
      throw new Error(`another local signing step still holds ${path}`);
    }
    sleepSync(10);
    fd = tryLock(path, O_EXLOCK);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
  }
}

function prepareSearchListLock() {
  assertDarwin();
  const paths = localCodesignPaths();
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

/**
 * Run `command` while holding the search-list lock. The lock drops when this
 * returns, including when `command` fails; a killed process drops it too.
 * Returns the command's exit status and does not log its arguments.
 */
export function runUnderSearchListLock(command, args) {
  const paths = prepareSearchListLock();
  return withSearchListLock(paths, () => {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      throw new Error(`${command} killed by ${result.signal}`);
    }
    return result.status ?? 1;
  });
}

/**
 * Put `keychainPath` first on the user search list, under the search-list
 * lock. Refuses an empty read, so a release cannot replace the list with only
 * its throwaway keychain. A path already on the list moves to the front
 * instead of being written twice.
 */
export function prependKeychainOnSearchList(keychainPath) {
  if (
    typeof keychainPath !== "string" ||
    keychainPath.length === 0 ||
    keychainPath.includes("\0")
  ) {
    throw new Error("refusing to edit the user keychain search list without a keychain path");
  }
  const paths = prepareSearchListLock();
  return withSearchListLock(paths, () => {
    const current = parseKeychainSearchList(run(securityBin(), ["list-keychains", "-d", "user"]));
    if (current.length === 0) {
      throw new Error("the user keychain search list read back empty - refusing to replace it");
    }
    const rest = current.filter((entry) => !sameKeychain(entry, keychainPath));
    const list = [keychainPath, ...rest];
    const changed =
      list.length !== current.length || list.some((entry, index) => entry !== current[index]);
    if (changed) {
      run(securityBin(), ["list-keychains", "-d", "user", "-s", ...list]);
    }
    return { list, changed };
  });
}

/**
 * Run `sign` (sync or async) with the local keychain unlocked and on the user
 * search list, then take it off again. codesign needs the list; nothing else
 * may see the file there. The keychain is unlocked with its stored secret
 * BEFORE it joins the list, so no other client ever meets it locked, and the
 * in-progress file is written first, so a signer killed mid-step leaves the
 * next routine install to drop it.
 *
 * Signing steps never wait for each other: each holds a shared lease for as
 * long as it signs, and only the last one out takes the keychain off the
 * list. A `pnpm package:mac` in one worktree therefore does not hold up a
 * `pnpm dev` in another.
 */
export function withLocalKeychainOnSearchList(sign, { log = () => {} } = {}) {
  assertDarwin();
  const paths = localCodesignPaths();
  unlockKeychain(paths);
  const lease = withSearchListLock(paths, () => {
    // Nobody holds the lease exclusively outside the search-list lock, so a
    // shared lock here never has to wait.
    const fd = tryLock(join(paths.dir, SIGNING_LEASE), O_SHLOCK);
    if (fd === null) {
      throw new Error(`could not take a signing lease in ${paths.dir}`);
    }
    try {
      writeFileSync(join(paths.dir, SIGNING_IN_PROGRESS), "signing\n", { mode: 0o600 });
      const current = parseKeychainSearchList(
        run(securityBin(), ["list-keychains", "-d", "user"]),
      );
      const { list, added } = searchListWith(current, paths.keychain);
      if (added) {
        run(securityBin(), ["list-keychains", "-d", "user", "-s", ...list]);
      }
      return fd;
    } catch (error) {
      closeSync(fd);
      dropUnlessSigning(paths, log);
      throw error;
    }
  });
  const release = () =>
    withSearchListLock(paths, () => {
      closeSync(lease);
      dropUnlessSigning(paths, log);
    });
  let result;
  try {
    result = sign();
  } catch (error) {
    release();
    throw error;
  }
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    return result.finally(release);
  }
  release();
  return result;
}

function unlockKeychain(paths) {
  const secret = readFileSync(paths.secret, "utf8").trim();
  // Never `-u`. On this Mac that flag means "prompt for the password via GUI".
  const args = ["unlock-keychain", "-p", secret, paths.keychain];
  if (args.includes("-u")) {
    throw new Error("refusing unlock-keychain -u: that flag opens the password dialog");
  }
  run(securityBin(), args);
}

/**
 * Unlock with the stored secret; false when the keychain refuses it. That
 * refusal comes at once and raises no dialog. Any other failure throws.
 */
function unlockKeychainIfSecretOpensIt(paths) {
  try {
    unlockKeychain(paths);
    return true;
  } catch (error) {
    if (error.status === WRONG_PASSWORD_EXIT) {
      return false;
    }
    throw error;
  }
}

/**
 * True when the stored secret opens the PKCS#12 bundle and the bundle holds
 * the stored certificate, i.e. the keychain can be rebuilt without a new
 * certificate. openssl reads the secret from its file, not from argv.
 */
function bundleHoldsStoredCertificate(paths) {
  const fingerprint = (pem) =>
    parseCertificateSha1(run(opensslBin(), ["x509", "-noout", "-fingerprint", "-sha1"], pem));
  let bundled;
  try {
    bundled = run(opensslBin(), [
      "pkcs12", "-in", paths.bundle, "-nokeys", "-clcerts", "-passin", `file:${paths.secret}`,
    ]);
  } catch {
    return false;
  }
  return fingerprint(bundled) === fingerprint(readFileSync(paths.certificate, "utf8"));
}

function createKeychain(paths, log) {
  const secret = readFileSync(paths.secret, "utf8").trim();
  run(securityBin(), ["create-keychain", "-p", secret, paths.keychain]);
  log(`created keychain ${paths.keychain}`);
  // No inactivity timeout and no lock-on-sleep. Only safe immediately after
  // create: the new keychain is unlocked, and `set-keychain-settings` has no
  // password flag. On an existing locked file this call opens SecurityAgent
  // before unlock-keychain -p can run, which is the install dialog.
  run(securityBin(), ["set-keychain-settings", paths.keychain]);
}

/**
 * Make the keychain open with the stored secret and hold the identity.
 * Returns false, having changed nothing, when the keychain refuses the
 * stored secret and the bundle cannot rebuild it with the same certificate.
 */
function ensureKeychain(paths, log) {
  const secret = readFileSync(paths.secret, "utf8").trim();
  if (!existsSync(paths.keychain)) {
    createKeychain(paths, log);
  }
  // Take it off the search list before any call that opens the file. This
  // does not unlock the keychain. create-keychain adds the new file; an
  // older install may already have left it there. A live signing step keeps
  // it there and takes it off itself.
  dropUnlessSigning(paths, log);
  // Stop here if unlock fails. find-identity and import on a locked file can
  // raise the same dialog.
  if (!unlockKeychainIfSecretOpensIt(paths)) {
    // The keychain answers to some other password, so nothing can open it
    // without a dialog. The bundle keeps the key under the stored secret:
    // rebuild the keychain from it, and the certificate - and every grant
    // made against it - stays.
    if (!bundleHoldsStoredCertificate(paths)) {
      return false;
    }
    rmSync(paths.keychain, { force: true });
    createKeychain(paths, log);
    dropUnlessSigning(paths, log);
    unlockKeychain(paths);
    log("rebuilt the local signing keychain from its key bundle; the certificate is unchanged");
  }

  if (!identityIsPresent(run(securityBin(), ["find-identity", paths.keychain]))) {
    run(securityBin(), [
      "import", paths.bundle, "-k", paths.keychain, "-f", "pkcs12",
      "-P", secret, "-T", CODESIGN,
    ]);
    // Without a partition list every codesign call raises a GUI "allow access"
    // prompt - the exact class of prompt this whole change exists to remove.
    run(securityBin(), [
      "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
      "-s", "-k", secret, paths.keychain,
    ]);
    log(`imported the local signing identity into ${paths.keychain}`);
  }
  return true;
}

/** The requirement last written for this machine, or null if signing has never described it. */
export function readStoredRequirement(dir = localCodesignDir()) {
  const path = localCodesignPaths(dir).requirement;
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, "utf8").trim();
  return text.length > 0 ? text : null;
}

/**
 * Create the local signing material if it is absent, make it usable by
 * codesign, and describe it. Signing path only: a routine install that
 * already satisfies the stored requirement must not call this, because it
 * unlocks the local keychain.
 */
export function ensureLocalSigningIdentity({ log = () => {} } = {}) {
  assertDarwin();
  const paths = localCodesignPaths();
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  // Under the search-list lock: keychain setup edits the list, and two first
  // installs must not each generate a certificate over the other's.
  return withSearchListLock(paths, () => ensureLocked(paths, log));
}

/**
 * Start clean with a new certificate. Recovery this way costs exactly one
 * fresh "Always Allow", so it is only for material that cannot be reconciled.
 */
function regenerateMaterial(paths, log) {
  for (const path of [paths.secret, paths.bundle, paths.certificate]) {
    rmSync(path, { force: true });
  }
  rmSync(paths.keychain, { force: true });
  generateMaterial(paths);
  log("generated a local signing certificate (a one-time Keychain grant will be asked for again)");
}

function ensureLocked(paths, log) {
  const material = [paths.secret, paths.bundle, paths.certificate];
  if (!material.every((path) => existsSync(path))) {
    // Partial material cannot be reconciled - the key in the bundle must match
    // the certificate - so start clean.
    regenerateMaterial(paths, log);
  }

  if (!ensureKeychain(paths, log)) {
    // The stored secret opens neither the keychain nor a bundle holding the
    // stored certificate, so that certificate's key is out of reach without
    // a dialog.
    log("the stored secret opens neither the local signing keychain nor its key bundle");
    regenerateMaterial(paths, log);
    if (!ensureKeychain(paths, log)) {
      throw new Error(`newly generated local signing material does not open ${paths.keychain}`);
    }
  }

  const certificateSha1 = parseCertificateSha1(
    run(opensslBin(), ["x509", "-in", paths.certificate, "-noout", "-fingerprint", "-sha1"]),
  );
  const requirement = designatedRequirement(certificateSha1);
  writeFileSync(paths.requirement, `${requirement}\n`);

  return { name: LOCAL_IDENTITY_NAME, certificateSha1, requirement, paths };
}

/**
 * Sign a bundle or Mach-O with the local identity. `identifier` is only
 * needed where the bundle's own CFBundleIdentifier is not the identifier we
 * want in the requirement (the dev run's stock Electron.app).
 */
export function signWithLocalIdentity(target, { identifier } = {}) {
  assertDarwin();
  const paths = localCodesignPaths();
  // `--keychain` picks the identity out of that file; the search list is what
  // lets codesign resolve it at all. Never pass `-u`.
  const args = [
    "--force",
    "--sign",
    LOCAL_IDENTITY_NAME,
    "--keychain",
    paths.keychain,
    "--timestamp=none",
  ];
  if (identifier !== undefined) {
    args.push("--identifier", identifier);
  }
  args.push(target);
  withLocalKeychainOnSearchList(() => run(codesignBin(), args));
}

/**
 * The designated requirement macOS would record for `target`, as text.
 * `codesign -d -r-` prints the requirement on stdout and its report on
 * stderr; an unsigned target exits non-zero and has none.
 */
export function readDesignatedRequirement(target) {
  const result = spawnSync(codesignBin(), ["-d", "-r-", target], { encoding: "utf8" });
  const match = /designated\s*=>\s*(.+)/.exec(result.stdout ?? "");
  return match === null ? null : match[1].trim();
}

/** True when `target`'s signature satisfies `requirement` (what a grant checks). */
export function satisfiesRequirement(target, requirement) {
  assertDarwin();
  try {
    run(codesignBin(), ["--verify", "--strict", "-R", `=${requirement}`, target]);
    return true;
  } catch {
    return false;
  }
}

export function assertSatisfiesRequirement(target, requirement) {
  if (!satisfiesRequirement(target, requirement)) {
    throw new Error(
      `${target} does not satisfy the local designated requirement.\n` +
        `  expected: ${requirement}\n` +
        `  actual:   ${readDesignatedRequirement(target) ?? "(unsigned)"}`,
    );
  }
}
