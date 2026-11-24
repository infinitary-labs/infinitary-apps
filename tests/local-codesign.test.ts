import { execFileSync, spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SIGNING_TEAMS } from "../scripts/release-signing-team.ts";

/**
 * The local code-signing contract (docs/local-code-signing.md).
 *
 * macOS pins a Keychain "Always Allow" grant to the requesting binary's
 * designated requirement, so the code we run locally is signed with a
 * machine-local certificate whose requirement names no path and no cdhash.
 *
 * These tests run the real scripts as child processes against fake
 * `security` and `codesign` (tests/fixtures/local-codesign/), in the style of
 * tests/ensure-electron-installed.test.ts: they pin what the scripts do with
 * the keychain and the user search list, never touching either. Signing with
 * the real identity is deliberately not here - it shares one user search list
 * and one keychain with every other worktree on the machine, so a suite run
 * cannot own it. verify.yml exercises it end to end: `pnpm codesign:local`
 * signs the dev Electron, the dev packaging step signs the bundle through the
 * real hook, and `pnpm codesign:verify` checks both carry the local
 * requirement.
 * What no test can prove is what macOS does with a grant - that is a GUI
 * decision by the security daemon, and docs/local-code-signing.md carries the
 * manual procedure for it.
 */

const repoRoot = join(__dirname, "..");
const libPath = join(repoRoot, "scripts", "local-codesign.mjs");
const prepareScript = join(repoRoot, "scripts", "prepare-local-codesign.mjs");
const verifyScript = join(repoRoot, "scripts", "verify-local-codesign.mjs");

const onMacOS = process.platform === "darwin";

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

const temporaryDirs: string[] = [];
function temporaryDir() {
  const dir = mkdtempSync(join(tmpdir(), "infinitary-local-codesign-"));
  temporaryDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local signing material never reaches the repository", () => {
  it("keeps the material outside the repo and outside node_modules", () => {
    const source = `
      import { localCodesignDir } from ${JSON.stringify(libPath)};
      process.stdout.write(localCodesignDir());
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, INFINITARY_LOCAL_CODESIGN_DIR: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    // A reinstall wipes node_modules and a clone wipes nothing else; the
    // certificate has to outlive both or the grant dies with them.
    expect(result.stdout.startsWith(repoRoot)).toBe(false);
    expect(result.stdout).not.toContain("node_modules");
  });

  it("tracks no certificate, key, keychain, or password file", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((path) => /\.(p12|pfx|cer|pem|key|keychain-db|mobileprovision)$/.test(path));
    expect(tracked).toEqual([]);

    for (const script of [
      "local-codesign.mjs",
      "sign-local-mac.mjs",
      "prepare-local-codesign.mjs",
    ]) {
      const text = execFileSync("cat", [join(repoRoot, "scripts", script)], { encoding: "utf8" });
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(text).not.toContain("BEGIN CERTIFICATE");
      // The Apple teams this repo signs with belong to release signing only.
      for (const team of Object.keys(SIGNING_TEAMS)) expect(text).not.toContain(team);
    }
  });
});

describe.skipIf(onMacOS)("off macOS", () => {
  it("skips quietly rather than failing an install", () => {
    const prepared = runNode(prepareScript, ["--strict"]);
    expect(prepared.status).toBe(0);
  });
});

function runModule(source: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env,
  });
}

/** The rewrite that must never drop the login keychain. No `security` call. */
describe("search list rewrite", () => {
  it("refuses an empty read and a rewrite that would leave no keychain", () => {
    const source = `
      import { searchListWithout } from ${JSON.stringify(libPath)};
      const out = {};
      try {
        searchListWithout([], "/tmp/local.keychain-db");
        out.empty = "did not throw";
      } catch (error) {
        out.empty = error instanceof Error ? error.message : String(error);
      }
      try {
        searchListWithout(["/tmp/local.keychain-db"], "/tmp/local.keychain-db");
        out.only = "did not throw";
      } catch (error) {
        out.only = error instanceof Error ? error.message : String(error);
      }
      out.kept = searchListWithout(
        ["/Users/test/Library/Keychains/login.keychain-db", "/tmp/local.keychain-db"],
        "/tmp/local.keychain-db",
      );
      process.stdout.write(JSON.stringify(out));
    `;
    const result = runModule(source);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as {
      empty: string;
      only: string;
      kept: { kept: string[]; removed: boolean };
    };
    expect(out.empty).toContain("refusing to replace");
    expect(out.only).toContain("empty list");
    expect(out.kept.removed).toBe(true);
    expect(out.kept.kept).toEqual(["/Users/test/Library/Keychains/login.keychain-db"]);
  });
});

const LOGIN_KEYCHAIN = "/Users/test/Library/Keychains/login.keychain-db";
const fakeSecurity = join(repoRoot, "tests/fixtures/local-codesign/security.sh");
const fakeCodesign = join(repoRoot, "tests/fixtures/local-codesign/codesign.sh");

function readCalls(logPath: string): string[][] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * A checkout whose dev Electron is where `resolveDevElectronApp` looks for it
 * (electron's package.json and path.txt), so the scripts run as their own
 * main module can be pointed at it by working directory alone.
 */
function devCheckout(dir: string) {
  const checkout = join(dir, "checkout");
  const electron = join(checkout, "node_modules", "electron");
  mkdirSync(join(electron, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), "{}\n");
  writeFileSync(join(electron, "package.json"), '{ "name": "electron" }\n');
  writeFileSync(join(electron, "path.txt"), "Electron.app/Contents/MacOS/Electron");
  writeFileSync(join(electron, "dist", "Electron.app", "Contents", "MacOS", "Electron"), "");
  // The scripts see their working directory resolved (/var is /private/var).
  const real = realpathSync(checkout);
  return { checkout: real, app: join(real, "node_modules", "electron", "dist", "Electron.app") };
}

describe.skipIf(!onMacOS)("a routine `pnpm dev` never opens the signing keychain", () => {
  chmodSync(fakeSecurity, 0o755);
  chmodSync(fakeCodesign, 0o755);

  function fixture(mode: string) {
    const dir = temporaryDir();
    const securityLog = join(dir, "security.log");
    const codesignLog = join(dir, "codesign.log");
    const verifyCount = join(dir, "verify-count");
    writeFileSync(verifyCount, "0");
    const keychain = join(dir, "infinitary-local.keychain-db");
    const requirement =
      'identifier "com.getinfinitary.infinitary.dev" and certificate leaf = H"abc"';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: securityLog,
      INFINITARY_FAKE_CODESIGN_LOG: codesignLog,
      INFINITARY_FAKE_SECURITY_MODE: mode,
      INFINITARY_FAKE_KEYCHAIN: keychain,
      INFINITARY_FAKE_VERIFY_COUNT: verifyCount,
      INFINITARY_FAKE_REQUIREMENT: requirement,
      APP: join(dir, "Electron.app"),
    };
    return { dir, securityLog, codesignLog, keychain, requirement, env };
  }

  function prepare(env: NodeJS.ProcessEnv) {
    const source = `
      import { prepareLocalCodesign } from ${JSON.stringify(prepareScript)};
      prepareLocalCodesign({ app: process.env.APP, log: console.log });
    `;
    return runModule(source, env);
  }

  it("verifies an already-signed dev app without calling security against the keychain", () => {
    const { dir, securityLog, codesignLog, keychain, requirement, env } = fixture("routine");
    writeFileSync(join(dir, "designated-requirement.txt"), `${requirement}\n`);

    const first = prepare(env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("already carries the local code identity");

    const securityCalls = readCalls(securityLog);
    expect(securityCalls.every((args) => args[0] === "list-keychains")).toBe(true);
    expect(securityCalls.some((args) => args.includes(keychain))).toBe(false);
    const rewrite = securityCalls.find((args) => args.includes("-s"));
    expect(rewrite?.[0]).toBe("list-keychains");
    expect(rewrite).not.toContain(keychain);
    expect(rewrite).toContain("/Users/test/Library/Keychains/login.keychain-db");
    expect(existsSync(join(dir, "search-list-dropped"))).toBe(true);

    const verified = readCalls(codesignLog).some(
      (args) =>
        args.includes("--verify") && args.includes("--strict") && args.includes(`=${requirement}`),
    );
    expect(verified).toBe(true);

    writeFileSync(securityLog, "");
    const again = prepare(env);
    expect(again.status, again.stderr).toBe(0);
    expect(readCalls(securityLog)).toEqual([]);
  });

  it("does not sign, and does not unlock, when Electron is not downloaded", () => {
    const { securityLog, env } = fixture("routine");
    env.APP = "";
    const source = `
      import { prepareLocalCodesign } from ${JSON.stringify(prepareScript)};
      const identity = prepareLocalCodesign({ app: null, log: console.log });
      if (identity !== null) process.exit(2);
    `;
    const result = runModule(source, env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skipping the dev signing step");
    const commands = readCalls(securityLog).map((args) => args[0]);
    expect(commands.every((command) => command === "list-keychains")).toBe(true);
    expect(commands).not.toContain("unlock-keychain");
    expect(commands).not.toContain("set-keychain-settings");
  });

  it("stops before rewriting when the search list reads back empty", () => {
    const { securityLog, env } = fixture("empty");
    const source = `
      import { dropLocalKeychainFromSearchList } from ${JSON.stringify(libPath)};
      dropLocalKeychainFromSearchList({ once: false });
    `;
    const result = runModule(source, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to replace");
    expect(readCalls(securityLog).some((args) => args.includes("-s"))).toBe(false);
  });
});

describe.skipIf(!onMacOS)("signing opens the keychain only to sign", () => {
  chmodSync(fakeSecurity, 0o755);
  chmodSync(fakeCodesign, 0o755);

  it("sets keychain settings only after create, unlocks with -p, and passes --keychain", () => {
    const dir = temporaryDir();
    const securityLog = join(dir, "security.log");
    const codesignLog = join(dir, "codesign.log");
    const verifyCount = join(dir, "verify-count");
    writeFileSync(verifyCount, "0");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-sha256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Infinitary Local Dev",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "local-codesign.cert.pem"),
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    writeFileSync(join(dir, "secret"), "test-secret\n", { mode: 0o600 });
    writeFileSync(join(dir, "local-codesign.p12"), "bundle");
    const keychain = join(dir, "infinitary-local.keychain-db");
    const searchList = join(dir, "search-list");
    writeFileSync(searchList, `${LOGIN_KEYCHAIN}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: securityLog,
      INFINITARY_FAKE_CODESIGN_LOG: codesignLog,
      INFINITARY_FAKE_SEARCH_LIST: searchList,
      INFINITARY_FAKE_SECURITY_MODE: "signing",
      INFINITARY_FAKE_KEYCHAIN: keychain,
      INFINITARY_FAKE_VERIFY_COUNT: verifyCount,
      INFINITARY_FAKE_VERIFY_FAIL_FIRST: "1",
      INFINITARY_FAKE_REQUIREMENT: 'identifier "dev"',
      APP: join(dir, "Electron.app"),
    };

    const source = `
      import { prepareLocalCodesign } from ${JSON.stringify(prepareScript)};
      prepareLocalCodesign({ app: process.env.APP, log: console.log });
    `;

    writeFileSync(keychain, "");
    const existing = runModule(source, env);
    expect(existing.status, existing.stderr).toBe(0);
    const existingCalls = readCalls(securityLog);
    expect(existingCalls.some((args) => args[0] === "set-keychain-settings")).toBe(false);
    const unlock = existingCalls.find((args) => args[0] === "unlock-keychain");
    expect(unlock).toContain("-p");
    expect(unlock).not.toContain("-u");
    expect(unlock).toContain(keychain);
    const signed = readCalls(codesignLog).find((args) => args.includes("--sign"));
    expect(signed).toContain("--keychain");
    expect(signed).toContain(keychain);
    // The fake codesign, like the real one, finds no identity in a keychain
    // off the search list: the sign succeeding means the keychain was on it.
    // It joined only after the unlock, and is off again afterwards.
    const rewrites = existingCalls.filter(
      (args) => args[0] === "list-keychains" && args.includes("-s"),
    );
    const joined = existingCalls.findIndex(
      (args) => args[0] === "list-keychains" && args.includes("-s") && args.includes(keychain),
    );
    expect(joined).toBeGreaterThan(existingCalls.lastIndexOf(unlock as string[]));
    expect(rewrites.at(-1)).not.toContain(keychain);
    expect(readFileSync(searchList, "utf8")).toBe(`${LOGIN_KEYCHAIN}\n`);

    rmSync(keychain);
    writeFileSync(searchList, `${LOGIN_KEYCHAIN}\n`);
    writeFileSync(securityLog, "");
    writeFileSync(codesignLog, "");
    writeFileSync(verifyCount, "0");
    const created = runModule(source, env);
    expect(created.status, created.stderr).toBe(0);
    const createdCalls = readCalls(securityLog);
    const commands = createdCalls.map((args) => args[0]);
    expect(commands.indexOf("set-keychain-settings")).toBe(commands.indexOf("create-keychain") + 1);
    expect(commands.filter((command) => command === "set-keychain-settings")).toEqual([
      "set-keychain-settings",
    ]);
    expect(createdCalls.some((args) => args.includes("-u"))).toBe(false);
    expect(readFileSync(searchList, "utf8")).toBe(`${LOGIN_KEYCHAIN}\n`);
  });

  it("verify does not call security when the requirement file exists", () => {
    const dir = temporaryDir();
    const securityLog = join(dir, "security.log");
    const requirement =
      'identifier "com.getinfinitary.infinitary.dev" and certificate leaf = H"abc"';
    writeFileSync(join(dir, "designated-requirement.txt"), `${requirement}\n`);
    writeFileSync(join(dir, "verify-count"), "0");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: securityLog,
      INFINITARY_FAKE_CODESIGN_LOG: join(dir, "codesign.log"),
      INFINITARY_FAKE_SECURITY_MODE: "routine",
      INFINITARY_FAKE_KEYCHAIN: join(dir, "infinitary-local.keychain-db"),
      INFINITARY_FAKE_VERIFY_COUNT: join(dir, "verify-count"),
      INFINITARY_FAKE_REQUIREMENT: requirement,
    };
    const result = spawnSync(process.execPath, [verifyScript, join(dir, "Electron.app")], {
      encoding: "utf8",
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Infinitary Local Dev");
    expect(readCalls(securityLog)).toEqual([]);
  });

  it("verify --packaged checks the packaged app and leaves the dev Electron out", () => {
    const dir = temporaryDir();
    const codesignLog = join(dir, "codesign.log");
    const requirement =
      'identifier "com.getinfinitary.infinitary.dev" and certificate leaf = H"abc"';
    writeFileSync(join(dir, "designated-requirement.txt"), `${requirement}\n`);
    const verifyCount = join(dir, "verify-count");
    writeFileSync(verifyCount, "0");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: join(dir, "security.log"),
      INFINITARY_FAKE_CODESIGN_LOG: codesignLog,
      INFINITARY_FAKE_SECURITY_MODE: "routine",
      INFINITARY_FAKE_KEYCHAIN: join(dir, "infinitary-local.keychain-db"),
      INFINITARY_FAKE_VERIFY_COUNT: verifyCount,
      INFINITARY_FAKE_REQUIREMENT: requirement,
    };
    const { checkout, app } = devCheckout(dir);
    const packaged = join(checkout, "dist", "mac-universal", "Infinitary Dev.app");
    mkdirSync(packaged, { recursive: true });
    const verify = (args: string[]) =>
      spawnSync(process.execPath, [verifyScript, ...args], {
        cwd: checkout,
        env,
        encoding: "utf8",
      });
    const verified = () =>
      readCalls(codesignLog)
        .filter((args) => args.includes("--verify"))
        .map((args) => args.at(-1));

    // `pnpm package:mac` checks what it just built. The dev Electron is
    // signed by `pnpm dev`, which a clone that only packages never ran.
    const packagedOnly = verify(["--packaged"]);
    expect(packagedOnly.status, packagedOnly.stderr).toBe(0);
    expect(verified()).toEqual([packaged]);

    writeFileSync(codesignLog, "");
    const both = verify([]);
    expect(both.status, both.stderr).toBe(0);
    expect(verified()).toEqual([app, packaged]);
  });
});

describe.skipIf(!onMacOS)("a keychain that refuses the stored secret", () => {
  chmodSync(fakeSecurity, 0o755);
  chmodSync(fakeCodesign, 0o755);

  const STORED_SECRET = "stored-secret";

  function certificateSha1(path: string) {
    return new X509Certificate(readFileSync(path)).fingerprint.replaceAll(":", "").toLowerCase();
  }

  /**
   * A machine whose dev Electron lost its signature (an Electron upgrade, a
   * wiped node_modules) while its keychain answers to some other password.
   * The stand-in `security` refuses that password the way the real one does.
   */
  function refusingFixture({ bundlePassword }: { bundlePassword: string }) {
    const dir = temporaryDir();
    const certificate = join(dir, "local-codesign.cert.pem");
    const key = join(dir, "key.pem");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-sha256",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Infinitary Local Dev",
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    execFileSync(
      "/usr/bin/openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        key,
        "-in",
        certificate,
        "-name",
        "Infinitary Local Dev",
        "-out",
        join(dir, "local-codesign.p12"),
        "-passout",
        `pass:${bundlePassword}`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    rmSync(key);
    writeFileSync(join(dir, "secret"), `${STORED_SECRET}\n`, { mode: 0o600 });
    const keychain = join(dir, "infinitary-local.keychain-db");
    writeFileSync(keychain, "another-password\nidentity\n");
    const requirement = `identifier "com.getinfinitary.infinitary.dev" and certificate leaf = H"${certificateSha1(certificate)}"`;
    writeFileSync(join(dir, "designated-requirement.txt"), `${requirement}\n`);
    writeFileSync(join(dir, "search-list-dropped"), "dropped\n");
    const searchList = join(dir, "search-list");
    writeFileSync(searchList, `${LOGIN_KEYCHAIN}\n`);
    const verifyCount = join(dir, "verify-count");
    writeFileSync(verifyCount, "0");
    const securityLog = join(dir, "security.log");
    const codesignLog = join(dir, "codesign.log");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: securityLog,
      INFINITARY_FAKE_CODESIGN_LOG: codesignLog,
      INFINITARY_FAKE_SEARCH_LIST: searchList,
      INFINITARY_FAKE_SECURITY_MODE: "signing",
      INFINITARY_FAKE_KEYCHAIN_PASSWORDS: "1",
      INFINITARY_FAKE_KEYCHAIN: keychain,
      INFINITARY_FAKE_VERIFY_COUNT: verifyCount,
      // The stored requirement, then the identity's own: neither is met
      // until the dev Electron is signed again.
      INFINITARY_FAKE_VERIFY_FAIL_FIRST: "2",
      INFINITARY_FAKE_REQUIREMENT: requirement,
      APP: join(dir, "Electron.app"),
    };
    const unlockWithStoredSecret = () =>
      spawnSync(
        fakeSecurity,
        ["unlock-keychain", "-p", readFileSync(join(dir, "secret"), "utf8").trim(), keychain],
        { env, encoding: "utf8" },
      );
    return {
      dir,
      certificate,
      keychain,
      requirement,
      searchList,
      securityLog,
      codesignLog,
      env,
      unlockWithStoredSecret,
    };
  }

  const prepareSource = `
    import { prepareLocalCodesign } from ${JSON.stringify(prepareScript)};
    prepareLocalCodesign({ app: process.env.APP, log: console.log });
  `;

  /** set-keychain-settings opens the dialog on any keychain it did not just create. */
  function settingsOnlyOnANewKeychain(calls: string[][]) {
    return calls.every(
      (args, index) =>
        args[0] !== "set-keychain-settings" || calls[index - 1]?.[0] === "create-keychain",
    );
  }

  it("rebuilds the keychain from the key bundle and keeps the certificate", () => {
    const fixture = refusingFixture({ bundlePassword: STORED_SECRET });
    const certificateBefore = certificateSha1(fixture.certificate);
    expect(fixture.unlockWithStoredSecret().status).toBe(51);

    const result = runModule(prepareSource, fixture.env);
    expect(result.status, result.stderr).toBe(0);

    // The dev Electron is signed with the same certificate, so the grant
    // made against the stored requirement still holds.
    expect(readCalls(fixture.codesignLog).some((args) => args.includes("--sign"))).toBe(true);
    expect(certificateSha1(fixture.certificate)).toBe(certificateBefore);
    expect(readFileSync(join(fixture.dir, "designated-requirement.txt"), "utf8")).toBe(
      `${fixture.requirement}\n`,
    );
    expect(fixture.unlockWithStoredSecret().status).toBe(0);

    const calls = readCalls(fixture.securityLog);
    expect(calls.some((args) => args.includes("-u"))).toBe(false);
    expect(settingsOnlyOnANewKeychain(calls)).toBe(true);
    expect(readFileSync(fixture.searchList, "utf8")).toBe(`${LOGIN_KEYCHAIN}\n`);
  });

  it("makes new material when the stored secret opens neither the keychain nor the bundle", () => {
    const fixture = refusingFixture({ bundlePassword: "another-password" });
    const certificateBefore = certificateSha1(fixture.certificate);

    const result = runModule(prepareSource, fixture.env);
    expect(result.status, result.stderr).toBe(0);

    // A new certificate costs one fresh grant, but signing finishes and the
    // stored secret opens the keychain it signed with.
    expect(readCalls(fixture.codesignLog).some((args) => args.includes("--sign"))).toBe(true);
    const certificateAfter = certificateSha1(fixture.certificate);
    expect(certificateAfter).not.toBe(certificateBefore);
    expect(readFileSync(join(fixture.dir, "designated-requirement.txt"), "utf8")).toContain(
      `H"${certificateAfter}"`,
    );
    expect(fixture.unlockWithStoredSecret().status).toBe(0);

    const calls = readCalls(fixture.securityLog);
    expect(calls.some((args) => args.includes("-u"))).toBe(false);
    expect(settingsOnlyOnANewKeychain(calls)).toBe(true);
    expect(readFileSync(fixture.searchList, "utf8")).toBe(`${LOGIN_KEYCHAIN}\n`);
  });

  it("is left alone by an install, and signed again by `pnpm dev`", () => {
    const fixture = refusingFixture({ bundlePassword: STORED_SECRET });
    const { checkout, app } = devCheckout(fixture.dir);
    const verifyCount = join(fixture.dir, "verify-count");
    const keychainBefore = readFileSync(fixture.keychain, "utf8");
    // The script as pnpm runs it: its own main module, the stage it runs
    // under named in npm_lifecycle_event.
    const runAs = (stage: string, env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [prepareScript], {
        cwd: checkout,
        env: { ...fixture.env, ...env, npm_lifecycle_event: stage },
        encoding: "utf8",
      });

    // pnpm installs on its own before a script whose packages are out of
    // date, and the app installs every working copy it makes; nobody is
    // there for the signing keychain. Every install stage only checks.
    for (const stage of ["preinstall", "install", "postinstall", "prepare"]) {
      const installed = runAs(stage, { INFINITARY_FAKE_VERIFY_FAIL_FIRST: "100" });
      expect(installed.status, installed.stderr).toBe(0);
      expect(installed.stdout).toContain("does not carry the local code identity yet");
      expect(installed.stdout).toContain("pnpm dev");
    }
    expect(readCalls(fixture.securityLog)).toEqual([]);
    const checks = readCalls(fixture.codesignLog);
    expect(checks).toHaveLength(4);
    expect(checks.every((args) => args.includes("--verify") && args.at(-1) === app)).toBe(true);
    expect(readFileSync(fixture.keychain, "utf8")).toBe(keychainBefore);
    expect(fixture.unlockWithStoredSecret().status).toBe(51);

    // `pnpm dev` is a person asking for the dev app: it rebuilds the keychain
    // from its bundle and signs.
    writeFileSync(fixture.securityLog, "");
    writeFileSync(verifyCount, "0");
    const dev = runAs("predev", {});
    expect(dev.status, dev.stderr).toBe(0);
    const signed = readCalls(fixture.codesignLog).filter((args) => args.includes("--sign"));
    expect(signed.map((args) => args.at(-1))).toEqual([app]);
    expect(readCalls(fixture.securityLog).some((args) => args[0] === "unlock-keychain")).toBe(true);
    expect(fixture.unlockWithStoredSecret().status).toBe(0);
  });
});

describe.skipIf(!onMacOS)("signing borrows the search list and always hands it back", () => {
  chmodSync(fakeSecurity, 0o755);
  chmodSync(fakeCodesign, 0o755);

  function signingFixture() {
    const dir = temporaryDir();
    const keychain = join(dir, "infinitary-local.keychain-db");
    const searchList = join(dir, "search-list");
    writeFileSync(searchList, `${LOGIN_KEYCHAIN}\n`);
    // A machine past its first install: the keychain is known off the list.
    writeFileSync(join(dir, "search-list-dropped"), "dropped\n");
    writeFileSync(join(dir, "secret"), "test-secret\n", { mode: 0o600 });
    writeFileSync(keychain, "");
    const target = join(dir, "target");
    writeFileSync(target, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INFINITARY_LOCAL_CODESIGN_DIR: dir,
      INFINITARY_SECURITY_BIN: fakeSecurity,
      INFINITARY_CODESIGN_BIN: fakeCodesign,
      INFINITARY_FAKE_SECURITY_LOG: join(dir, "security.log"),
      INFINITARY_FAKE_CODESIGN_LOG: join(dir, "codesign.log"),
      INFINITARY_FAKE_SEARCH_LIST: searchList,
      INFINITARY_FAKE_SECURITY_MODE: "signing",
      INFINITARY_FAKE_KEYCHAIN: keychain,
      TARGET: target,
    };
    const list = () => readFileSync(searchList, "utf8").split("\n").filter(Boolean);
    return { dir, keychain, searchList, list, env };
  }

  const signSource = `
    import { signWithLocalIdentity } from ${JSON.stringify(libPath)};
    signWithLocalIdentity(process.env.TARGET);
  `;

  function signAsync(env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", signSource], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    return { child, exited };
  }

  it("takes the keychain back off the list when codesign fails", () => {
    const { dir, keychain, list, env } = signingFixture();
    const result = runModule(signSource, { ...env, INFINITARY_FAKE_CODESIGN_SIGN_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("signing failed");
    expect(list()).toEqual([LOGIN_KEYCHAIN]);
    expect(list()).not.toContain(keychain);
    expect(existsSync(join(dir, "search-list-dropped"))).toBe(true);
  });

  it("keeps the keychain on the list until an async signer settles, then drops it", () => {
    const { keychain, list, env } = signingFixture();
    const source = `
      import { readFileSync } from "node:fs";
      import { withLocalKeychainOnSearchList } from ${JSON.stringify(libPath)};
      const read = () => readFileSync(process.env.INFINITARY_FAKE_SEARCH_LIST, "utf8");
      const out = {};
      out.resolved = await withLocalKeychainOnSearchList(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return read();
      });
      out.afterResolve = read();
      try {
        await withLocalKeychainOnSearchList(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("osx-sign failed");
        });
      } catch (error) {
        out.rejected = error.message;
      }
      out.afterReject = read();
      process.stdout.write(JSON.stringify(out));
    `;
    const result = runModule(source, env);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as Record<string, string>;
    expect(out.resolved).toContain(keychain);
    expect(out.afterResolve).not.toContain(keychain);
    expect(out.rejected).toBe("osx-sign failed");
    expect(out.afterReject).not.toContain(keychain);
    expect(list()).toEqual([LOGIN_KEYCHAIN]);
  });

  // Every hold a test takes is released when it ends, pass or fail, so no
  // fake codesign outlives its test.
  const holds: string[] = [];
  function holdIn(dir: string) {
    const hold = join(dir, `release-${holds.length}`);
    holds.push(hold);
    return hold;
  }
  afterEach(() => {
    for (const hold of holds.splice(0)) {
      writeFileSync(hold, "");
    }
  });

  /** Resolves once `signer` has put the keychain on the list, i.e. it is inside codesign. */
  async function insideCodesign(
    signer: ReturnType<typeof signAsync>,
    list: () => string[],
    keychain: string,
  ) {
    let exited: { code: number | null; stderr: string } | null = null;
    void signer.exited.then((result) => {
      exited = result;
    });
    while (!list().includes(keychain)) {
      if (exited !== null) {
        throw new Error(`the signer exited before it signed: ${JSON.stringify(exited)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("lets signers overlap - neither waits, and the last one out takes the keychain off", async () => {
    const { dir, keychain, list, env } = signingFixture();
    // The first signer stays inside codesign until the test releases it.
    const hold = holdIn(dir);
    const first = signAsync({ ...env, INFINITARY_FAKE_CODESIGN_HOLD: hold });
    await insideCodesign(first, list, keychain);

    // A second signer starts, signs and finishes while the first is still
    // inside codesign: signing steps do not queue behind each other (a
    // `pnpm package:mac` in one worktree must not hold up `pnpm dev` in
    // another). It leaves the keychain on the list for the first.
    const second = await signAsync(env).exited;
    expect(second.code, second.stderr).toBe(0);
    expect(first.child.exitCode).toBeNull();
    expect(list()).toContain(keychain);

    // The fake codesign, like the real one, fails with "no identity found"
    // if the keychain left the list under it.
    writeFileSync(hold, "");
    const firstResult = await first.exited;
    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(list()).toEqual([LOGIN_KEYCHAIN]);
    expect(existsSync(join(dir, "search-list-dropped"))).toBe(true);
  });

  it("never takes the keychain off under a live signer on a routine install", async () => {
    const { dir, keychain, list, env } = signingFixture();
    const hold = holdIn(dir);
    const signer = signAsync({ ...env, INFINITARY_FAKE_CODESIGN_HOLD: hold });
    await insideCodesign(signer, list, keychain);

    // A checkout from before the signing lease drops the keychain whenever
    // the off-list marker is missing, so a signer never removes it.
    expect(existsSync(join(dir, "search-list-dropped"))).toBe(true);

    // Another worktree's `pnpm install` or `pnpm dev` sees a signing step in
    // progress; it must leave the list to the signer.
    const routine = runModule(
      `
        import { dropLocalKeychainFromSearchList } from ${JSON.stringify(libPath)};
        dropLocalKeychainFromSearchList({ once: true });
      `,
      env,
    );
    expect(routine.status, routine.stderr).toBe(0);
    expect(list()).toContain(keychain);

    writeFileSync(hold, "");
    const result = await signer.exited;
    expect(result.code, result.stderr).toBe(0);
    expect(list()).toEqual([LOGIN_KEYCHAIN]);
  });

  it("recovers from a signer killed mid-step", async () => {
    const { dir, keychain, list, env } = signingFixture();
    const hold = holdIn(dir);
    const signer = signAsync({ ...env, INFINITARY_FAKE_CODESIGN_HOLD: hold });
    await insideCodesign(signer, list, keychain);
    signer.child.kill("SIGKILL");
    await signer.exited;

    // A killed signer leaves the keychain on the list and its in-progress
    // file behind, but no lock: the kernel released its locks with the
    // process, and its codesign - still running - never inherited them. The
    // next routine install takes the keychain off...
    expect(existsSync(join(dir, "signing-in-progress"))).toBe(true);
    const routine = runModule(
      `
        import { dropLocalKeychainFromSearchList } from ${JSON.stringify(libPath)};
        dropLocalKeychainFromSearchList({ once: true });
      `,
      env,
    );
    expect(routine.status, routine.stderr).toBe(0);
    expect(list()).toEqual([LOGIN_KEYCHAIN]);

    expect(existsSync(join(dir, "signing-in-progress"))).toBe(false);

    const next = runModule(signSource, env);
    expect(next.status, next.stderr).toBe(0);
    expect(list()).toEqual([LOGIN_KEYCHAIN]);
  });
});

/**
 * The signer before the Infinitary rename lived in ~/.firstmate-3000/local-codesign.
 * It stays as it was, for a rollback: the signer reads, moves and deletes
 * nothing there, and makes its own material in ~/.infinitary/local-codesign.
 */
describe("the signer from before the Infinitary rename", () => {
  function snapshot(dir: string) {
    return Object.fromEntries(
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .sort()
        .map((name) => {
          const path = join(dir, name);
          const stat = statSync(path);
          return [
            name,
            {
              mode: stat.mode,
              mtimeMs: stat.mtimeMs,
              bytes: stat.isFile() ? readFileSync(path).toString("base64") : null,
            },
          ];
        }),
    );
  }

  function scratchHome() {
    const home = temporaryDir();
    const oldDir = join(home, ".firstmate-3000", "local-codesign");
    mkdirSync(oldDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(oldDir, "local-codesign.cert.pem"), "old certificate\n");
    writeFileSync(join(oldDir, "local-codesign.p12"), "old bundle", { mode: 0o600 });
    writeFileSync(join(oldDir, "firstmate-3000-local.keychain-db"), "old keychain");
    writeFileSync(join(oldDir, "secret"), "old-secret\n", { mode: 0o600 });
    writeFileSync(
      join(oldDir, "designated-requirement.txt"),
      'identifier "com.kunchenguid.firstmate3000.dev" and certificate leaf = H"old"\n',
    );
    writeFileSync(join(oldDir, "search-list-dropped"), "dropped\n");
    return { home, oldDir, newDir: join(home, ".infinitary", "local-codesign") };
  }

  it("names its folder, keychain and certificate after Infinitary", () => {
    const { home, newDir } = scratchHome();
    const source = `
      import { LOCAL_IDENTITY_NAME, localCodesignPaths } from ${JSON.stringify(libPath)};
      process.stdout.write(JSON.stringify({ name: LOCAL_IDENTITY_NAME, paths: localCodesignPaths() }));
    `;
    const result = runModule(source, {
      ...process.env,
      HOME: home,
      INFINITARY_LOCAL_CODESIGN_DIR: "",
      FM3000_LOCAL_CODESIGN_DIR: "",
    });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as { name: string; paths: Record<string, string> };
    expect(out.name).toBe("Infinitary Local Dev");
    expect(out.paths.dir).toBe(newDir);
    expect(out.paths.keychain).toBe(join(newDir, "infinitary-local.keychain-db"));
  });

  it.skipIf(!onMacOS)(
    "signs under a scratch home and leaves ~/.firstmate-3000/local-codesign byte for byte as it was",
    () => {
      chmodSync(fakeSecurity, 0o755);
      chmodSync(fakeCodesign, 0o755);
      const { home, oldDir, newDir } = scratchHome();
      const before = snapshot(oldDir);
      const securityLog = join(home, "security.log");
      const codesignLog = join(home, "codesign.log");
      const searchList = join(home, "search-list");
      writeFileSync(searchList, `${LOGIN_KEYCHAIN}\n`);
      const verifyCount = join(home, "verify-count");
      writeFileSync(verifyCount, "0");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        INFINITARY_LOCAL_CODESIGN_DIR: newDir,
        INFINITARY_SECURITY_BIN: fakeSecurity,
        INFINITARY_CODESIGN_BIN: fakeCodesign,
        INFINITARY_FAKE_SECURITY_LOG: securityLog,
        INFINITARY_FAKE_CODESIGN_LOG: codesignLog,
        INFINITARY_FAKE_SEARCH_LIST: searchList,
        INFINITARY_FAKE_SECURITY_MODE: "signing",
        INFINITARY_FAKE_KEYCHAIN: join(newDir, "infinitary-local.keychain-db"),
        INFINITARY_FAKE_VERIFY_COUNT: verifyCount,
        INFINITARY_FAKE_VERIFY_FAIL_FIRST: "1",
        INFINITARY_FAKE_REQUIREMENT: 'identifier "dev"',
        APP: join(home, "Electron.app"),
      };
      const source = `
        import { prepareLocalCodesign } from ${JSON.stringify(prepareScript)};
        prepareLocalCodesign({ app: process.env.APP, log: console.log });
      `;

      const result = runModule(source, env);
      expect(result.status, result.stderr).toBe(0);

      expect(readCalls(codesignLog).some((args) => args.includes("--sign"))).toBe(true);
      const certificate = new X509Certificate(
        readFileSync(join(newDir, "local-codesign.cert.pem")),
      );
      expect(certificate.subject).toContain("CN=Infinitary Local Dev");
      expect(readFileSync(join(newDir, "designated-requirement.txt"), "utf8")).toMatch(
        /^identifier "com\.getinfinitary\.infinitary\.dev" and certificate leaf = H"[0-9a-f]{40}"\n$/,
      );

      const calls = [...readCalls(securityLog), ...readCalls(codesignLog)];
      expect(calls.some((args) => args.some((arg) => arg.includes(".firstmate-3000")))).toBe(false);
      expect(snapshot(oldDir)).toEqual(before);
    },
  );
});
