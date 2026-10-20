import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CLIENT_MISSING_TEXT } from "@shared/claudeClient";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AccountBackend, type AccountRef, statusFromHealth } from "../accounts/accountBackend";
import type {
  CredentialHealth,
  CredentialStamp,
  RenewalOutcome,
  RenewReason,
} from "../accounts/credentialHealth";
import { CredentialHealthService } from "../accounts/credentialHealthService";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { claudeAvailableModels } from "../claude/claudeModels";
import { resolveClaudeQuotaAuth } from "../claude/claudeQuota";
import { appPathsFor } from "../paths";
import type { AuthInteractionBridge } from "./piAuth";

/**
 * The vault runs against a fake ModelRuntime keyed by authPath: login
 * writes a marker credential file (as Pi would), logout deletes it, and
 * status reads it - so the isolation and lifecycle guarantees are asserted
 * against the real directory tree.
 */

type FakeRuntime = {
  authPath: string;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  hasConfiguredAuth: (providerId: string) => boolean;
  isUsingOAuth: () => boolean;
  getAuth: ReturnType<typeof vi.fn>;
  getAvailableSnapshot: () => { provider: string; id: string }[];
  getModel: () => undefined;
};

const fakes = vi.hoisted(() => ({
  runtimes: [] as { authPath: string; runtime: unknown }[],
  failNextCreate: { value: false },
  failNextLogin: { value: false },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  // Pi's own read of a stored credential, as the Copilot meter uses it.
  readStoredCredential: (await importOriginal<typeof import("@earendil-works/pi-coding-agent")>())
    .readStoredCredential,
  ModelRuntime: {
    create: vi.fn(async (options: { authPath: string; modelsPath: string }) => {
      if (fakes.failNextCreate.value) {
        fakes.failNextCreate.value = false;
        throw new Error("runtime create failed");
      }
      const runtime: FakeRuntime = {
        authPath: options.authPath,
        login: vi.fn(async (providerId: string) => {
          if (fakes.failNextLogin.value) {
            fakes.failNextLogin.value = false;
            throw new Error("Sign in cancelled");
          }
          writeFileSync(options.authPath, JSON.stringify({ [providerId]: { type: "oauth" } }));
        }),
        logout: vi.fn(async () => {}),
        hasConfiguredAuth: () => existsSync(options.authPath),
        isUsingOAuth: () => true,
        getAuth: vi.fn(async () => ({ auth: { apiKey: "resolved-token" } })),
        getAvailableSnapshot: () => [
          { provider: "openai-codex", id: "gpt-5.5" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
        getModel: () => undefined,
      };
      fakes.runtimes.push({ authPath: options.authPath, runtime });
      return runtime;
    }),
  },
}));

const { AccountVault } = await import("./accountVault");

function bridge(): AuthInteractionBridge & { notices: AuthNotice[]; prompts: AuthPromptView[] } {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  return {
    notices,
    prompts,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (notice) => {
      notices.push(notice);
    },
    openExternal: async () => {},
  };
}

function freshPaths() {
  return appPathsFor(scratchDir("infinitary-vault-"));
}

beforeEach(() => {
  fakes.runtimes.length = 0;
  fakes.failNextCreate.value = false;
});

describe("AccountVault", () => {
  it("adds accounts into isolated 0700 stores with positional default labels", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const first = await vault.add("openai-codex", "oauth", bridge());
    const second = await vault.add("openai-codex", "oauth", bridge());

    expect(first.label).toBe("Personal");
    expect(second.label).toBe("Account #2");
    expect(first.kind).toBe("subscription_oauth");

    const firstDir = join(paths.accountsDir, "openai-codex", first.id);
    const secondDir = join(paths.accountsDir, "openai-codex", second.id);
    expect(statSync(firstDir).mode & 0o777).toBe(0o700);
    expect(statSync(secondDir).mode & 0o777).toBe(0o700);
    // Pi wrote the credential inside the store; the vault clamped it to 0600.
    expect(statSync(join(firstDir, "auth.json")).mode & 0o777).toBe(0o600);

    const views = await vault.views();
    expect(views).toHaveLength(2);
    expect(views.every((view) => view.connected && view.enabled)).toBe(true);
  });

  it("tags login prompts and notices with the account id for row routing", async () => {
    const vault = AccountVault.create(freshPaths());
    const capture = bridge();
    const account = await vault.add("openai-codex", "oauth", capture);
    const runtime = fakes.runtimes.at(-1)?.runtime as FakeRuntime;
    const interaction = runtime.login.mock.calls[0]?.[2] as {
      prompt: (p: { type: string; message: string }) => Promise<string>;
      notify: (e: Record<string, unknown>) => void;
    };
    await interaction.prompt({ type: "secret", message: "Paste your key" });
    interaction.notify({ type: "auth_url", url: "https://provider.example/auth" });
    interaction.notify({
      type: "device_code",
      verificationUri: "https://provider.example/device",
      userCode: "KXQT-9F2M",
    });

    expect(capture.prompts[0]).toMatchObject({
      providerId: "openai-codex",
      accountId: account.id,
      kind: "secret",
    });
    expect(capture.notices[0]).toMatchObject({ kind: "auth_url", accountId: account.id });
    expect(capture.notices[1]).toMatchObject({
      kind: "device_code",
      accountId: account.id,
      userCode: "KXQT-9F2M",
    });
  });

  it("leaves nothing behind when a login fails or is cancelled", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    fakes.failNextLogin.value = true;
    await expect(vault.add("openai-codex", "oauth", bridge())).rejects.toThrow("Sign in cancelled");
    expect(existsSync(join(paths.accountsDir, "openai-codex"))).toBe(false);
    expect(vault.list("openai-codex")).toHaveLength(0);

    fakes.failNextCreate.value = true;
    await expect(vault.add("xai", "oauth", bridge())).rejects.toThrow("runtime create failed");
    expect(existsSync(join(paths.accountsDir, "xai"))).toBe(false);
    expect(vault.list("xai")).toHaveLength(0);
  });

  it("removes one account without touching its siblings (structural isolation)", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const personal = await vault.add("openai-codex", "oauth", bridge());
    const work = await vault.add("openai-codex", "oauth", bridge());
    const grok = await vault.add("xai", "oauth", bridge());

    await vault.remove(work.id);

    const codexDir = join(paths.accountsDir, "openai-codex");
    expect(existsSync(join(codexDir, personal.id, "auth.json"))).toBe(true);
    expect(existsSync(join(codexDir, work.id))).toBe(false);
    expect(existsSync(join(paths.accountsDir, "xai", grok.id, "auth.json"))).toBe(true);
    expect(vault.list("openai-codex").map((account) => account.id)).toEqual([personal.id]);
    // Best-effort upstream revocation ran against the removed store only.
    const removedRuntime = fakes.runtimes.find((entry) =>
      entry.authPath.includes(work.id),
    )?.runtime;
    expect((removedRuntime as FakeRuntime).logout).toHaveBeenCalledWith("openai-codex");
  });

  it("signs an existing account in again into its own store, moving nothing else", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const personal = await vault.add("openai-codex", "oauth", bridge());
    const work = await vault.add("openai-codex", "oauth", bridge());
    vault.rename(work.id, "Muse box");
    vault.setPin("openai-codex", work.id);
    // The store lost its credential (a lapsed refresh token, say): the row
    // reads as signed out until someone signs in again.
    const workAuth = join(paths.accountsDir, "openai-codex", work.id, "auth.json");
    rmSync(workAuth);
    expect((await vault.status(work.id, { refresh: true })).connected).toBe(false);

    const capture = bridge();
    await vault.signIn(work.id, capture);

    // The harness wrote a fresh credential into the SAME store, the vault
    // clamped it, and the status read sees it without waiting out the cache.
    expect(existsSync(workAuth)).toBe(true);
    expect(statSync(workAuth).mode & 0o777).toBe(0o600);
    const view = (await vault.views()).find((entry) => entry.id === work.id);
    expect(view).toMatchObject({ connected: true, label: "Muse box", pinned: true });
    // Prompts still route to this row, and the sibling was never touched.
    const runtime = fakes.runtimes.find((entry) => entry.authPath === workAuth)?.runtime;
    expect((runtime as FakeRuntime).login).toHaveBeenCalledTimes(2);
    expect(vault.list("openai-codex").map((account) => account.id)).toEqual([personal.id, work.id]);
    expect(existsSync(join(paths.accountsDir, "openai-codex", personal.id, "auth.json"))).toBe(
      true,
    );
  });

  it("leaves a signed-out account signed out when its sign-in is cancelled", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const account = await vault.add("openai-codex", "oauth", bridge());
    const auth = join(paths.accountsDir, "openai-codex", account.id, "auth.json");
    rmSync(auth);
    fakes.failNextLogin.value = true;
    await expect(vault.signIn(account.id, bridge())).rejects.toThrow("Sign in cancelled");
    // The registry row survives - cancelling a sign-in is not a removal.
    expect(vault.list("openai-codex").map((entry) => entry.id)).toEqual([account.id]);
    expect(existsSync(auth)).toBe(false);
  });

  it("holds the Firstmate's seat off an account while a sign-in or removal rewrites its store (W1 S9)", async () => {
    const paths = freshPaths();
    const log: string[] = [];
    const vault = AccountVault.create(paths, {
      holdSeat: async (accountId) => {
        log.push(`hold ${accountId}`);
        return () => log.push(`release ${accountId}`);
      },
    });
    const account = await vault.add("openai-codex", "oauth", bridge());
    // Adding a new account rewrites no store the seat could be on.
    expect(log).toEqual([]);
    const runtime = () =>
      fakes.runtimes.find((entry) => entry.authPath.includes(account.id))?.runtime as FakeRuntime;
    runtime().login.mockImplementationOnce(async () => {
      log.push("login");
    });
    await vault.signIn(account.id, bridge());
    expect(log).toEqual([`hold ${account.id}`, "login", `release ${account.id}`]);

    // A cancelled sign-in releases the seat all the same.
    log.length = 0;
    fakes.failNextLogin.value = true;
    await expect(vault.signIn(account.id, bridge())).rejects.toThrow("Sign in cancelled");
    expect(log).toEqual([`hold ${account.id}`, `release ${account.id}`]);

    log.length = 0;
    await vault.remove(account.id);
    expect(log).toEqual([`hold ${account.id}`, `release ${account.id}`]);
  });

  it("produces bindings that reference only the account's own store and no secret", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const a = await vault.add("openai-codex", "oauth", bridge());
    const b = await vault.add("openai-codex", "oauth", bridge());

    const binding = vault.binding(a.id);
    expect(binding).toEqual({
      via: "pi-runtime",
      authPath: join(paths.accountsDir, "openai-codex", a.id, "auth.json"),
      modelsPath: join(paths.accountsDir, "openai-codex", a.id, "models.json"),
    });
    // Least exposure: nothing in A's binding references B's store.
    expect(JSON.stringify(binding)).not.toContain(b.id);
    expect(Object.keys(binding).sort()).toEqual(["authPath", "modelsPath", "via"]);
  });

  it("persists the registry across vault instances and keeps it non-secret", async () => {
    const paths = freshPaths();
    const vault = AccountVault.create(paths);
    const account = await vault.add("openai-codex", "oauth", bridge());
    vault.rename(account.id, "Work laptop");
    vault.setPin("openai-codex", account.id);
    vault.setEnabled(account.id, false);

    const reloaded = AccountVault.create(paths);
    const record = reloaded.get(account.id);
    expect(record).toMatchObject({ label: "Work laptop", enabled: false });
    expect(reloaded.pinnedAccount("openai-codex")).toBe(account.id);
    const registryRaw = statSync(join(paths.accountsDir, "registry.json"));
    expect(registryRaw.mode & 0o777).toBe(0o600);
  });

  it("clears the provider pin when the pinned account is removed", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    vault.setPin("openai-codex", account.id);
    await vault.remove(account.id);
    expect(vault.pinnedAccount("openai-codex")).toBeUndefined();
  });

  it("refuses to pin an account under a different provider", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    expect(() => vault.setPin("xai", account.id)).toThrow(/must belong to the provider/);
  });

  it("unions available models across enabled accounts, filtering Anthropic", async () => {
    const vault = AccountVault.create(freshPaths());
    const a = await vault.add("openai-codex", "oauth", bridge());
    await vault.add("openai-codex", "oauth", bridge());
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    vault.setEnabled(a.id, false);
    // Still served by the sibling account; disabling one is not a blackout.
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
  });

  it("narrows a Pi account to its own model list when one is in hand", async () => {
    // docs/model-lists.md: the account list is a filter over Pi's catalog,
    // and only while a successful read of it is in hand.
    let filter: ReadonlySet<string> | undefined;
    const vault = AccountVault.create(freshPaths(), { piModelFilter: () => filter });
    const account = await vault.add("openai-codex", "oauth", bridge());
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
    filter = new Set(["gpt-6-sol"]);
    expect(vault.availableModels()).toEqual([]);
    // The rail reads the catalog before any filter.
    expect(vault.piCatalogIds(account.id)).toEqual(["gpt-5.5"]);
    filter = undefined;
    expect(vault.availableModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.5" }]);
  });

  it("resolves quota auth through the account's own runtime", async () => {
    const vault = AccountVault.create(freshPaths());
    const account = await vault.add("openai-codex", "oauth", bridge());
    const resolved = await vault.resolveForQuota(account.id);
    expect(resolved).toEqual({ apiKey: "resolved-token", usingOAuth: true });
    expect(await vault.resolveForQuota("acct_missing")).toBeUndefined();
  });

  it("sweeps liveness and reports accounts whose stores went stale", async () => {
    const vault = AccountVault.create(freshPaths());
    const healthy = await vault.add("openai-codex", "oauth", bridge());
    const stale = await vault.add("xai", "oauth", bridge());
    const staleRuntime = fakes.runtimes.find((entry) => entry.authPath.includes(stale.id))
      ?.runtime as FakeRuntime;
    staleRuntime.getAuth.mockRejectedValue(new Error("refresh token expired"));

    const report = await vault.sweepLiveness();
    expect(report).toEqual([{ accountId: stale.id, providerId: "xai", label: "Personal" }]);
    expect(report.some((entry) => entry.accountId === healthy.id)).toBe(false);
  });

  /**
   * The captain's packaged dogfood build (2026-09-01): a Claude account whose
   * quota windows were being read live from its own store showed "sign in
   * again" AND vanished from the models catalog, because the one thing the
   * vault asked - can the client binary answer? - had failed for a reason
   * that had nothing to do with the credential (in a packaged app the client
   * resolves inside app.asar, where `spawn` cannot reach it).
   *
   * The invariant this pins: the store the quota sensor reads a window out of
   * and the store the connection check consults are ONE store, so an account
   * with a readable window cannot be reported as needing a sign-in - and it
   * keeps its models in the routing pool.
   */
  it("keeps a Claude account connected and routable when only its client probe is broken", async () => {
    const store = scratchDir("infinitary-claude-default-");
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => true,
          configDir: () => store,
          evidence: async (configDir) => {
            try {
              readFileSync(join(configDir, ".credentials.json"), "utf8");
              return { state: "live" as const };
            } catch {
              return { state: "absent" as const };
            }
          },
          primeKeychain: async () => {},
          // The client signs in and writes its own credential, exactly as it
          // does where no Keychain is available - and its STATUS read is the
          // thing that cannot run.
          run: async (args, configDir) => {
            if (args[1] === "login") {
              writeFileSync(
                join(configDir, ".credentials.json"),
                JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: 4_000_000_000 } }),
              );
              return { code: 0, stdout: "", stderr: "" };
            }
            // A miss is confirmed before the first sign-in. After that, the
            // status probe is the thing that cannot run.
            if (!existsSync(join(configDir, ".credentials.json"))) {
              return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
            }
            throw new Error("spawn ENOTDIR .../app.asar/.../claude");
          },
        }),
      ],
      modelsForAccount: ({ providerId }) =>
        providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
    });
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());

    // The premise: this account's usage credential IS readable. That is what
    // put live quota bars on a card badged "sign in again".
    expect(vault.binding(account.id)).toEqual({ via: "default-login" });
    expect(
      await resolveClaudeQuotaAuth(store, {
        keychain: {
          findGenericPassword: async () => ({ kind: "absent" }),
          readGenericPassword: async () => ({ kind: "absent" }),
        },
      }),
    ).toMatchObject({
      accessToken: "tok",
    });

    const [view] = await vault.views();
    expect(view?.connected).toBe(true);
    // The half the captain actually felt: no Claude model left to route to.
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    expect(vault.connectedSync(account.id)).toBe(true);
    // ...and no false "a provider needs sign in" card behind it.
    expect(await vault.sweepLiveness()).toEqual([]);
  });

  it("still refuses a Claude account whose store holds no credential at all", async () => {
    const store = scratchDir("infinitary-claude-default-");
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => true,
          configDir: () => store,
          evidence: async () => ({ state: "absent" }),
          primeKeychain: async () => {},
          // A login that stores nothing, and a client that says so.
          run: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }),
        }),
      ],
      modelsForAccount: () => claudeAvailableModels(),
    });

    await expect(vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge())).rejects.toThrow();
    expect(vault.availableModels()).toEqual([]);
  });

  /**
   * F14: the account's credential is live, the machine has no Claude Code.
   * The account stays (never a sign-out), its view carries the sentence,
   * and it serves no model - a spawn could only fail.
   */
  it("withholds every model from a Claude account whose machine has no client, and says why", async () => {
    const store = scratchDir("infinitary-claude-noclient-");
    // The account was added while the client was there; then the machine
    // lost it (an uninstall, a moved binary) - the credential is untouched.
    let installed = true;
    const vault = AccountVault.create(freshPaths(), {
      backends: [
        new ClaudeAuthBackend({
          available: () => installed,
          client: async () =>
            installed ? { state: "ready", executable: "/x/claude" } : { state: "missing" },
          configDir: () => store,
          evidence: async () => ({ state: "live", label: "kun@example.com" }),
          primeKeychain: async () => {},
          run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }),
        }),
      ],
      modelsForAccount: ({ providerId }) =>
        providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
    });
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vault.availableModels()).toEqual(claudeAvailableModels());

    installed = false;
    await vault.status(account.id, { refresh: true });
    const [view] = await vault.views();
    expect(view).toMatchObject({
      connected: true,
      detail: CLAUDE_CLIENT_MISSING_TEXT,
      identity: "kun@example.com",
    });
    expect(view?.needsReauth).toBeUndefined();
    // The seat's pause card says the same one sentence.
    expect(vault.withheldDetail(account.id)).toBe(CLAUDE_CLIENT_MISSING_TEXT);
    expect(vault.availableModels()).toEqual([]);
    expect(vault.availableModelsByAccount()).toEqual([]);
    // Never a sign-out: no "a provider needs sign in" card behind it.
    expect(await vault.sweepLiveness()).toEqual([]);

    // The client comes back: the models do too, with no sign-in.
    installed = true;
    await vault.status(account.id, { refresh: true });
    expect((await vault.views())[0]?.detail).toBeUndefined();
    expect(vault.withheldDetail(account.id)).toBeUndefined();
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
  });

  it("rejects unoffered providers at add", async () => {
    const vault = AccountVault.create(freshPaths());
    await expect(vault.add("anthropic", "oauth", bridge())).rejects.toThrow(
      /not available to connect/,
    );
    await expect(vault.add("cursor", "oauth", bridge())).rejects.toThrow(
      /not available to connect/,
    );
  });

  it("loads a stored Cursor account without a row and without deleting it", async () => {
    const paths = freshPaths();
    mkdirSync(paths.accountsDir, { recursive: true });
    const retired = [
      {
        id: "acct_cursor_old",
        providerId: "cursor",
        kind: "subscription_oauth",
        label: "Work",
        enabled: true,
        createdAt: 2,
      },
    ];
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({ version: 1, accounts: retired, pins: { cursor: "acct_cursor_old" } }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list()).toEqual([]);
    expect(vault.list("cursor")).toEqual([]);
    expect(await vault.views()).toEqual([]);
    expect(vault.availableModels()).toEqual([]);
    expect(await vault.sweepLiveness()).toEqual([]);
    const stored = JSON.parse(readFileSync(join(paths.accountsDir, "registry.json"), "utf8")) as {
      accounts: { id: string }[];
    };
    expect(stored.accounts.map((account) => account.id)).toEqual(["acct_cursor_old"]);
  });

  it("loads a Kimi Code account stored before Kimi Code came back, with its pin", async () => {
    // INF-560, the captain's answer: "Load them, and let the row say sign in
    // again when the token has lapsed".
    const paths = freshPaths();
    mkdirSync(paths.accountsDir, { recursive: true });
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_kimi",
            providerId: "kimi-coding",
            kind: "api_key",
            label: "Personal",
            enabled: true,
            createdAt: 1,
          },
        ],
        pins: { "kimi-coding": "acct_kimi" },
      }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list("kimi-coding").map((account) => account.id)).toEqual(["acct_kimi"]);
    expect((await vault.views()).map((view) => [view.id, view.providerId, view.pinned])).toEqual([
      ["acct_kimi", "kimi-coding", true],
    ]);
  });

  it("loads a Copilot account stored before, and reads its allowance with its GitHub sign-in", async () => {
    // The captain's answer on INF-560: accounts stored under Copilot's id
    // before it came back load again. Its allowance is read with the
    // GitHub sign-in Pi stored, never the short-lived Copilot token.
    const paths = freshPaths();
    const store = join(paths.accountsDir, "github-copilot", "acct_copilot");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(store, "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "gho_stored-sign-in",
          access: "tid=stub;exp=1;proxy-ep=proxy.individual.githubcopilot.com",
          expires: 1,
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_copilot",
            providerId: "github-copilot",
            kind: "subscription_oauth",
            label: "Work",
            enabled: true,
            createdAt: 2,
          },
        ],
        pins: {},
      }),
    );
    const vault = AccountVault.create(paths);
    expect(vault.list().map((account) => [account.id, account.providerId])).toEqual([
      ["acct_copilot", "github-copilot"],
    ]);
    expect(await vault.resolveForQuota("acct_copilot")).toEqual({
      apiKey: "gho_stored-sign-in",
      baseUrl: "https://api.github.com",
      usingOAuth: true,
    });
    // The store is read, never rewritten: the expired Copilot token stays.
    expect(
      JSON.parse(readFileSync(join(store, "auth.json"), "utf8"))["github-copilot"].expires,
    ).toBe(1);
  });

  it("skips a stored Cursor account everywhere, keeping its store on disk", async () => {
    const paths = freshPaths();
    const store = join(paths.accountsDir, "cursor", "acct_cursor");
    mkdirSync(join(store, ".cursor"), { recursive: true });
    writeFileSync(join(store, ".cursor", "auth.json"), '{"accessToken":"kept"}');
    writeFileSync(
      join(paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "acct_cursor",
            providerId: "cursor",
            kind: "subscription_oauth",
            label: "Pro",
            enabled: true,
            createdAt: 1,
          },
        ],
        pins: { cursor: "acct_cursor" },
      }),
    );
    const vault = AccountVault.create(paths);
    await vault.warm();
    expect(vault.list()).toEqual([]);
    expect(await vault.views()).toEqual([]);
    expect(vault.availableModels()).toEqual([]);
    expect(await vault.sweepLiveness()).toEqual([]);
    // Nothing binds, routes or resumes onto it: it reads as an account that
    // is no longer registered, never as a Pi account.
    expect(vault.get("acct_cursor")).toBeUndefined();
    expect(vault.backendIdOf("acct_cursor")).toBeUndefined();
    expect(vault.connectedSync("acct_cursor")).toBe(false);
    expect(() => vault.binding("acct_cursor")).toThrow(/Unknown account/);
    expect(() => vault.runtimeFor("acct_cursor")).toThrow(/Unknown account/);
    expect(await vault.resolveForQuota("acct_cursor")).toBeUndefined();
    // Its files stay exactly where they were.
    expect(readFileSync(join(store, ".cursor", "auth.json"), "utf8")).toBe(
      '{"accessToken":"kept"}',
    );
    const stored = JSON.parse(readFileSync(join(paths.accountsDir, "registry.json"), "utf8")) as {
      accounts: { id: string }[];
    };
    expect(stored.accounts.map((account) => account.id)).toEqual(["acct_cursor"]);
  });
});

/**
 * The cut-off contract on the account (W1 S7, docs/quota.md "Typed
 * cut-offs"): a typed cut-off a session observed is a durable fact on the
 * account, read through one predicate, and it clears only when a fact
 * changes - never on a timer, and a refusal never renews.
 */
describe("a typed cut-off on the account", () => {
  type Facts = {
    health: CredentialHealth;
    stamp: CredentialStamp;
    now: number;
  };

  function claudeWorld(initial: Partial<Facts> = {}) {
    const facts: Facts = {
      health: { state: "healthy", authType: "oauth" },
      stamp: { login: "login-a", written: "file:1", client: "2.1.234" },
      now: 1_800_000_000_000,
      ...initial,
    };
    const renew = vi.fn(
      async (_account: AccountRef, _reason: RenewReason): Promise<RenewalOutcome> => ({
        outcome: "renewed",
      }),
    );
    const backend: AccountBackend = {
      id: "claude",
      authTypes: () => ["oauth"],
      login: async () => {},
      logout: async () => undefined,
      health: async () => ({ ...facts.health, stamp: { ...facts.stamp } }),
      renew,
      status: async () => statusFromHealth(facts.health),
      binding: () => ({ via: "default-login" }),
    };
    const paths = freshPaths();
    const open = () =>
      AccountVault.create(paths, {
        backends: [backend],
        modelsForAccount: ({ providerId }) =>
          providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
        now: () => facts.now,
      });
    return { facts, renew, paths, open };
  }

  async function signedInClaude(world: ReturnType<typeof claudeWorld>) {
    const vault = world.open();
    const account = await vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge());
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    return { vault, id: account.id };
  }

  it("withholds a refused login everywhere at once, while it stays connected", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);

    vault.noteCutOff(id, { class: "refused" });

    // The synchronous readers see it before any read completes.
    expect(vault.servesSync(id)).toBe(false);
    expect(vault.withheldReason(id)).toBe("refused");
    expect(vault.availableModels()).toEqual([]);
    expect(vault.availableModelsByAccount()).toEqual([]);
    // Not a sign-out: nothing proved the credential bad.
    expect(vault.connectedSync(id)).toBe(true);
    expect(await vault.health(id, { refresh: true })).toMatchObject({
      state: "degraded",
      reason: "refused",
    });
    const [view] = await vault.views();
    expect(view).toMatchObject({ connected: true });
    expect(view?.needsReauth).toBeUndefined();
    expect(await vault.sweepLiveness()).toEqual([]);
  });

  it("says the cut-off in the account's row, as a computer that runs work tells its home, until it clears", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    expect((await vault.views())[0]?.cutOff).toBeUndefined();

    vault.noteCutOff(id, { class: "signed_out" });
    expect((await vault.views())[0]?.cutOff).toEqual({
      class: "signed_out",
      since: world.facts.now,
    });
    // A spent allowance names its reset; the stamp never leaves the vault.
    const spent = claudeWorld();
    const held = await signedInClaude(spent);
    held.vault.noteCutOff(held.id, { class: "no_headroom", resetsAt: spent.facts.now + 60_000 });
    expect((await held.vault.views())[0]?.cutOff).toEqual({
      class: "no_headroom",
      since: spent.facts.now,
      resetsAt: spent.facts.now + 60_000,
    });

    // Signed in again: the credential is written anew, and the row says none.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect((await vault.views())[0]?.cutOff).toBeUndefined();
  });

  // INF-443 piece 1, question 2: credits added before the reset end the hold.
  it("ends a spent allowance early when a later reading shows more left than at the refusal, and not before", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 600 * 60_000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt }, { leftPercent: 19 });
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", resetsAt, leftPercent: 19 });

    // The meter as it stood, or lower: still spent.
    expect(vault.noteReading(id, 19)).toBe(false);
    expect(vault.noteReading(id, 3)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("no_headroom");
    // The hold is not a row's own field.
    expect((await vault.views())[0]?.cutOff).toEqual({
      class: "no_headroom",
      since: world.facts.now,
      resetsAt,
    });

    // Credits were added: more left than at the refusal.
    const heard: string[] = [];
    vault.onCutOffChange((accountId) => heard.push(accountId));
    expect(vault.noteReading(id, 64)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
    await Promise.resolve();
    expect(heard).toEqual([id]);
  });

  it("never ends a hold that did not record its reading, or a refusal, on a reading", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    expect(vault.noteReading(id, 90)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("no_headroom");

    const refused = claudeWorld();
    const held = await signedInClaude(refused);
    held.vault.noteCutOff(held.id, { class: "refused" });
    expect(held.vault.noteReading(held.id, 90)).toBe(false);
    expect(held.vault.cutOff(held.id)?.class).toBe("refused");
  });

  it("survives a restart, stamped with the login and client it was seen under", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });

    const reopened = world.open();
    // Before any read the durable fact already withholds the account.
    expect(reopened.servesSync(id)).toBe(false);
    expect(reopened.withheldReason(id)).toBe("refused");
    expect(reopened.cutOff(id)).toEqual({
      class: "refused",
      since: world.facts.now,
      stamp: { login: "login-a", written: "file:1", client: "2.1.234" },
    });
    await reopened.status(id, { refresh: true });
    expect(reopened.servesSync(id)).toBe(false);
    expect(reopened.availableModels()).toEqual([]);
  });

  it("reads a registry an older build wrote as no cut-off, and drops a shape it cannot read", () => {
    const world = claudeWorld();
    mkdirSync(world.paths.accountsDir, { recursive: true });
    const row = {
      providerId: CLAUDE_PROVIDER_ID,
      kind: "subscription_oauth",
      label: "Claude",
      enabled: true,
      createdAt: 1,
    };
    writeFileSync(
      join(world.paths.accountsDir, "registry.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          { ...row, id: "acct_old" },
          { ...row, id: "acct_bad", cutOff: { class: "banned", since: 1, stamp: {} } },
          {
            ...row,
            id: "acct_new",
            cutOff: { class: "refused", since: 5, stamp: { login: "x", written: 7 } },
          },
        ],
        pins: {},
      }),
    );
    const vault = world.open();
    expect(vault.get("acct_old")).toMatchObject({ id: "acct_old", label: "Claude" });
    expect(vault.cutOff("acct_old")).toBeUndefined();
    expect(vault.cutOff("acct_bad")).toBeUndefined();
    // A stamp part of a shape this build does not know is simply unseen.
    expect(vault.cutOff("acct_new")).toEqual({
      class: "refused",
      since: 5,
      stamp: { login: "x" },
    });
  });

  it("clears a refusal on a changed client or login, or the captain's word - never on a renewal's rewrite or the clock", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });

    // The live credential renewed itself, and a day went by: still refused.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    world.facts.now += 24 * 60 * 60 * 1000;
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);

    // A read that cannot see the login is not a changed login.
    world.facts.stamp = { written: "file:2", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");

    // The client changed: the refusal clears, and the models come back.
    world.facts.stamp = { login: "login-a", written: "file:2", client: "2.1.300" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.availableModels()).toEqual(claudeAvailableModels());

    // Another login clears it too.
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    world.facts.stamp = { ...world.facts.stamp, login: "login-b" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();

    // The captain's "Try Claude again" clears it with nothing else changed.
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    expect(vault.tryAgain(id)).toBe(true);
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.tryAgain(id)).toBe(false);
  });

  it("tells a listener each cut-off recorded or cleared, after the fact is saved and the caller's own work", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const heard: { accountId: string; serves: boolean | undefined }[] = [];
    const stop = vault.onCutOffChange((accountId) =>
      heard.push({ accountId, serves: vault.servesSync(accountId) }),
    );
    vault.noteCutOff(id, { class: "refused" });
    // Not inside the note: the caller finishes first.
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([{ accountId: id, serves: false }]);
    // The same fact again is no change.
    vault.noteCutOff(id, { class: "refused" });
    await Promise.resolve();
    expect(heard).toHaveLength(1);
    expect(vault.tryAgain(id)).toBe(true);
    await Promise.resolve();
    expect(heard).toEqual([
      { accountId: id, serves: false },
      { accountId: id, serves: true },
    ]);
    // A spent allowance is heard when it is recorded and when its reset passes.
    world.facts.now += 1;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 1_000 });
    world.facts.now += 1_000;
    expect(vault.cutOff(id)).toBeUndefined();
    await Promise.resolve();
    expect(heard).toHaveLength(4);
    stop();
    vault.noteCutOff(id, { class: "refused" });
    await Promise.resolve();
    expect(heard).toHaveLength(4);
  });

  it("never renews a refused login: not on the tick, not on the sensor's rejection", async () => {
    // An expiring credential: the tick WOULD renew it (the control).
    const world = claudeWorld({ health: { state: "expiring", authType: "oauth" } });
    const { vault, id } = await signedInClaude(world);
    const service = new CredentialHealthService({
      host: {
        listEnabled: () => vault.list().map((account) => ({ accountId: account.id })),
        health: (accountId) => vault.health(accountId, { refresh: true }),
        renew: (accountId, reason) => vault.renew(accountId, reason),
      },
    });
    await service.tick();
    expect(world.renew).toHaveBeenCalledTimes(1);

    vault.noteCutOff(id, { class: "refused" });
    for (let tick = 0; tick < 5; tick++) await service.tick();
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "withheld" });
    expect(world.renew).toHaveBeenCalledTimes(1);
  });

  it("holds a lost sign-in until the store is written again, and lets proof say sign in again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.servesSync(id)).toBe(false);
    // Only proof shows "sign in again": this is a withheld, connected account.
    expect(await vault.health(id, { refresh: true })).toMatchObject({
      state: "degraded",
      reason: "signed_out",
    });
    expect(vault.connectedSync(id)).toBe(true);
    // A lost sign-in is the one cut-off a renewal may answer (only a 401 renews).
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "renewed" });

    // Proof arrives: the sign-out reads as the sign-out it is.
    world.facts.health = { state: "needs_reauth", reason: "refresh_token_lapsed" };
    expect(await vault.health(id, { refresh: true })).toMatchObject({ state: "needs_reauth" });
    expect(vault.connectedSync(id)).toBe(false);
    expect(vault.cutOff(id)?.class).toBe("signed_out");

    // The person signs in again: the store is written, and the fact clears.
    world.facts.health = { state: "healthy", authType: "oauth" };
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
  });

  it("clears a sign-out when the same login is accepted again, without a rewrite", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    expect(vault.servesSync(id)).toBe(false);

    // A good allowance reading, or a turn that succeeded, is the provider
    // accepting this login. The stamp did not move.
    vault.noteAccepted(id);
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);

    // A refusal is not a credential problem, so acceptance does not clear it.
    vault.noteCutOff(id, { class: "refused" });
    vault.noteAccepted(id);
    expect(vault.cutOff(id)?.class).toBe("refused");

    // Signing in again to the same login rewrites nothing, and still clears
    // a sign-out.
    expect(vault.tryAgain(id)).toBe(true);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.signIn(id, bridge());
    expect(vault.cutOff(id)).toBeUndefined();
    expect(vault.servesSync(id)).toBe(true);
  });

  it("adopts the stamp from the first read that can see it, never counting that as a change", async () => {
    const world = claudeWorld({ stamp: {} });
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "signed_out" });
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.stamp).toEqual({});

    world.facts.stamp = { login: "login-a", written: "file:1" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toMatchObject({
      class: "signed_out",
      stamp: { login: "login-a", written: "file:1" },
    });

    world.facts.stamp = { login: "login-a", written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
  });

  it("never lets a looser cut-off replace a standing refusal", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    const refused = vault.cutOff(id);

    // A turn already in flight settles on a spent allowance: the refusal stands,
    // and the allowance's reset does not clear it.
    const resetsAt = world.facts.now + 60 * 60 * 1000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    expect(vault.cutOff(id)).toEqual(refused);
    expect(vault.servesSync(id)).toBe(false);
    world.facts.now = resetsAt + 1;
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "withheld" });

    // Another settles on a lost sign-in, and then the store renews itself:
    // still refused.
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.cutOff(id)?.class).toBe("refused");
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("refused");
    expect(vault.servesSync(id)).toBe(false);
  });

  it("lets a stricter cut-off replace a looser one", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    vault.noteCutOff(id, { class: "signed_out" });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    vault.noteCutOff(id, { class: "no_headroom", resetsAt: world.facts.now + 60_000 });
    expect(vault.cutOff(id)?.class).toBe("signed_out");
    vault.noteCutOff(id, { class: "refused" });
    expect(vault.cutOff(id)?.class).toBe("refused");
  });

  it("keeps the first sighting when the same cut-off is seen again", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    vault.noteCutOff(id, { class: "refused" });
    await vault.health(id, { refresh: true });
    const first = vault.cutOff(id);
    world.facts.now += 60_000;
    vault.noteCutOff(id, { class: "refused" });
    expect(vault.cutOff(id)).toEqual(first);
  });

  it("clears a spent allowance when the machine's login changes, not on a rewrite or a read that cannot see the login", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 60 * 60 * 1000;
    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    await vault.health(id, { refresh: true });

    // A routine rewrite of the same login, or a read that cannot see it.
    world.facts.stamp = { ...world.facts.stamp, written: "file:2" };
    await vault.health(id, { refresh: true });
    world.facts.stamp = { written: "file:3", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)?.class).toBe("no_headroom");

    // Another login is signed in: the old login's allowance no longer holds.
    world.facts.stamp = { login: "login-b", written: "file:4", client: "2.1.234" };
    await vault.health(id, { refresh: true });
    expect(vault.cutOff(id)).toBeUndefined();
    expect(world.open().cutOff(id)).toBeUndefined();
  });

  it("holds a spent allowance until its reset without withholding the account", async () => {
    const world = claudeWorld();
    const { vault, id } = await signedInClaude(world);
    const resetsAt = world.facts.now + 60 * 60 * 1000;

    // No reset named: nothing could clear it, so it is not held.
    vault.noteCutOff(id, { class: "no_headroom" });
    expect(vault.cutOff(id)).toBeUndefined();

    vault.noteCutOff(id, { class: "no_headroom", resetsAt });
    expect(vault.cutOff(id)).toMatchObject({ class: "no_headroom", resetsAt });
    // The quota reading carries a spent allowance; serveability does not.
    expect(vault.servesSync(id)).toBe(true);
    expect(vault.availableModels()).toEqual(claudeAvailableModels());
    expect(await vault.renew(id, "vendor_rejected")).toEqual({ outcome: "renewed" });

    world.facts.now = resetsAt - 1;
    expect(vault.cutOff(id)?.class).toBe("no_headroom");
    world.facts.now = resetsAt;
    expect(vault.cutOff(id)).toBeUndefined();
    expect(world.open().cutOff(id)).toBeUndefined();
  });
});
