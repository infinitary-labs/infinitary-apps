import {
  catalogDigest,
  familyHeads,
  listedIds,
  staleDefaults,
  vanishedFamilies,
} from "@shared/modelListing";
import { HELD_BACK } from "@shared/modelSlots";
import { describe, expect, it } from "vitest";
import { checkCatalog } from "./catalogChecks";

/**
 * The lean-list rule against the catalogs Infinitary actually meets
 * (docs/model-lists.md): Claude's Sonnet 5.5 catalog, and each
 * Pi provider's catalog shape.
 */

const CLAUDE_CURRENT = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

describe("the rows a catalog gets", () => {
  it("lists Claude's current four and leaves the eight older generations by name", () => {
    expect([...listedIds("anthropic-claude", CLAUDE_CURRENT)].sort()).toEqual([
      "claude-fable-5-1",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
  });

  it("keeps a model the user kept, whatever generation it is", () => {
    const kept = new Set(["claude-opus-4-8"]);
    expect(listedIds("anthropic-claude", CLAUDE_CURRENT, kept)).toContain("claude-opus-4-8");
    expect(listedIds("anthropic-claude", CLAUDE_CURRENT)).not.toContain("claude-opus-4-8");
  });

  it("lists a starter row even when it is not its family's head", () => {
    const listed = listedIds("xai", ["grok-4.7", "grok-4.8"]);
    expect([...listed].sort()).toEqual(["grok-4.7", "grok-4.8"]);
  });

  it("gives every family of an every-family provider its newest generation", () => {
    const heads = familyHeads("openai-codex", [
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
    ]).map((head) => head.id);
    expect(heads.sort()).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
    ]);
  });

  it("lists OpenRouter's own latest aliases, not its 388 ids", () => {
    const listed = listedIds("openrouter", [
      "anthropic/claude-3-haiku",
      "anthropic/claude-opus-5.5",
      "~anthropic/claude-opus-latest",
      "~x-ai/grok-latest",
      "x-ai/grok-4.20",
    ]);
    expect([...listed].sort()).toEqual(["~anthropic/claude-opus-latest", "~x-ai/grok-latest"]);
  });

  it("lists everything of a provider the table does not name - the user's models.json", () => {
    expect([...listedIds("local-lab", ["a-1", "a-2"])].sort()).toEqual(["a-1", "a-2"]);
  });
});

describe("what a live check fails on", () => {
  it("finds a default a generation behind - the Grok 4.7 case", () => {
    expect(staleDefaults("xai", ["grok-4.6", "grok-4.7"])).toEqual([]);
    expect(staleDefaults("anthropic-claude", CLAUDE_CURRENT)).toEqual([]);
    expect(staleDefaults("xai", ["grok-4.6", "grok-4.7", "grok-4.8"])).toEqual([
      { id: "grok-4.7", newer: "grok-4.8" },
    ]);
  });

  it("fails a Codex Sol or Terra starter no longer served, held back or not", () => {
    const served = ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"];
    expect(staleDefaults("openai-codex", served)).toEqual([]);
    expect(checkCatalog({ providerId: "openai-codex", served }).failures).toEqual([]);
    for (const starter of ["gpt-6.1-sol", "gpt-6.1-terra"]) {
      const without = served.filter((id) => id !== starter);
      expect(checkCatalog({ providerId: "openai-codex", served: without }).failures).toContain(
        `Dead default in STARTER_SLOTS["openai-codex"] (no longer served): ${starter}`,
      );
    }
  });

  // GPT-6.2 Sol and Astra (OpenAI, 2026-11-17): the captain chose to let
  // pi.dev's overlay bring them and keep the starting levels. The served ids
  // are pi.dev's Codex list read that day plus the two GPT-6.2 ids a Pro
  // account's own Codex list named, which is what the overlay serves once
  // it describes them.
  it("lists GPT-6.2 Sol and Astra from the overlay and holds their 6.1 and 6 starters back", () => {
    const served = [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6.2-astra",
      "gpt-6.2-sol",
    ];
    const held = HELD_BACK["openai-codex"] ?? {};
    expect(staleDefaults("openai-codex", served)).toEqual([
      { id: "gpt-6-astra", newer: "gpt-6.2-astra", heldBack: held["gpt-6-astra"] },
      { id: "gpt-6.1-sol", newer: "gpt-6.2-sol", heldBack: held["gpt-6.1-sol"] },
    ]);
    expect(Object.values(held).every(Boolean)).toBe(true);
    expect(checkCatalog({ providerId: "openai-codex", served }).failures).toEqual([]);
    // Each newer generation gets its own row beside the starter it has not replaced.
    const listed = listedIds("openai-codex", served);
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6-astra"]) {
      expect(listed).toContain(id);
    }
    // The hold names only those two starters: Terra and Luna are already current.
    expect(Object.keys(held).sort()).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  });

  // INF-3678: pi.dev's overlay began serving claude-fable-5.2 for Copilot
  // and the live probe failed a merge batch on the 5.1 starter, which the
  // pinned Pi catalog still bounds. These are Copilot's ids as that overlay
  // served them.
  it("holds Copilot's Fable 5.1 starter back from the overlay's Fable 5.2 with its reason", () => {
    const served = [
      "claude-fable-5",
      "claude-fable-5.1",
      "claude-fable-5.2",
      "claude-haiku-4.5",
      "claude-haiku-5.5",
      "claude-opus-4.8",
      "claude-opus-5",
      "claude-opus-5.5",
      "claude-sonnet-4.6",
      "claude-sonnet-5",
      "claude-sonnet-5.5",
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-4-carbon",
      "gpt-5.3-codex",
      "gpt-5.4-nano",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "kimi-k3",
      "mai-code-1.1-flash",
    ];
    const reason = HELD_BACK["github-copilot"]?.["claude-fable-5.1"];
    expect(reason).toBeTruthy();
    expect(staleDefaults("github-copilot", served)).toEqual([
      { id: "claude-fable-5.1", newer: "claude-fable-5.2", heldBack: reason },
    ]);
    expect(checkCatalog({ providerId: "github-copilot", served }).failures).toEqual([]);
    // The hold names only that starter: Opus and Sonnet are already current.
    expect(Object.keys(HELD_BACK["github-copilot"] ?? {})).toEqual(["claude-fable-5.1"]);
  });

  it("names a tracked id the catalog no longer serves", () => {
    const served = ["~anthropic/claude-opus-latest", "~x-ai/grok-latest"];
    expect(vanishedFamilies("openrouter", served)).toContain("~openai/gpt-sol-latest");
    expect(vanishedFamilies("openrouter", served)).not.toContain("~x-ai/grok-latest");
    expect(vanishedFamilies("anthropic-claude", CLAUDE_CURRENT)).toEqual([]);
  });

  it("digests the rest: how much is by name only", () => {
    const digest = catalogDigest("anthropic-claude", CLAUDE_CURRENT);
    expect(digest.heads).toHaveLength(4);
    expect(digest.unlisted).toBe(8);
  });
});
