import { describe, expect, it, vi } from "vitest";
import { firstmateCanServe } from "./firstmateAvailability";
import type { SeatPause } from "./seat";

const model = { provider: "openrouter", id: "model" };
function fixture() {
  return {
    local: false,
    model,
    available: [model],
    custom: [] as (typeof model)[],
    accounts: [{ accountId: "chosen", models: [model] }],
    flagship: {
      servesFirstmate: () => true,
      resolveAccountId: () => "chosen" as string | undefined,
      pause: () => undefined as SeatPause | undefined,
    },
  };
}

describe("selected Firstmate serving preflight", () => {
  it("qualifies the chosen account's actual model without an inference request", () => {
    expect(firstmateCanServe(fixture())).toBe(true);
  });
  it.each(["signed_out", "no_headroom", "refused", "client", "unavailable"] as const)(
    "does not welcome a %s account",
    (reason) => {
      const f = fixture();
      f.flagship.pause = () => ({ class: reason });
      expect(firstmateCanServe(f)).toBe(false);
    },
  );
  it("rejects an empty catalog, unrelated serving account, disabled/role-ineligible provider and missing pinned model", () => {
    const f = fixture();
    expect(firstmateCanServe({ ...f, available: [] })).toBe(false);
    expect(
      firstmateCanServe({ ...f, accounts: [{ accountId: "unrelated", models: [model] }] }),
    ).toBe(false);
    expect(
      firstmateCanServe({ ...f, flagship: { ...f.flagship, servesFirstmate: () => false } }),
    ).toBe(false);
    expect(firstmateCanServe({ ...f, model: { ...model, id: "missing-pin" } })).toBe(false);
    expect(firstmateCanServe({ ...f, accounts: [{ accountId: "chosen", models: [] }] })).toBe(
      false,
    );
  });
  it("qualifies an actual custom provider without accounts, but not an unrelated credential", () => {
    const f = fixture();
    f.flagship.resolveAccountId = () => undefined;
    expect(firstmateCanServe(f)).toBe(false);
    expect(firstmateCanServe({ ...f, custom: [model] })).toBe(true);
  });
  it("accepts the supported local seat and does not probe a provider", () => {
    const f = fixture();
    const resolve = vi.fn(f.flagship.resolveAccountId);
    expect(
      firstmateCanServe({
        ...f,
        local: true,
        flagship: { ...f.flagship, resolveAccountId: resolve },
      }),
    ).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});
