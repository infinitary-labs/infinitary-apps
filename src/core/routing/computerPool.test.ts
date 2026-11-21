import type { AccountView } from "@shared/accounts";
import type { ComputerSignIns } from "@shared/signIns";
import { describe, expect, it } from "vitest";
import { computerBoardModels, computerPool, heldThere, servesOnComputer } from "./computerPool";
import { route } from "./routingEngine";

/**
 * What a computer that runs work can serve a task, from what it said of its
 * own sign-ins (docs/helper.md, "Its own sign-ins"): only the providers it
 * holds an account that serves, each with the account there, and the
 * allowance as read there.
 */

const NOW = Date.parse("2026-10-05T12:00:00Z");

/** This Mac's provider-wide catalog: every model it lists, signed in or not. */
const CATALOG = [
  { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
  { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "xai", id: "grok-4.3", name: "Grok 4.3" },
  { provider: "anthropic-claude", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "anthropic-claude", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
];

function account(id: string, providerId: string, extra: Partial<AccountView> = {}): AccountView {
  return {
    id,
    providerId,
    kind: "subscription_oauth",
    label: id,
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: 1,
    ...extra,
  };
}

function said(accounts: AccountView[], quota: ComputerSignIns["quota"] = null): ComputerSignIns {
  return { providers: [], accounts, quota };
}

describe("computerPool", () => {
  it("offers only the models of the subscriptions that computer is signed in to", () => {
    const pool = computerPool(
      "Mac mini",
      said([account("acct_claude", "anthropic-claude")]),
      CATALOG,
      NOW,
    );
    expect(pool.available).toEqual([
      { provider: "anthropic-claude", id: "claude-opus-5-5" },
      { provider: "anthropic-claude", id: "claude-sonnet-5-5" },
    ]);
    expect(pool.catalog.map((model) => `${model.provider}/${model.id}`).sort()).toEqual([
      "claude/claude-opus-5-5",
      "claude/claude-sonnet-5-5",
    ]);
    expect(pool.accounts).toEqual(new Map([["anthropic-claude", "acct_claude"]]));
    expect(pool.note).toBe("Mac mini's own sign-ins (anthropic-claude): 2 models");
  });

  it("leaves out an account that cannot serve there: off, signed out, needing a new sign-in, or withheld", () => {
    const pool = computerPool(
      "Builder",
      said([
        account("acct_off", "openai-codex", { enabled: false }),
        account("acct_out", "xai", { connected: false }),
        account("acct_lapsed", "openai-codex", { needsReauth: true }),
        account("acct_noclient", "anthropic-claude", {
          detail: "Claude Code is not installed on this Mac.",
        }),
      ]),
      CATALOG,
      NOW,
    );
    expect(pool.available).toEqual([]);
    expect(pool.catalog).toEqual([]);
    expect(pool.accounts.size).toBe(0);
    expect(pool.note).toBe("Builder's own sign-ins (none): 0 models");
  });

  it("skips a sign-in a cut-off stands on there, for another there that serves", () => {
    const signIns = said([
      account("acct_claude", "anthropic-claude", {
        pinned: true,
        cutOff: { class: "signed_out", since: NOW - 60_000 },
      }),
      account("acct_codex", "openai-codex"),
    ]);
    const pool = computerPool("Mac mini", signIns, CATALOG, NOW);
    expect(pool.accounts).toEqual(new Map([["openai-codex", "acct_codex"]]));
    expect(pool.available.every((model) => model.provider === "openai-codex")).toBe(true);
    // Something there still serves, so nothing waits for the cut-off one.
    expect(heldThere(signIns, NOW)).toBeUndefined();
  });

  it("waits for the sign-in a cut-off alone keeps from serving, and a spent allowance only until its reset", () => {
    for (const cutOff of [
      { class: "signed_out" as const, since: NOW - 60_000 },
      { class: "refused" as const, since: NOW - 60_000 },
      { class: "no_headroom" as const, since: NOW - 60_000, resetsAt: NOW + 3_600_000 },
    ]) {
      const signIns = said([account("acct_claude", "anthropic-claude", { cutOff })]);
      expect(computerPool("Mac mini", signIns, CATALOG, NOW).available, cutOff.class).toEqual([]);
      expect(heldThere(signIns, NOW)?.id, cutOff.class).toBe("acct_claude");
    }
    // Past its reset a spent allowance stands no more: the sign-in serves again.
    const spent = said([
      account("acct_claude", "anthropic-claude", {
        cutOff: { class: "no_headroom", since: NOW - 60_000, resetsAt: NOW - 1 },
      }),
    ]);
    expect(computerPool("Mac mini", spent, CATALOG, NOW).accounts.get("anthropic-claude")).toBe(
      "acct_claude",
    );
    expect(heldThere(spent, NOW)).toBeUndefined();
    // A sign-in that would not serve anyway is no cut-off's to wait for.
    const off = said([
      account("acct_claude", "anthropic-claude", {
        enabled: false,
        cutOff: { class: "signed_out", since: NOW - 60_000 },
      }),
    ]);
    expect(heldThere(off, NOW)).toBeUndefined();
    expect(heldThere(null, NOW)).toBeUndefined();
  });

  it("names the pinned account there for its provider, else the first that serves", () => {
    const pool = computerPool(
      "Mac mini",
      said([
        account("acct_codex_a", "openai-codex"),
        account("acct_codex_b", "openai-codex", { pinned: true }),
        account("acct_grok_a", "xai"),
        account("acct_grok_b", "xai"),
      ]),
      CATALOG,
      NOW,
    );
    expect(pool.accounts.get("openai-codex")).toBe("acct_codex_b");
    expect(pool.accounts.get("xai")).toBe("acct_grok_a");
  });

  it("carries the allowance as that computer read it, and none it did not read", () => {
    const pool = computerPool(
      "Mac mini",
      said([account("acct_codex", "openai-codex"), account("acct_grok", "xai")], {
        generatedAt: new Date(NOW).toISOString(),
        fetchedAt: NOW,
        providers: [
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct_codex",
            status: "ok",
            stale: false,
            windows: [{ id: "five_hour", label: "5h", percentRemaining: 0 }],
          },
        ],
      }),
      CATALOG,
      NOW,
    );
    const sol = pool.catalog.find((model) => model.id === "gpt-6-sol");
    const grok = pool.catalog.find((model) => model.id === "grok-4.3");
    // Spent there: the routing ladder skips it.
    expect(sol?.effectivePercentRemaining).toBe(0);
    // Unread is unknown, never zero.
    expect(grok?.effectivePercentRemaining).toBeUndefined();
  });

  // INF-5438 round 9 finding 8: the account a computer bound must have its
  // own allowance left there, not only list the model.
  it("reads a bound account whose allowance there is spent as serving nothing now", () => {
    const reading = (accountId: string, percentRemaining: number) => ({
      provider: "codex",
      label: "Codex",
      accountId,
      status: "ok" as const,
      stale: false,
      windows: [{ id: "five_hour", label: "5h", percentRemaining }],
    });
    const pool = computerPool(
      "Mac mini",
      said([account("acct_spent", "openai-codex"), account("acct_left", "openai-codex")], {
        generatedAt: new Date(NOW).toISOString(),
        fetchedAt: NOW,
        providers: [reading("acct_spent", 0), reading("acct_left", 60)],
      }),
      CATALOG,
      NOW,
    );
    const sol = { provider: "openai-codex", id: "gpt-6-sol" };
    // Both list GPT-6 Sol there.
    const listed = {
      ...pool,
      servedBy: new Map([["openai-codex/gpt-6-sol", new Set(["acct_spent", "acct_left"])]]),
    };
    expect(servesOnComputer(listed, "acct_spent", sol, NOW)).toBe(false);
    expect(servesOnComputer(listed, "acct_left", sol, NOW)).toBe(true);
  });

  it("serves nothing for a computer that has said nothing", () => {
    for (const signIns of [null, undefined]) {
      const pool = computerPool("Mac mini", signIns, CATALOG, NOW);
      expect(pool.available).toEqual([]);
      expect(pool.accounts.size).toBe(0);
    }
  });

  it("adds a computer's checked custom models, and not an unchecked one", () => {
    const signIns = said([
      account("acct_custom", "fm-custom-0123456789abcdef", { kind: "api_key" }),
    ]);
    signIns.custom = [
      {
        accountId: "acct_custom",
        label: "Studio",
        baseUrl: "http://localhost:11434/v1",
        mode: "local",
        protocol: "openai-completions",
        keyPresent: false,
        noKey: true,
        headers: [],
        enabled: true,
        allowStorageDefault: false,
        certificates: [],
        models: [
          { id: "qwen", context: 1, output: 1, checked: true, state: "checked" },
          { id: "draft", context: 1, output: 1, checked: false, state: "untested" },
        ],
      },
    ];
    const pool = computerPool("Mac mini", signIns, CATALOG, NOW);
    expect(pool.available).toEqual([{ provider: "fm-custom-0123456789abcdef", id: "qwen" }]);
    expect(pool.accounts.get("fm-custom-0123456789abcdef")).toBe("acct_custom");
    expect(
      route({
        catalog: pool.catalog,
        available: pool.available,
        slotted: [{ provider: "fm-custom-0123456789abcdef", id: "qwen", slot: "medium" }],
        pins: [],
        bucket: "medium",
      }).choice,
    ).toEqual({ provider: "fm-custom-0123456789abcdef", id: "qwen" });
    expect(
      route({
        catalog: pool.catalog,
        available: pool.available,
        slotted: [],
        pins: [],
        bucket: "medium",
      }).choice,
    ).toBeUndefined();
  });

  it("takes a computer's own list for a provider this Mac's catalog lacks", () => {
    const signIns = said([account("acct_or", "openrouter", { kind: "api_key" })]);
    signIns.served = [
      {
        accountId: "acct_or",
        models: [{ provider: "openrouter", id: "qwen/qwen3", name: "Qwen" }],
      },
    ];
    const pool = computerPool("Mac mini", signIns, CATALOG, NOW);
    expect(pool.available).toEqual([{ provider: "openrouter", id: "qwen/qwen3" }]);
    expect(pool.unowned).toEqual([{ provider: "openrouter", id: "qwen/qwen3" }]);
    expect(pool.catalog).toEqual([]);
    expect(
      route({
        catalog: pool.catalog,
        available: pool.available,
        unowned: pool.unowned,
        slotted: pool.available.map((model) => ({ ...model, slot: "medium" as const })),
        pins: [],
        bucket: "medium",
      }).choice,
    ).toEqual({ provider: "openrouter", id: "qwen/qwen3" });
  });
});

it("carries the executing computer's backend reasoning choices without inventing a home catalog", () => {
  const capabilities = { levels: ["low", "medium", "high"] as ("low" | "medium" | "high")[] };
  const rows = computerBoardModels(
    [
      {
        deviceId: "there",
        name: "Other Mac",
        onThisMac: false,
        reach: "in-reach",
        user: "captain",
        signIns: {
          accounts: [account("other", "xai")],
          providers: [],
          quota: null,
          served: [
            {
              accountId: "other",
              models: [{ provider: "xai", id: "grok-4.7", reasoningCapabilities: capabilities }],
            },
          ],
        },
      },
    ],
    new Set(),
  );
  expect(rows[0]?.models[0]?.reasoningCapabilities).toEqual(capabilities);
});
