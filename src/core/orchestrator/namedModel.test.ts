import { describe, expect, it } from "vitest";
import { namedModelOf, namedModelWords } from "./namedModel";

/**
 * Which model took a task its user named one for (FI3-444): matched the way
 * the router matches a pin, so a start's answer never claims the named model
 * when routing fell back.
 */
describe("the model that took a task its user named one for", () => {
  it("names the model when the one named took it, by id or by provider key", () => {
    expect(
      namedModelWords({ named: "claude-fable-5-1", took: "anthropic-claude/claude-fable-5-1" }),
    ).toBe("on anthropic-claude/claude-fable-5-1");
    expect(
      namedModelWords({
        named: "anthropic-claude/claude-fable-5-1",
        took: "anthropic-claude/claude-fable-5-1",
      }),
    ).toBe("on anthropic-claude/claude-fable-5-1");
    // A model whose own id holds a slash matches by that whole id.
    expect(
      namedModelWords({
        named: "anthropic/claude-fable-5-1",
        took: "openrouter/anthropic/claude-fable-5-1",
      }),
    ).toBe(
      "on openrouter/anthropic/claude-fable-5-1: anthropic/claude-fable-5-1 was not available",
    );
  });

  it("says the named one was not available when another model took it", () => {
    expect(namedModelWords({ named: "claude-fable-5-1", took: "openai-codex/gpt-6-astra" })).toBe(
      "on openai-codex/gpt-6-astra: claude-fable-5-1 was not available",
    );
    // Same id under another provider is not the provider key that was named.
    expect(
      namedModelWords({
        named: "openrouter/claude-fable-5-1",
        took: "anthropic-claude/claude-fable-5-1",
      }),
    ).toBe("on anthropic-claude/claude-fable-5-1: openrouter/claude-fable-5-1 was not available");
    // A bare id is not a suffix match.
    expect(namedModelWords({ named: "fable-5-1", took: "anthropic-claude/claude-fable-5-1" })).toBe(
      "on anthropic-claude/claude-fable-5-1: fable-5-1 was not available",
    );
  });

  it("never confirms the named model when no model is recorded", () => {
    expect(namedModelWords({ named: "claude-fable-5-1", took: null })).toBe(
      "with no model recorded, so claude-fable-5-1 is not confirmed",
    );
  });

  it("reads the named model off the record's shape, and nothing when none was named", () => {
    expect(
      namedModelOf({
        model: "fm-mock/mock-1",
        shape: { kind: "unclear", override_model_id: " mock-1 " },
      }),
    ).toEqual({ named: "mock-1", took: "fm-mock/mock-1" });
    expect(namedModelOf({ model: "fm-mock/mock-1", shape: null })).toBeUndefined();
    expect(namedModelOf({ model: "fm-mock/mock-1", shape: { kind: "implement" } })).toBeUndefined();
  });
});
