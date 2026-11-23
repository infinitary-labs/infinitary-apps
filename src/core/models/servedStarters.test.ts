// Intent: the captain's direction C on INF-1904, "a starter list served by
// us so defaults move for every install without a release".
import { putServedStarters, type ServedStarters, STARTER_SLOTS } from "@shared/modelSlots";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountModels, ModelSlots } from "../routing/modelSlots";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { createServedStarters, STARTERS_REFRESH_MS } from "./servedStarters";

afterEach(() => putServedStarters(null));

/** The Codex starters Pi 1.5.0 bundles. */
const codexIds = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"];

/** A served file that moves Codex's medium back from Terra to Sol and names no other provider. */
const served: ServedStarters = {
  schema: 1,
  starters: {
    "openai-codex": {
      "gpt-6-astra": ["premium"],
      "gpt-6.1-sol": ["high", "medium"],
      "gpt-6-luna": ["low"],
    },
  },
};

function account(providerId: string, ids: readonly string[]): AccountModels {
  return {
    accountId: `acct-${providerId}`,
    accountLabel: "personal",
    providerId,
    models: ids.map((id) => ({ provider: providerId, id })),
  };
}

const claude = account("anthropic-claude", Object.keys(STARTER_SLOTS["anthropic-claude"] ?? {}));

function feed(...answers: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(accounts: AccountModels[]) {
  const settings = new SettingsStore(openInMemoryDatabase());
  let now = Date.parse("2026-10-29T18:00:00Z");
  const slots = new ModelSlots({
    settings,
    accounts: () => accounts,
    quotaModels: () => undefined,
    now: () => now,
  });
  return {
    settings,
    slots,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the served starter list", () => {
  it("seeds a first-seen model from its served level while unnamed providers keep the shipped rows", async () => {
    const { settings, slots, clock } = setup([account("openai-codex", codexIds), claude]);
    const { fetchImpl } = feed(json(served));
    await createServedStarters({ settings, fetchImpl, now: clock }).refresh();

    slots.reconcile();

    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual([
      "high",
      "medium",
    ]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" })).toEqual([]);
    expect(slots.slotsOf({ provider: "anthropic-claude", id: "claude-opus-5-5" })).toEqual(
      STARTER_SLOTS["anthropic-claude"]?.["claude-opus-5-5"],
    );
  });

  it("never rewrites a level an install already saved", async () => {
    const { settings, slots, clock } = setup([account("openai-codex", codexIds)]);
    slots.reconcile();
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" })).toEqual(
      STARTER_SLOTS["openai-codex"]?.["gpt-6.1-terra"],
    );
    const { fetchImpl } = feed(json(served));
    await createServedStarters({ settings, fetchImpl, now: clock }).refresh();

    slots.reconcile();

    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" })).toEqual(
      STARTER_SLOTS["openai-codex"]?.["gpt-6.1-terra"],
    );
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual(
      STARTER_SLOTS["openai-codex"]?.["gpt-6.1-sol"],
    );
    // Resetting to the defaults is the person's own way to take the served levels.
    slots.reset("openai-codex");
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" })).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual([
      "high",
      "medium",
    ]);
  });

  it("keeps the last answer through a start with no network", async () => {
    const { settings, slots, clock } = setup([account("openai-codex", codexIds)]);
    await createServedStarters({
      settings,
      fetchImpl: feed(json(served)).fetchImpl,
      now: clock,
    }).refresh();
    putServedStarters(null);

    const offline = feed(new TypeError("fetch failed"));
    await createServedStarters({ settings, fetchImpl: offline.fetchImpl, now: clock }).refresh();
    slots.reconcile();

    expect(offline.calls).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" })).toEqual([]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual([
      "high",
      "medium",
    ]);
  });

  it("asks again after a day; a failed or unreadable answer keeps the list and a 404 withdraws it", async () => {
    const { settings, slots, clock, advance } = setup([account("openai-codex", codexIds)]);
    const { calls, fetchImpl } = feed(
      json(served),
      new TypeError("fetch failed"),
      new Response("Bad gateway", { status: 502 }),
      json({ schema: 1, starters: { "openai-codex": { "gpt-6.1-terra": ["middle"] } } }),
      new Response("404: Not Found", { status: 404 }),
    );
    const reader = createServedStarters({ settings, fetchImpl, now: clock });
    const terraStarts = () => {
      slots.reset("openai-codex");
      return slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-terra" });
    };

    await reader.refresh();
    await reader.refresh();
    expect(calls).toHaveLength(1);

    for (const unanswered of ["network", "502", "bad slot"]) {
      advance(STARTERS_REFRESH_MS);
      await reader.refresh();
      expect(terraStarts(), unanswered).toEqual([]);
    }
    expect(calls).toHaveLength(4);

    await reader.refresh();
    expect(calls).toHaveLength(5);
    expect(terraStarts()).toEqual(STARTER_SLOTS["openai-codex"]?.["gpt-6.1-terra"]);
    expect(slots.slotsOf({ provider: "openai-codex", id: "gpt-6.1-sol" })).toEqual(
      STARTER_SLOTS["openai-codex"]?.["gpt-6.1-sol"],
    );
  });
});
