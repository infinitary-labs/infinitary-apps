import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { type AccountModels, ModelSlots } from "./modelSlots";
import { quotaGateCleared } from "./quotaGate";

const grok: AccountModels = {
  accountId: "acct-grok",
  accountLabel: "work",
  providerId: "xai",
  models: [{ provider: "xai", id: "grok-4.7" }],
};

describe("a premium ask's wait", () => {
  it("holds while no model sits at premium and clears once one is placed there (FI3-848)", () => {
    // A Grok-only person: the starter map places Grok 4.7 at medium and
    // leaves premium empty, and Grok has allowance the whole time.
    const slots = new ModelSlots({
      settings: new SettingsStore(openInMemoryDatabase()),
      accounts: () => [grok],
      quotaModels: () => undefined,
    });
    slots.reconcile();
    const reads = {
      availableModels: () => grok.models.map(({ provider, id }) => ({ provider, id })),
      slotsOf: (ref: { provider: string; id: string }) => slots.slotsOf(ref),
      quota: {
        latest: () => undefined,
        latestModels: () => ({
          generatedAt: "2026-10-11T00:00:00.000Z",
          models: [
            { provider: "grok", id: "grok-4.7", label: "Grok 4.7", effectivePercentRemaining: 80 },
          ],
        }),
      },
    };
    expect(quotaGateCleared("bucket:premium", reads)).toBe(false);

    // The Models board's add: the same membership call Settings makes.
    slots.setSlotMembership("xai/grok-4.7", "premium", true);
    expect(quotaGateCleared("bucket:premium", reads)).toBe(true);
  });
});
