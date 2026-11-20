import { execFileSync, fork } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearClaudeCredentialCache, readClaudeStore } from "@core/claude/claudeQuota";
import { hostEnv } from "@core/hostEnv";
import koffi from "koffi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleKeychainProcess,
  scratchKeychainReaderSource,
} from "../../../tests/helpers/keychainProcessBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readClaudeThroughTrustedTool } from "./claudeKeychainTool";
import { createDarwinKeychain, openDarwinKeychainApiForTest } from "./darwinKeychain";
import { createKeychainRequester, createProcessKeychain } from "./keychainProcess";

/**
 * The Mac mini's Claude row, on a throwaway keychain only.
 * HOME, CFFIXED_USER_HOME and INFINITARY_LOCAL_CODESIGN_DIR are a scratch
 * directory. Every security command names that keychain file. Nothing is
 * added to a search list, and the login keychain is never named.
 *
 * Six extra items trust a large app. Listing every saved password checks that
 * app's signature once per item, which runs past this test's own time limit;
 * reading this one item checks none.
 *
 * The large app is built in the scratch directory, so no Mac needs one
 * installed (INF-650): an ad-hoc signed bundle whose seal covers a sparse
 * file of zeros. Checking its signature hashes every byte, and APFS keeps the
 * file without writing them.
 */
const LARGE_APP_BYTES = 3 * 1024 ** 3;
/** Signing hashes those bytes once; docs/test-cohorts.md keeps its measured time. */
const LARGE_APP_BUILD_MS = 15_000;
const FILLERS = 6;
const SERVICE = "Claude Code-credentials";
const ACCOUNT = "scratch";
const TOKEN = "not-a-real-credential";
const PASSWORD = "throwaway-scratch-password";
const TOOL_PATH = "/usr/bin/security";

let helperPath = "";
let searchListBefore = "";
function realSearchList() {
  return execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], {
    env: hostEnv(),
    encoding: "utf8",
  });
}
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  searchListBefore = realSearchList();
  helperPath = await bundleKeychainProcess(scratchKeychainReaderSource);
});
afterAll(() => {
  if (process.platform === "darwin") expect(realSearchList()).toBe(searchListBefore);
});

/**
 * A throwaway keychain file in a scratch home, created and unlocked, and the
 * Apple tool run with that home: every command names the file.
 */
function throwawayKeychain(prefix: string): {
  dir: string;
  store: string;
  env: NodeJS.ProcessEnv;
  run: (...args: string[]) => string;
} {
  const dir = scratchDir(prefix);
  const home = join(dir, "home");
  const signing = join(dir, "signing");
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  mkdirSync(signing, { recursive: true });
  const store = join(home, "Library", "Keychains", "scratch.keychain-db");
  const env = {
    ...hostEnv(),
    HOME: home,
    CFFIXED_USER_HOME: home,
    INFINITARY_LOCAL_CODESIGN_DIR: signing,
  };
  const run = (...args: string[]) =>
    execFileSync("/usr/bin/security", args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
  run("create-keychain", "-p", PASSWORD, store);
  run("set-keychain-settings", store);
  return { dir, store, env, run };
}

/** A signed app whose signature takes as long to check as it has bytes to hash. */
function buildLargeApp(dir: string, env: NodeJS.ProcessEnv): string {
  const app = join(dir, "Large.app");
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  const executable = join(contents, "MacOS", "Large");
  copyFileSync("/usr/bin/true", executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Large</string>
<key>CFBundleIdentifier</key><string>dev.infinitary.test.large-app</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  const payload = join(contents, "Resources", "payload");
  writeFileSync(payload, "");
  truncateSync(payload, LARGE_APP_BYTES);
  // Ad-hoc: no signing identity, so no keychain is opened.
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: LARGE_APP_BUILD_MS,
  });
  return app;
}

describe.runIf(process.platform === "darwin")(
  "Claude's item is read without listing the other saved passwords",
  () => {
    let largeApp = "";
    beforeAll(() => {
      const dir = scratchDir("infinitary-large-app-");
      largeApp = buildLargeApp(dir, {
        ...hostEnv(),
        HOME: dir,
        CFFIXED_USER_HOME: dir,
        INFINITARY_LOCAL_CODESIGN_DIR: join(dir, "signing"),
      });
    }, LARGE_APP_BUILD_MS);

    it("returns the sign-in when other items trust a large app", async () => {
      const { dir, store, run } = throwawayKeychain("infinitary-claude-item-");
      const login = JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 },
      });
      run(
        "add-generic-password",
        "-U",
        "-a",
        ACCOUNT,
        "-s",
        SERVICE,
        "-X",
        Buffer.from(login).toString("hex"),
        store,
      );
      run(
        "add-generic-password",
        "-a",
        "other",
        "-s",
        SERVICE,
        "-w",
        "not-the-login",
        "-T",
        "/usr/bin/security",
        store,
      );
      for (let index = 1; index <= FILLERS; index += 1) {
        run(
          "add-generic-password",
          "-T",
          largeApp,
          "-a",
          `filler${index}`,
          "-s",
          `lab-filler-${index}`,
          "-w",
          "x",
          store,
        );
      }
      run(
        "set-generic-password-partition-list",
        "-a",
        "other",
        "-s",
        SERVICE,
        "-S",
        "apple-tool:,teamid:OTHER",
        "-k",
        PASSWORD,
        store,
      );
      try {
        const api = openDarwinKeychainApiForTest(store);
        // Prove the other item's ordinary decrypt grant is valid too: its
        // extra team partition, not a missing tool grant, causes refusal.
        run(
          "set-generic-password-partition-list",
          "-a",
          "other",
          "-s",
          SERVICE,
          "-S",
          "apple-tool:",
          "-k",
          PASSWORD,
          store,
        );
        expect(api.claudeItemTrustsAppleTool?.(SERVICE, "other")).toBe(true);
        run(
          "set-generic-password-partition-list",
          "-a",
          "other",
          "-s",
          SERVICE,
          "-S",
          "apple-tool:,teamid:OTHER",
          "-k",
          PASSWORD,
          store,
        );
        expect(api.claudeItemTrustsAppleTool?.(SERVICE, ACCOUNT)).toBe(true);
        expect(api.claudeItemTrustsAppleTool?.(SERVICE, "other")).toBe(false);
        api.setUserInteractionAllowed(false);
        expect(api.readGenericPassword(SERVICE, ACCOUNT).status).toBe(-25293);
        const reads: string[] = [];
        const direct = api.readGenericPassword.bind(api);
        const directReads: string[] = [];
        api.readGenericPassword = (service, account) => {
          directReads.push(account ?? "");
          return direct(service, account);
        };
        const keychain = createDarwinKeychain(api, undefined, async (account, path) => {
          reads.push(account);
          return readClaudeThroughTrustedTool(account, path);
        });
        expect(await keychain.readGenericPassword({ service: SERVICE, account: ACCOUNT })).toEqual({
          kind: "value",
          value: login,
        });
        expect(directReads).toEqual([]);
        expect(await keychain.readGenericPassword({ service: SERVICE, account: "other" })).toEqual({
          kind: "failed",
          code: -25293,
          message: "Auth failed.",
        });
        expect(reads).toEqual([ACCOUNT]);
        expect(directReads).toEqual(["other"]);
        console.info(
          "Scratch item: Apple-first returned the credential with no direct value read; the extra team partition was refused without running the tool.",
        );
        const configDir = join(dir, "claude");
        mkdirSync(configDir);
        clearClaudeCredentialCache(configDir);
        expect(
          await readClaudeStore(configDir, {
            keychain,
            allowPrompt: false,
            env: { USER: ACCOUNT },
          }),
        ).toMatchObject({
          state: "present",
          auth: { accessToken: TOKEN, expiresAt: expect.any(Number) },
        });
      } finally {
        try {
          run("delete-keychain", store);
        } catch {
          /* the throwaway file is removed with the scratch directory */
        }
      }
    });
  },
);

/** kSecKeychainPromptRequirePassphase in an ACL's 16-bit prompt selector. */
const REQUIRE_PASSWORD = 0x0001;

/**
 * A generic password whose decrypt entry lists `apps` ("self" is this
 * process's program) with the password bit set: what the app never does,
 * through the same framework. Creating an item with its own access asks for
 * no keychain password, so no window can open; the store is the scratch file.
 */
function createItemRequiringPassword(
  store: string,
  service: string,
  account: string,
  value: string,
  apps: string[],
): void {
  const security = koffi.load("/System/Library/Frameworks/Security.framework/Security");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const ptr = koffi.pointer("void");
  const out = koffi.out(koffi.pointer(ptr));
  const attribute = koffi.struct({ tag: "uint32", length: "uint32", data: ptr });
  const attributeList = koffi.struct({ count: "uint32", attr: koffi.pointer(attribute) });
  const trustedApp = security.func("SecTrustedApplicationCreateFromPath", "int32", ["str", out]);
  const createAccess = security.func("SecAccessCreate", "int32", [ptr, ptr, out]);
  const copyAclList = security.func("SecAccessCopyACLList", "int32", [ptr, out]);
  const copyAuthorizations = security.func("SecACLCopyAuthorizations", ptr, [ptr]);
  const copyContents = security.func("SecACLCopyContents", "int32", [
    ptr,
    out,
    out,
    koffi.out(koffi.pointer("uint16")),
  ]);
  const setContents = security.func("SecACLSetContents", "int32", [ptr, ptr, ptr, "uint16"]);
  const openKeychain = security.func("SecKeychainOpen", "int32", ["str", out]);
  const createItem = security.func("SecKeychainItemCreateFromContent", "int32", [
    "uint32",
    koffi.pointer(attributeList),
    "uint32",
    ptr,
    ptr,
    ptr,
    ptr,
  ]);
  const cfString = cf.func("CFStringCreateWithCString", ptr, [ptr, "str", "uint32"]);
  const cfStringGet = cf.func("CFStringGetCString", "uint8", [ptr, ptr, "long", "uint32"]);
  const cfArray = cf.func("CFArrayCreate", ptr, [ptr, koffi.pointer(ptr), "long", ptr]);
  const cfCount = cf.func("CFArrayGetCount", "long", [ptr]);
  const cfGet = cf.func("CFArrayGetValueAtIndex", ptr, [ptr, "long"]);
  const UTF8 = 0x08000100;
  const text = (value: unknown): string => {
    const buffer = Buffer.alloc(256);
    return cfStringGet(value, buffer, buffer.length, UTF8)
      ? (buffer.toString("utf8").split("\0")[0] ?? "")
      : "";
  };

  const refs = apps.map((path) => {
    const app: [unknown] = [null];
    expect(trustedApp(path === "self" ? null : path, app)).toBe(0);
    return app[0];
  });
  const access: [unknown] = [null];
  expect(
    createAccess(cfString(null, service, UTF8), cfArray(null, refs, refs.length, null), access),
  ).toBe(0);
  const acls: [unknown] = [null];
  expect(copyAclList(access[0], acls)).toBe(0);
  let decrypts = 0;
  for (let index = 0; index < Number(cfCount(acls[0])); index += 1) {
    const acl = cfGet(acls[0], index);
    const tags = copyAuthorizations(acl);
    const names = Array.from({ length: Number(cfCount(tags)) }, (_, tag) => text(cfGet(tags, tag)));
    if (!names.includes("ACLAuthorizationDecrypt")) continue;
    const listed: [unknown] = [null];
    const description: [unknown] = [null];
    const selector = [0];
    expect(copyContents(acl, listed, description, selector)).toBe(0);
    expect(
      setContents(acl, listed[0], description[0], Number(selector[0]) | REQUIRE_PASSWORD),
    ).toBe(0);
    decrypts += 1;
  }
  expect(decrypts).toBe(1);
  const field = (tag: string, bytes: Buffer) => ({
    tag: Buffer.from(tag).readUInt32BE(),
    length: bytes.length,
    data: bytes,
  });
  const fields = [
    field("svce", Buffer.from(service)),
    field("acct", Buffer.from(account)),
    field("labl", Buffer.from(service)),
  ];
  const keychain: [unknown] = [null];
  expect(openKeychain(store, keychain)).toBe(0);
  const secret = Buffer.from(value);
  expect(
    createItem(
      Buffer.from("genp").readUInt32BE(),
      { count: fields.length, attr: fields },
      secret.length,
      secret,
      keychain[0],
      access[0],
      null,
    ),
  ).toBe(0);
}

describe.runIf(process.platform === "darwin")(
  "Claude's item stays readable after the client saves it again",
  () => {
    // INF-3081: after Always Allow, the item's decrypt entry listed the app's
    // helper and Apple's tool. Each of Claude Code's own saves (`security -i`
    // running add-generic-password -U) cut the partition list to apple-tool:
    // and swapped the bytes of the decrypt entry's prompt selector, so its
    // require-password bit came and went. Every save that left it set made
    // the background read fail -25293 until the person clicked Retry.
    it("reads through Apple's tool whatever the save left in the password bit", async () => {
      const { store, env, run } = throwawayKeychain("infinitary-claude-resave-");
      // The granted item: the decrypt entry lists the helper's program (this
      // one, which the child below runs) and Apple's tool, with the bit set.
      createItemRequiringPassword(store, SERVICE, ACCOUNT, "granted", ["self", TOOL_PATH]);
      try {
        // A fresh child for each read, as in the app: a process that read the
        // store before another program rewrote it can hold a stale record.
        const keychain = createProcessKeychain({
          helperPath,
          fork: (path: string, args: string[]) =>
            fork(path, args, {
              execArgv: [],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              env: { ...env, TEST_KEYCHAIN_PATH: store },
            }),
        });
        const passwordBit: string[] = [];
        for (let save = 1; save <= 3; save += 1) {
          const login = JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-${save}` } });
          // Claude Code's own save: one command on the tool's standard input.
          execFileSync("/usr/bin/security", ["-i"], {
            env,
            input: `add-generic-password -U -a "${ACCOUNT}" -s "${SERVICE}" -X "${Buffer.from(login).toString("hex")}" "${store}"\n`,
            stdio: ["pipe", "ignore", "pipe"],
            timeout: 20_000,
          });
          // The decrypt entry's bit as the tool prints it, read in its own process.
          const decrypt = run("dump-keychain", "-a", store)
            .split(/^ {4}entry \d+:/m)
            .find((entry) => entry.includes(" decrypt derive export_clear "));
          passwordBit.push(
            /^ {8}(don't-require-password|require-password)$/m.exec(decrypt ?? "")?.[1] ?? "",
          );
          expect(
            await keychain.readGenericPassword({ service: SERVICE, account: ACCOUNT }),
            `save ${save}`,
          ).toEqual({ kind: "value", value: login });
        }
        // The failing case was covered: at least one save left the bit set.
        expect(passwordBit).toContain("require-password");
        console.info(
          `Decrypt entry after each save: ${passwordBit.join(", ")}; the background read returned every one.`,
        );
      } finally {
        try {
          run("delete-keychain", store);
        } catch {
          /* the throwaway file is removed with the scratch directory */
        }
      }
    });
  },
);

describe.runIf(process.platform === "darwin")(
  "Claude's item is found whatever account the client keyed it on",
  () => {
    // INF-1798: on a real Mac the client's item was keyed on "unknown" (the
    // client runs on Bun, whose userInfo() names an unset USER that way)
    // while the app ran as USER "kunchen" and asked for that name alone.
    it("INF-2321: the child finds the service, names its account, and reads that exact item", async () => {
      const { dir, store, run, env: childEnv } = throwawayKeychain("infinitary-claude-account-");
      const login = JSON.stringify(
        {
          claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 },
        },
        null,
        2,
      );
      // The client's own write: add-generic-password -U -a <its account> -s <service> -X <hex>.
      run(
        "add-generic-password",
        "-U",
        "-a",
        "unknown",
        "-s",
        SERVICE,
        "-X",
        Buffer.from(login).toString("hex"),
        store,
      );
      try {
        const options = {
          helperPath,
          fork: (path: string, args: string[]) =>
            fork(path, args, {
              execArgv: [],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
              env: { ...childEnv, TEST_KEYCHAIN_PATH: store },
            }),
        };
        const keychain = createProcessKeychain(options);
        const request = createKeychainRequester(options);
        expect(await request({ operation: "status", keychainPath: store })).toEqual({
          kind: "status",
          state: "unlocked",
        });
        expect(
          await request({ operation: "status", keychainPath: join(dir, "missing.keychain-db") }),
        ).toEqual({ kind: "status", state: "absent" });
        expect(
          await keychain.findGenericPassword({ service: SERVICE, account: "kunchen" }),
        ).toEqual({ kind: "absent" });
        expect(await keychain.findGenericPassword({ service: SERVICE })).toEqual({
          kind: "found",
          modifiedAt: expect.any(String),
          locked: false,
          account: "unknown",
        });
        console.info(
          "Native child: missing account stayed absent; service lookup returned the actual account; multiline credential decoded through Apple’s reader.",
        );
        const configDir = join(dir, "claude");
        mkdirSync(configDir);
        const env = { HOME: join(dir, "home"), USER: "kunchen" };
        expect(await readClaudeStore(configDir, { keychain, env })).toMatchObject({
          state: "present",
        });
        clearClaudeCredentialCache(configDir);
        // The direct read is refused as for the client's real item; the
        // Apple tool reads it, pinned to the account presence found.
        expect(
          await readClaudeStore(configDir, { keychain, allowPrompt: false, env }),
        ).toMatchObject({
          state: "present",
          auth: { accessToken: TOKEN, expiresAt: expect.any(Number) },
        });
        run("lock-keychain", store);
        expect(await request({ operation: "status", keychainPath: store })).toEqual({
          kind: "status",
          state: "locked",
        });
        console.info(
          "Native startup status: existing unlocked store, missing store and locked store stayed distinct through the child process.",
        );
      } finally {
        try {
          run("delete-keychain", store);
        } catch {
          /* the throwaway file is removed with the scratch directory */
        }
      }
    });
  },
);
