import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { type AccountPool, AccountSelector } from "./accountRouter";

const snapshot = (
  rows: { accountId: string; percent: number | undefined }[],
): QuotaSnapshotView => ({
  generatedAt: "2026-08-17T12:00:00Z",
  fetchedAt: Date.parse("2026-08-17T12:00:00Z"),
  providers: rows.map((row) => ({
    provider: "codex",
    label: "Codex",
    accountId: row.accountId,
    accountLabel: row.accountId,
    status: "ok" as const,
    stale: false,
    windows:
      row.percent === undefined
        ? []
        : [{ id: "weekly", label: "weekly", percentRemaining: row.percent }],
  })),
});

function pool(
  accounts: {
    id: string;
    enabled?: boolean;
    connected?: boolean;
    withheld?: string;
    lastSelectedAt?: number;
  }[],
  pinned?: string,
): AccountPool & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    list: (providerId?: string) =>
      accounts
        .filter(() => providerId === undefined || providerId === "openai-codex")
        .map((account) => ({
          id: account.id,
          providerId: "openai-codex",
          label: account.id,
          enabled: account.enabled ?? true,
          ...(account.lastSelectedAt !== undefined
            ? { lastSelectedAt: account.lastSelectedAt }
            : {}),
        })),
    pinnedAccount: () => pinned,
    connectedSync: (accountId) => accounts.find((account) => account.id === accountId)?.connected,
    withheldReason: (accountId) => accounts.find((account) => account.id === accountId)?.withheld,
    markSelected: (accountId) => {
      marked.push(accountId);
    },
  };
}

describe("AccountSelector", () => {
  it("selects the best-headroom account at spawn and records the decision", async () => {
    const db = openInMemoryDatabase();
    const accounts = pool([{ id: "acct_a" }, { id: "acct_b" }]);
    const selector = new AccountSelector({
      pool: accounts,
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_a", percent: 20 },
            { accountId: "acct_b", percent: 70 },
          ]),
      },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    const chosen = await selector.selectForSpawn("task-1", "openai-codex");
    expect(chosen).toBe("acct_b");
    expect(accounts.marked).toEqual(["acct_b"]);
    const row = db
      .prepare("SELECT provider, account_id, reasons_json FROM account_decisions WHERE task_id = ?")
      .get("task-1") as { provider: string; account_id: string; reasons_json: string };
    expect(row.provider).toBe("openai-codex");
    expect(row.account_id).toBe("acct_b");
    expect(JSON.parse(row.reasons_json).join(" ")).toContain("most headroom");
  });

  it("binds only an account of the provider whose sign-in lists the routed model", async () => {
    const db = openInMemoryDatabase();
    const accounts = pool([{ id: "acct_a" }, { id: "acct_b" }]);
    const selector = new AccountSelector({
      pool: accounts,
      // The roomier account's plan does not list Terra; the other's does.
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_a", percent: 20 },
            { accountId: "acct_b", percent: 70 },
          ]),
      },
      accountModels: () => [
        { accountId: "acct_a", models: [{ provider: "openai-codex", id: "gpt-6.1-terra" }] },
        { accountId: "acct_b", models: [{ provider: "openai-codex", id: "gpt-6.1-sol" }] },
      ],
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    const pick = await selector.pickForSpawn("task-1", "openai-codex", { model: "gpt-6.1-terra" });
    expect(pick.accountId).toBe("acct_a");
    // Nothing is written until the move that uses it commits.
    expect(accounts.marked).toEqual([]);
    pick.record();
    pick.selected();
    expect(accounts.marked).toEqual(["acct_a"]);
    expect(await selector.selectForSpawn("task-2", "openai-codex", { model: "gpt-6.1-sol" })).toBe(
      "acct_b",
    );
  });

  it("prefers an account whose list confirms the routed model over one with no list", async () => {
    const db = openInMemoryDatabase();
    const accounts = pool([{ id: "acct_a" }, { id: "acct_b" }]);
    const selector = new AccountSelector({
      pool: accounts,
      // The roomier account has read no list yet; the other's lists Terra.
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_a", percent: 70 },
            { accountId: "acct_b", percent: 20 },
          ]),
      },
      accountModels: () => [
        { accountId: "acct_b", models: [{ provider: "openai-codex", id: "gpt-6.1-terra" }] },
      ],
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    expect(
      await selector.selectForSpawn("task-1", "openai-codex", { model: "gpt-6.1-terra" }),
    ).toBe("acct_b");
    // With no account confirming the model, the one with no list still serves.
    expect(await selector.selectForSpawn("task-2", "openai-codex", { model: "gpt-6.1-luna" })).toBe(
      "acct_a",
    );
  });

  // INF-443 piece 2: the record shows each account's reading and fate.
  it("saves every account's reading and what became of it", async () => {
    const db = openInMemoryDatabase();
    const selector = new AccountSelector({
      pool: pool([{ id: "acct_a" }, { id: "acct_b" }, { id: "acct_c", enabled: false }]),
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_a", percent: 20 },
            { accountId: "acct_b", percent: 70 },
          ]),
      },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    await selector.selectForSpawn("task-1", "openai-codex");
    const row = db
      .prepare("SELECT facts_json FROM decisions WHERE kind = 'account' AND task_id = ?")
      .get("task-1") as { facts_json: string };
    expect(JSON.parse(row.facts_json)).toEqual({
      kind: "account-candidates",
      candidates: [
        { accountId: "acct_a", label: "acct_a", percentRemaining: 20, status: "eligible" },
        { accountId: "acct_b", label: "acct_b", percentRemaining: 70, status: "picked" },
        { accountId: "acct_c", label: "acct_c", status: "skipped: disabled" },
      ],
    });
  });

  it("returns undefined when the provider has no accounts (base runtime serves)", async () => {
    const selector = new AccountSelector({
      pool: pool([]),
      quota: { latest: () => undefined },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(openInMemoryDatabase()),
    });
    expect(await selector.selectForSpawn("task-1", "openai-codex")).toBeUndefined();
  });

  it("protects the flagship account from crewmate selection", async () => {
    const selector = new AccountSelector({
      pool: pool([{ id: "acct_flag" }, { id: "acct_b" }]),
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_flag", percent: 90 },
            { accountId: "acct_b", percent: 25 },
          ]),
      },
      flagshipAccountId: () => "acct_flag",
      decisions: new DecisionStore(openInMemoryDatabase()),
    });
    expect(await selector.selectForSpawn("task-1", "openai-codex")).toBe("acct_b");
  });

  it("keeps a healthy recorded account at resume without a new decision", async () => {
    const db = openInMemoryDatabase();
    const selector = new AccountSelector({
      pool: pool([{ id: "acct_a", connected: true }]),
      quota: { latest: () => undefined },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    const result = await selector.reselectForResume("task-1", "acct_a");
    expect(result).toEqual({ accountId: "acct_a", changed: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM account_decisions").get()).toEqual({ n: 0 });
  });

  it("re-selects a sibling at resume when the recorded account is gone", async () => {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT INTO decisions (kind, task_id, provider, model, bucket, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "openai-codex", "gpt-5.5", "medium", "[]", Date.now());
    const selector = new AccountSelector({
      pool: pool([{ id: "acct_b", connected: true }]),
      quota: { latest: () => snapshot([{ accountId: "acct_b", percent: 50 }]) },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    const result = await selector.reselectForResume("task-1", "acct_removed");
    expect(result).toEqual({ accountId: "acct_b", changed: true });
  });

  it("reports a change with no replacement when nothing can serve the resume", async () => {
    const db = openInMemoryDatabase();
    const selector = new AccountSelector({
      pool: pool([]),
      quota: { latest: () => undefined },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });
    expect(await selector.reselectForResume("task-1", "acct_removed")).toEqual({ changed: true });
    expect(vi.isMockFunction(selector.selectForSpawn)).toBe(false);
  });
});

/**
 * The cut-off contract (W1 S7): an account withheld by a fact beside its
 * credential - a standing cut-off, a missing client - is out of the running,
 * and the spawn's account row says why, even when it belongs to a provider
 * routing never reached because the pool had already dropped its models.
 */
describe("an account withheld from serving", () => {
  it("is skipped with its reason, and a withheld account elsewhere is named too", async () => {
    const db = openInMemoryDatabase();
    const accounts = pool([
      { id: "acct_held", connected: true, withheld: "refused" },
      { id: "acct_ok", connected: true },
    ]);
    const claude = {
      id: "acct_claude",
      providerId: "anthropic-claude",
      label: "Claude",
      enabled: true,
    };
    const selector = new AccountSelector({
      pool: {
        ...accounts,
        list: (providerId?: string) =>
          providerId === undefined
            ? [...accounts.list(), claude]
            : providerId === claude.providerId
              ? [claude]
              : accounts.list(providerId),
        withheldReason: (accountId) =>
          accountId === claude.id ? "signed_out" : accounts.withheldReason(accountId),
      },
      quota: {
        latest: () =>
          snapshot([
            { accountId: "acct_held", percent: 95 },
            { accountId: "acct_ok", percent: 20 },
          ]),
      },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });

    expect(await selector.selectForSpawn("task-1", "openai-codex")).toBe("acct_ok");
    const [row] = db
      .prepare("SELECT reasons_json FROM account_decisions WHERE task_id = ?")
      .all("task-1") as { reasons_json: string }[];
    expect(JSON.parse(row?.reasons_json ?? "[]")).toEqual(
      expect.arrayContaining([
        "skipped acct_held: withheld (refused)",
        "skipped Claude (anthropic-claude): withheld (signed_out)",
      ]),
    );
  });
});

/**
 * A subscription with no quota reading anywhere must still be selectable.
 * Unknown quota is not zero quota - reading it as empty would bench a whole
 * subscription that is probably fine. OpenRouter is the standing example:
 * Infinitary reads no allowance for it.
 */
describe("selecting an account of a provider with no quota reading at all", () => {
  function openRouterPool(ids: string[]): AccountPool & { marked: string[] } {
    const marked: string[] = [];
    return {
      marked,
      list: (providerId?: string) =>
        ids
          .filter(() => providerId === undefined || providerId === "openrouter")
          .map((id) => ({ id, providerId: "openrouter", label: id, enabled: true })),
      pinnedAccount: () => undefined,
      connectedSync: () => true,
      withheldReason: () => undefined,
      markSelected: (accountId) => {
        marked.push(accountId);
      },
    };
  }

  it("still binds one, and records that the choice had no headroom to compare", async () => {
    const db = openInMemoryDatabase();
    const accounts = openRouterPool(["acct_or1", "acct_or2"]);
    const selector = new AccountSelector({
      pool: accounts,
      // The snapshot has no OpenRouter rows at all, because nothing measures it.
      quota: { latest: () => snapshot([]) },
      flagshipAccountId: () => null,
      decisions: new DecisionStore(db),
    });

    const chosen = await selector.selectForSpawn("task-or", "openrouter");
    expect(chosen).toBeDefined();
    expect(accounts.marked).toEqual([chosen]);
    const [row] = db
      .prepare("SELECT account_id, reasons_json FROM account_decisions WHERE task_id = ?")
      .all("task-or") as { account_id: string; reasons_json: string }[];
    expect(row?.account_id).toBe(chosen);
    // The "why this account" record still says something a person can read.
    expect(JSON.parse(row?.reasons_json ?? "[]").length).toBeGreaterThan(0);
  });
});
