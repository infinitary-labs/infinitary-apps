import { describe, expect, it } from "vitest";
import {
  type ComputerServedModel,
  computerSignInsSchema,
  SERVED_MODELS_MAX,
  servedForHome,
} from "./signIns";

/** OpenRouter's models as a computer's own runtime lists them. */
function openRouter(ids: readonly string[]): ComputerServedModel[] {
  return ids.map((id) => ({ provider: "openrouter", id }));
}

/** What a computer says of its sign-ins when it holds one OpenRouter account serving `models`. */
function said(models: ComputerServedModel[]) {
  return {
    providers: [],
    accounts: [],
    quota: null,
    served: [{ accountId: "acct_or", models }],
  };
}

describe("the models a computer lists for its home", () => {
  it("lists every model an account serves while they fit, as that computer read them", () => {
    // More than four hundred, as OpenRouter serves now.
    const models = openRouter(Array.from({ length: 450 }, (_, n) => `vendor-${n}/model-${n}`));
    expect(servedForHome("openrouter", models)).toEqual(models);
    expect(computerSignInsSchema.safeParse(said(models)).success).toBe(true);
  });

  it("keeps the Models board's rows when a provider outgrows the bound, so the home still reads the list", () => {
    const alias = "~anthropic/claude-sonnet-latest";
    const others = Array.from({ length: SERVED_MODELS_MAX }, (_, n) => `vendor-${n}/model-${n}`);
    const models = openRouter([...others, alias]);
    expect(computerSignInsSchema.safeParse(said(models)).success).toBe(false);

    const listed = servedForHome("openrouter", models);
    expect(listed).toHaveLength(SERVED_MODELS_MAX);
    expect(listed[0]).toEqual({ provider: "openrouter", id: alias });
    expect(computerSignInsSchema.safeParse(said(listed)).success).toBe(true);
  });
});
