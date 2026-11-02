import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { ClaudeAuthBackend } from "../../src/core/claude/claudeAuth";
import type { RunClaude } from "../../src/core/claude/claudeCli";
import { scratchDir } from "./scratchDirs";

/**
 * This macOS user's Claude login on a computer that runs work, through the
 * backend that computer signs in with (`pasteCode`), into a Claude account's
 * own folder in its data folder as a sign-in there makes one: `made` signs in
 * from a pasted code, so Firstmate made the login; `adopted` finds the login
 * there already. Claude's client is a stand-in whose store names the one
 * account it holds, and whose `auth logout` signs it out.
 */
export function claudeOnComputer(dataDir: string, how: "made" | "adopted") {
  const store = scratchDir("infinitary-computer-claude-");
  const seen = { logins: 0, logouts: 0 };
  const signedIn = () => existsSync(join(store, "credential"));
  const run: RunClaude = async (args, _dir, options) => {
    if (args[0] === "auth" && args[1] === "login") {
      seen.logins += 1;
      options?.onStdout?.("visit: https://claude.com/cai/oauth/authorize?code=true&state=s\n");
      await options?.paste;
      writeFileSync(join(store, "credential"), "opaque");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "logout") {
      seen.logouts += 1;
      rmSync(join(store, "credential"), { force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ loggedIn: signedIn() }), stderr: "" };
  };
  if (how === "adopted") writeFileSync(join(store, "credential"), "already here");
  const backend = new ClaudeAuthBackend({
    run,
    available: () => true,
    readStore: async () =>
      signedIn()
        ? {
            state: "present",
            auth: { accessToken: "opaque" },
            identity: { accountUuid: "account-a" },
          }
        : { state: "absent" },
    primeKeychain: async () => {},
    configDir: () => store,
    pasteCode: true,
  });
  const account = join(dataDir, "accounts", CLAUDE_PROVIDER_ID, "acct_claude");
  mkdirSync(account, { recursive: true });
  const signIn = backend.login({
    providerId: CLAUDE_PROVIDER_ID,
    accountId: "acct_claude",
    dir: account,
    type: "oauth",
    bridge: { prompt: async () => "code#s", notify: () => {}, openExternal: async () => {} },
  });
  return {
    signIn,
    seen,
    signedIn,
    /** What the work's own run passes to sign a login Firstmate made out. */
    signOutClaude: (record: string) => backend.signOutMadeLogin(record),
  };
}
