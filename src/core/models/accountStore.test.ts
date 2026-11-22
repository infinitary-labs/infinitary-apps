import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AccountBackend, statusFromHealth } from "../accounts/accountBackend";
import { CLAUDE_HAIKU_CATALOG_VERSION, type ClaudeModelRow } from "../claude/claudeModelCatalog";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import { createAccountStore } from "./accountStore";

/**
 * A Claude account's models keep their names through the account store
 * (INF-713): the Models board names a model by the account's own name for it
 * until the first allowance read builds the quota catalog, so a store that
 * dropped them showed "claude-opus-5-5" for as long as that read took.
 */

afterEach(() => resetStoreLeasesForTest());

/** A Claude credential that reads healthy, with no keychain and no client. */
const claudeCredential: AccountBackend = {
  id: "claude",
  authTypes: () => ["oauth"],
  login: async () => {},
  logout: async () => undefined,
  health: async () => ({
    state: "healthy",
    authType: "oauth",
    stamp: { login: "this-mac-login", written: "file:1", client: CLAUDE_HAIKU_CATALOG_VERSION },
  }),
  renew: async () => ({ outcome: "renewed" }),
  status: async () => statusFromHealth({ state: "healthy", authType: "oauth" }),
  binding: () => ({ via: "default-login" }),
};

const bridge = { prompt: async () => "answer", notify: () => {}, openExternal: async () => {} };

const CLIENT_ROWS: ClaudeModelRow[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
];

async function claudeStore() {
  const dir = scratchDir("infinitary-account-store-");
  const store = createAccountStore(
    { accountsDir: join(dir, "accounts") },
    {
      backends: [claudeCredential],
      packaged: false,
      claudeConfigDir: () => join(dir, "claude-config"),
      claudeList: {
        read: async () => CLIENT_ROWS,
        clientVersion: async () => CLAUDE_HAIKU_CATALOG_VERSION,
      },
      rail: { protectedIds: () => [] },
    },
  );
  const account = await store.vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  await store.vault.status(account.id, { refresh: true });
  return { ...store, accountId: account.id };
}

/** What the account serves, as the Models board reads it: each model's id and name. */
function servedNames(store: Awaited<ReturnType<typeof claudeStore>>) {
  const row = store.vault.availableModelsByAccount().find((r) => r.accountId === store.accountId);
  return row?.models.map((model) => ({ id: model.id, name: model.name }));
}

describe("a Claude account's models keep their names", () => {
  it("names the shipped list before the client's catalog is read", async () => {
    const store = await claudeStore();
    expect(store.served.read(store.accountId)).toBeUndefined();
    expect(servedNames(store)).toEqual(
      CLAUDE_MODELS.map((model) => ({ id: model.id, name: model.name })),
    );
  });

  it("names each model the client's catalog served, older generations included", async () => {
    const store = await claudeStore();
    await store.served.refresh(store.accountId);
    const read = store.served.read(store.accountId);
    expect(read?.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(servedNames(store)).toEqual(
      read?.models.map((model) => ({ id: model.id, name: model.name })),
    );
    expect(servedNames(store)?.every((model) => model.name && model.name !== model.id)).toBe(true);
  });
});
