import { describe, expect, it } from "vitest";
import { modelDisplayName, modelNames } from "./modelDisplayName";

describe("modelDisplayName", () => {
  it.each([
    ["anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", "Claude Opus 5.5"],
    ["~anthropic/claude-opus-latest", "Anthropic: Claude Opus Latest", "Claude Opus Latest"],
    ["google/gemini-long", "Google: Gemini Long (Preview)", "Gemini Long (Preview)"],
    ["x-ai/grok", "xAI: Grok", "Grok"],
    ["x-ai/grok", "SpaceXAI: Grok", "Grok"],
    ["meta-llama/llama", "Meta: Llama", "Llama"],
    ["mistralai/model", "Mistral: Model: Special Edition", "Model: Special Edition"],
  ])("removes a matching maker prefix for %s without changing the model", (id, label, expected) => {
    const model = { provider: "openrouter", id, label };
    expect(modelDisplayName(model)).toBe(expected);
    expect(model).toEqual({ provider: "openrouter", id, label });
  });

  it.each([
    ["openrouter", "unknown/custom", "Unknown: My model"],
    ["openrouter", "constructor/custom", "Constructor: My model"],
    ["openrouter", "__proto__/custom", "Custom name"],
    ["openrouter", "toString/custom", "Custom name"],
    ["openrouter", "anthropic/model", "My model: Special Edition"],
    ["openrouter", "openai/model", "Anthropic: Not an OpenAI model"],
    ["openrouter", "anthropic/model", "Anthropic: "],
    ["local-lab", "anthropic/model", "Anthropic: Custom label"],
    ["anthropic-claude", "claude-opus-5-5", "Claude Opus 5.5"],
  ])("leaves unrelated or unknown names unchanged", (provider, id, label) => {
    expect(modelDisplayName({ provider, id, label })).toBe(label);
  });
});

describe("modelNames, the one model-name lookup", () => {
  const rows = [
    { provider: "openrouter", id: "google/gemini-3-pro-image", label: "Google: Nano Banana Pro" },
    { provider: "openai-codex", id: "gpt-6-sol", label: "GPT-6 Sol" },
    { provider: "local-lab", id: "draft", label: "Research: Preview build" },
  ];
  it("names a listed or by-name model by its row, through the display rule", () => {
    const name = modelNames(rows);
    expect(name("openrouter/google/gemini-3-pro-image")).toBe("Nano Banana Pro");
    expect(name("openai-codex/gpt-6-sol")).toBe("GPT-6 Sol");
    expect(name("local-lab/draft")).toBe("Research: Preview build");
  });
  it("falls back to the bare id, never the provider-prefixed key", () => {
    const name = modelNames(rows);
    expect(name("fm-mock/mock-1")).toBe("mock-1");
    expect(name("openrouter/anthropic/claude-new")).toBe("anthropic/claude-new");
    expect(modelNames([])("openai-codex/gpt-6-sol")).toBe("gpt-6-sol");
  });
});
