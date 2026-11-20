import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { assertInstallerEnvironment } from "./installer-environment.ts";

// INF-816 permits a fresh placement-service VM, never its physical Mac host.
assertInstallerEnvironment();
const root = resolve(process.env.RUNNER_TEMP ?? "/invalid");
const home = resolve(process.env.HOME ?? "/invalid");
if (!home.startsWith(`${root}${sep}`) || process.env.CFFIXED_USER_HOME !== home || process.env.INFINITARY_LOCAL_CODESIGN_DIR !== join(home, "local-codesign"))
  throw new Error("Installer verification requires its own scratch home and signing directory.");
const folder = join(home, "installer-signing");
const keychain = join(folder, "verification.keychain-db");
mkdirSync(folder, { recursive: true, mode: 0o700 });
// Security writes the user search list here but does not create the parent directory.
// A missing parent silently loses list-keychains -s, even though explicit identity lookup works.
mkdirSync(join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function security(command) {
  // security's interactive input avoids putting passwords in the process argument list.
  // Do not echo its diagnostics: an interactive command can contain the imported password.
  const result = spawnSync("/usr/bin/security", ["-i"], { input: `${command}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error("The disposable verification keychain could not be prepared.");
}
const q = (value) => JSON.stringify(value);
if (process.argv[2] === "restore") {
  const p12 = join(folder, "certificate.p12");
  const apiKey = join(folder, "notarization.p8");
  const password = randomBytes(32).toString("hex");
  writeFileSync(p12, Buffer.from(required("MAC_DEVELOPER_ID_CERT_P12").replace(/\s/g, ""), "base64"), { mode: 0o600 });
  writeFileSync(apiKey, Buffer.from(required("APP_STORE_CONNECT_API_KEY"), "base64"), { mode: 0o600 });
  try {
    security(`create-keychain -p ${q(password)} ${q(keychain)}`);
    security(`set-keychain-settings -lut 21600 ${q(keychain)}`);
    security(`unlock-keychain -p ${q(password)} ${q(keychain)}`);
    security(`import ${q(p12)} -k ${q(keychain)} -f pkcs12 -P ${q(required("MAC_DEVELOPER_ID_CERT_PASSWORD"))} -T /usr/bin/codesign -T /usr/bin/security`);
    security(`set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ${q(password)} ${q(keychain)}`);
    // This disposable account has no personal keychains. No user's search list is read or copied.
    security(`list-keychains -d user -s ${q(keychain)}`);
    const identity = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", keychain], { encoding: "utf8" });
    if (identity.status !== 0 || !identity.stdout.includes(required("SIGN_IDENTITY"))) throw new Error("The expected Developer ID identity was not restored.");
    const search = spawnSync("/usr/bin/security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
    const defaultIdentity = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const listed = search.status === 0 && search.stdout.includes(keychain);
    const discoverable = defaultIdentity.status === 0 && defaultIdentity.stdout.includes(required("SIGN_IDENTITY"));
    console.log(`Disposable signing lookup: file=${existsSync(keychain)}, explicit=true, listed=${listed}, default=${discoverable}`);
    if (!listed || !discoverable) throw new Error("The disposable signing identity is not reachable through the user search list.");
    // Finding a certificate is not proof its private key can sign. Exercise that exact lookup
    // before the expensive package build, on a throwaway copy rather than any installed program.
    const probe = join(folder, "signing-probe");
    copyFileSync("/usr/bin/true", probe);
    const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", required("SIGN_IDENTITY"), "--keychain", keychain, "--timestamp", "--options", "runtime", probe], { encoding: "utf8" });
    if (signed.error || signed.status !== 0) {
      // Unlike interactive security input, this command carries no password or key material.
      console.error(signed.stderr);
      throw new Error(`The disposable signing preflight failed (status ${signed.status}); no application was packaged.`);
    }
    const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", probe], { encoding: "utf8" });
    if (verified.error || verified.status !== 0) throw new Error("The disposable signing preflight did not verify.");
    rmSync(probe);
    console.log("Disposable signing preflight: the restored identity signed and verified a throwaway executable.");
    appendFileSync(required("GITHUB_ENV"), `CSC_KEYCHAIN=${keychain}\nAPPLE_API_KEY=${apiKey}\n`);
    chmodSync(apiKey, 0o600);
  } finally { rmSync(p12, { force: true }); }
} else if (process.argv[2] === "clean") {
  if (existsSync(keychain)) security(`delete-keychain ${q(keychain)}`);
  rmSync(folder, { recursive: true, force: true });
} else throw new Error("Use restore or clean.");
