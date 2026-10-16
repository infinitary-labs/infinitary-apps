import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { ClaudeCredentialEvidence } from "../claude/claudeQuota";
import type { HostKeychain, HostKeychainOutcome } from "../host";
import { appPathsFor } from "../paths";
import type { AuthInteractionBridge } from "../pi/piAuth";

/**
 * Claude accounts inside the vault: one Claude account ever, bound to the
 * machine's default login (CD-1=B), sitting next to Pi accounts that still
 * get a per-account store. The Pi runtime is faked the same way
 * accountVault.test.ts fakes it.
 */

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async (options: { authPath: string }) => ({
      login: vi.fn(async (providerId: string) => {
        writeFileSync(options.authPath, JSON.stringify({ [providerId]: { type: "oauth" } }));
      }),
      logout: vi.fn(async () => {}),
      hasConfiguredAuth: () => existsSync(options.authPath),
      isUsingOAuth: () => true,
      getAuth: vi.fn(async () => ({ auth: { apiKey: "resolved-token" } })),
      getAvailableSnapshot: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
      getModel: () => undefined,
    })),
  },
}));

const { AccountVault } = await import("../pi/accountVault");
const { CLAUDE_LOGIN_UNREADABLE_TEXT, ClaudeAuthBackend } = await import("../claude/claudeAuth");
const { claudeAvailableModels } = await import("../claude/claudeModels");
const { PiAccountBackend } = await import("../pi/piAccountBackend");

/** A stand-in for Claude's client: writes and reads one directory, nothing else. */
const fakeClaudeClient = async (
  args: string[],
  configDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const marker = join(configDir, "credential");
  if (args[1] === "login") {
    writeFileSync(marker, "opaque");
    return { code: 0, stdout: "", stderr: "" };
  }
  if (args[1] === "logout") {
    writeFileSync(marker, "");
    return { code: 0, stdout: "", stderr: "" };
  }
  const loggedIn = existsSync(marker) && readFileSync(marker, "utf8").length > 0;
  return {
    code: loggedIn ? 0 : 1,
    stdout: JSON.stringify({
      loggedIn,
      authMethod: "claude.ai",
      ...(loggedIn ? { email: "kun@example.com", subscriptionType: "max" } : {}),
    }),
    stderr: "",
  };
};

/** File-only evidence so tests never read the developer's Keychain. */
const fileEvidence = async (configDir: string): Promise<ClaudeCredentialEvidence> => {
  const marker = join(configDir, "credential");
  const present = existsSync(marker) && readFileSync(marker, "utf8").length > 0;
  return present ? { state: "live" } : { state: "absent" };
};

function vault() {
  const paths = appPathsFor(scratchDir("infinitary-claude-vault-"));
  const store = scratchDir("infinitary-claude-default-");
  return {
    paths,
    store,
    vault: AccountVault.create(paths, {
      pi: new PiAccountBackend(),
      backends: [
        new ClaudeAuthBackend({
          run: fakeClaudeClient,
          available: () => true,
          configDir: () => store,
          evidence: fileEvidence,
          primeKeychain: async () => {},
        }),
      ],
      modelsForAccount: ({ providerId }) =>
        providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
    }),
  };
}

function bridge(): AuthInteractionBridge {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  return {
    prompt: async (prompt: AuthPromptView) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (notice: AuthNotice) => notices.push(notice),
    openExternal: async () => {},
  };
}

describe("Claude accounts in the vault", () => {
  it("adds one into its own 0700 store and labels it from the reported identity", async () => {
    const { paths, vault: subject } = vault();
    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());

    const dir = join(paths.accountsDir, CLAUDE_PROVIDER_ID, account.id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(account.kind).toBe("subscription_oauth");
    // Claude knows who signed in, so the row starts with a name that means
    // something instead of "Personal".
    expect(account.label).toBe("kun@example.com");
    expect((await subject.status(account.id)).connected).toBe(true);
  });

  it("binds as the machine's default login - never a credential, never a vault config dir", async () => {
    const { paths, vault: subject } = vault();
    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());

    const binding = subject.binding(account.id);
    expect(binding).toEqual({ via: "default-login" });
    expect(JSON.stringify(binding)).not.toContain("opaque");
    // The vault still keeps a bookkeeping directory; it is not the login.
    expect(statSync(join(paths.accountsDir, CLAUDE_PROVIDER_ID, account.id)).mode & 0o777).toBe(
      0o700,
    );
  });

  it("refuses a second Claude account, and removal does not sign the machine out", async () => {
    const { paths, store, vault: subject } = vault();
    const first = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    await expect(subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge())).rejects.toThrow(
      /login already on this computer/,
    );

    const firstDir = join(paths.accountsDir, CLAUDE_PROVIDER_ID, first.id);
    await subject.remove(first.id);

    expect(existsSync(firstDir)).toBe(false);
    expect(subject.list(CLAUDE_PROVIDER_ID)).toEqual([]);
    // Unbind only: the vendor login the fake wrote is still there.
    expect(existsSync(join(store, "credential"))).toBe(true);
  });

  it("keeps a Claude account out of Pi's runtime and out of the quota sensor", async () => {
    const { vault: subject } = vault();
    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());

    // A default-login account has no in-process Pi runtime to hand out, and
    // never resolves a credential for the HTTP sensor: Infinitary holds nothing.
    expect(() => subject.runtimeFor(account.id)).toThrow(/does not run on Pi/);
    await expect(subject.resolveForQuota(account.id)).resolves.toBeUndefined();
  });

  it("contributes the subscription's models once it is connected", async () => {
    const { vault: subject } = vault();
    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    await subject.status(account.id);

    const models = subject.availableModels();
    expect(models).toContainEqual({ provider: CLAUDE_PROVIDER_ID, id: "claude-opus-5-5" });

    // A paused account leaves the pool, models and all.
    subject.setEnabled(account.id, false);
    expect(subject.availableModels()).toEqual([]);
  });

  it("leaves nothing behind when a sign-in fails", async () => {
    const paths = appPathsFor(scratchDir("infinitary-claude-vault-"));
    const store = scratchDir("infinitary-claude-default-");
    const failing = AccountVault.create(paths, {
      pi: new PiAccountBackend(),
      backends: [
        new ClaudeAuthBackend({
          run: async (args) =>
            args[1] === "status"
              ? { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }
              : { code: 1, stdout: "", stderr: "Sign-in was cancelled." },
          available: () => true,
          configDir: () => store,
          evidence: async () => ({ state: "absent" }),
          primeKeychain: async () => {},
        }),
      ],
    });
    await expect(failing.add(CLAUDE_PROVIDER_ID, "oauth", bridge())).rejects.toThrow(
      "Sign-in was cancelled.",
    );
    expect(failing.list()).toEqual([]);
    expect(existsSync(join(paths.accountsDir, CLAUDE_PROVIDER_ID))).toBe(false);
  });
});

/**
 * The real store read (`readClaudeCredentialEvidence`) over a Keychain whose
 * attribute probe fails - a denied or timed-out read - behind the vault's
 * own entry points: Connect (`add`) and the row's Sign in (`signIn`). A new
 * vendor sign-in replaces the stored login and can sign out every Claude
 * Code session already running on the Mac, so a store Infinitary cannot read
 * must never start one.
 */
describe("signing in over a login Infinitary cannot read", () => {
  function unreadableVault(options: { clientSignedIn?: boolean } = {}) {
    const paths = appPathsFor(scratchDir("infinitary-claude-vault-"));
    const store = scratchDir("infinitary-claude-default-");
    const calls: string[][] = [];
    const keychain: HostKeychain & { presence: HostKeychainOutcome } = {
      presence: { kind: "failed", code: -25308, message: "User interaction is not allowed." },
      findGenericPassword: async () => keychain.presence,
      readGenericPassword: async () => keychain.presence,
    };
    const subject = AccountVault.create(paths, {
      pi: new PiAccountBackend(),
      backends: [
        new ClaudeAuthBackend({
          run: async (args, configDir) => {
            calls.push(args);
            if (options.clientSignedIn && args[1] === "status") {
              return {
                code: 0,
                stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
                stderr: "",
              };
            }
            return fakeClaudeClient(args, configDir);
          },
          available: () => true,
          configDir: () => store,
          keychain,
          primeKeychain: async () => {},
        }),
      ],
    });
    const vendorSignIns = () => calls.filter((args) => args[1] === "login").length;
    return { paths, store, keychain, subject, vendorSignIns };
  }

  it("Connect starts no vendor sign-in, says why, and leaves no account", async () => {
    const { paths, store, subject, vendorSignIns } = unreadableVault();

    await expect(subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge())).rejects.toThrow(
      CLAUDE_LOGIN_UNREADABLE_TEXT,
    );
    expect(vendorSignIns()).toBe(0);
    expect(existsSync(join(store, "credential"))).toBe(false);
    expect(subject.list()).toEqual([]);
    expect(existsSync(join(paths.accountsDir, CLAUDE_PROVIDER_ID))).toBe(false);
  });

  it("the row's Sign in starts no vendor sign-in over it either", async () => {
    const { keychain, subject, vendorSignIns } = unreadableVault();
    // Connected while the store answered; then the read starts failing.
    keychain.presence = { kind: "found" };
    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    keychain.presence = { kind: "failed", message: "The Keychain read timed out." };

    await expect(subject.signIn(account.id, bridge())).rejects.toThrow(
      CLAUDE_LOGIN_UNREADABLE_TEXT,
    );
    expect(vendorSignIns()).toBe(0);
    expect(subject.list(CLAUDE_PROVIDER_ID).map((row) => row.id)).toEqual([account.id]);
  });

  it("adopts the login when Claude itself still reads it as signed in", async () => {
    const { subject, vendorSignIns } = unreadableVault({ clientSignedIn: true });

    const account = await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vendorSignIns()).toBe(0);
    expect(subject.list(CLAUDE_PROVIDER_ID).map((row) => row.id)).toEqual([account.id]);
  });

  it("a store that answers 'nothing here' still gets the first-time sign-in", async () => {
    const { keychain, store, subject, vendorSignIns } = unreadableVault();
    keychain.presence = { kind: "absent" };

    await subject.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vendorSignIns()).toBe(1);
    expect(existsSync(join(store, "credential"))).toBe(true);
  });
});

describe("status reads against a spawned client", () => {
  it("caches and single-flights, so a polling tab does not respawn it per tick", async () => {
    let calls = 0;
    const paths = appPathsFor(scratchDir("infinitary-claude-vault-"));
    const store = scratchDir("infinitary-claude-default-");
    const counting = AccountVault.create(paths, {
      pi: new PiAccountBackend(),
      backends: [
        new ClaudeAuthBackend({
          run: async (args, configDir) => {
            if (args[1] !== "login") calls += 1;
            return fakeClaudeClient(args, configDir);
          },
          available: () => true,
          configDir: () => store,
          evidence: fileEvidence,
          primeKeychain: async () => {},
        }),
      ],
    });
    const account = await counting.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    const afterAdd = calls;

    // Ten concurrent polls, then ten more: the client is not started again.
    await Promise.all(Array.from({ length: 10 }, () => counting.status(account.id)));
    await counting.views();
    expect(calls).toBe(afterAdd);

    // A refresh is still available where the answer has to be current.
    await counting.status(account.id, { refresh: true });
    expect(calls).toBe(afterAdd + 1);
  });
});
