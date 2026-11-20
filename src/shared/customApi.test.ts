import { describe, expect, it } from "vitest";
import { customApiInputSchema, customLimitsText, withListedLimits } from "./customApi";

describe("custom API model limits", () => {
  it("words known limits and names an unknown one, never as zero", () => {
    expect(customLimitsText(200000, 4096)).toBe("200,000 context · 4,096 output tokens");
    expect(customLimitsText(32768)).toBe("32,768 context tokens · output limit unknown");
    expect(customLimitsText(0, 4096)).toBe("4,096 output tokens · context limit unknown");
    expect(customLimitsText(0, 0)).toBe("Limits unknown");
    expect(customLimitsText()).toBe("Limits unknown");
  });

  it("fills only blank limits from the server's list and keeps typed numbers", () => {
    const typed = { id: "typed", context: 1000, output: 100, uiId: "a" };
    const blank = { id: "blank", context: 0, output: 0, uiId: "b" };
    const half = { id: "half", context: 64000, output: 0, uiId: "c" };
    const unlisted = { id: "unlisted", context: 0, output: 0, uiId: "d" };
    const filled = withListedLimits(
      [typed, blank, half, unlisted],
      [
        { id: "typed", context: 200000, output: 8192 },
        { id: "blank", context: 131072, output: 8192 },
        { id: "half", context: 128000, output: 4096 },
      ],
    );
    expect(filled).toEqual([
      typed,
      { id: "blank", context: 131072, output: 8192, uiId: "b" },
      { id: "half", context: 64000, output: 4096, uiId: "c" },
      unlisted,
    ]);
    expect(filled[0]).toBe(typed);
    expect(filled[3]).toBe(unlisted);
  });

  it("lets a draft start with no model so the server's list can supply one", () => {
    const draft = {
      label: "Synthetic",
      baseUrl: "http://127.0.0.1:1/v1",
      mode: "local",
      protocol: "openai-completions",
      key: "",
      noKey: true,
      approvedDestination: "http://127.0.0.1:1/v1",
      unencryptedLocalApproved: true,
      allowStorageDefault: false,
      storageApproved: false,
    };
    expect(customApiInputSchema.parse({ ...draft, models: [] }).models).toEqual([]);
    expect(() =>
      customApiInputSchema.parse({
        ...draft,
        models: Array.from({ length: 101 }, (_, index) => ({
          id: `model-${index}`,
          context: 0,
          output: 0,
        })),
      }),
    ).toThrow();
  });
});
