import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearClaudeCredentialCache,
  readClaudeCredentialEvidence,
  resolveClaudeQuotaAuthResult,
} from "@core/claude/claudeQuota";
import { beforeAll, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readClaudeThroughTrustedTool } from "./claudeKeychainTool";
import { createDarwinKeychain, openDarwinKeychainApiForTest } from "./darwinKeychain";

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

/**
 * A throwaway keychain file in a scratch home, created and unlocked, and the
 * Apple tool run with that home: every command names the file.
 */
function throwawayKeychain(prefix: string): {
  dir: string;
  store: string;
  run: (...args: string[]) => string;
} {
  const dir = scratchDir(prefix);
  const home = join(dir, "home");
  const signing = join(dir, "signing");
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  mkdirSync(signing, { recursive: true });
  const store = join(home, "Library", "Keychains", "scratch.keychain-db");
  const env = {
    ...process.env,
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
  return { dir, store, run };
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
        ...process.env,
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
        const keychain = createDarwinKeychain(api, undefined, async (account, path) => {
          reads.push(account);
          return readClaudeThroughTrustedTool(account, path);
        });
        expect(await keychain.readGenericPassword({ service: SERVICE, account: ACCOUNT })).toEqual({
          kind: "value",
          value: login,
        });
        expect(await keychain.readGenericPassword({ service: SERVICE, account: "other" })).toEqual({
          kind: "failed",
          code: -25293,
          message: "Auth failed.",
        });
        expect(reads).toEqual([ACCOUNT]);
        console.info(
          "Scratch Library/Keychains item: direct read refused; Apple-tool-only item read; Apple-tool plus other team refused without running the tool.",
        );
        const configDir = join(dir, "claude");
        mkdirSync(configDir);
        clearClaudeCredentialCache(configDir);
        expect(
          await resolveClaudeQuotaAuthResult(configDir, {
            keychain,
            allowPrompt: false,
            env: { USER: ACCOUNT },
          }),
        ).toEqual({
          status: "resolved",
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

describe.runIf(process.platform === "darwin")(
  "Claude's item is found whatever account the client keyed it on",
  () => {
    // INF-1798: on a real Mac the client's item was keyed on "unknown" (the
    // client runs on Bun, whose userInfo() names an unset USER that way)
    // while the app ran as USER "kunchen" and asked for that name alone.
    it("finds the item by its service, names its account, and reads that one item", async () => {
      const { dir, store, run } = throwawayKeychain("infinitary-claude-account-");
      const login = JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 },
      });
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
        const keychain = createDarwinKeychain(openDarwinKeychainApiForTest(store));
        expect(
          await keychain.findGenericPassword({ service: SERVICE, account: "kunchen" }),
        ).toEqual({ kind: "absent" });
        expect(await keychain.findGenericPassword({ service: SERVICE })).toEqual({
          kind: "found",
          modifiedAt: expect.any(String),
          locked: false,
          account: "unknown",
        });
        const configDir = join(dir, "claude");
        mkdirSync(configDir);
        const env = { HOME: join(dir, "home"), USER: "kunchen" };
        expect(await readClaudeCredentialEvidence(configDir, { keychain, env })).toEqual({
          state: "live",
        });
        clearClaudeCredentialCache(configDir);
        // The direct read is refused as for the client's real item; the
        // Apple tool reads it, pinned to the account presence found.
        expect(
          await resolveClaudeQuotaAuthResult(configDir, { keychain, allowPrompt: false, env }),
        ).toEqual({
          status: "resolved",
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
