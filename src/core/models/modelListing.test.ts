import {
  catalogDigest,
  familyHeads,
  listedIds,
  staleDefaults,
  vanishedFamilies,
} from "@shared/modelListing";
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

  it("does not hold back Codex Sol or Terra: the 6.1 starters must be served", () => {
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
