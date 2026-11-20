import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { withRejectedReadings } from "./pushedQuota";
import {
  heldAgainst,
  lowestLeft,
  recordCutOff,
  type SpentAllowanceSeams,
  spentAllowanceOf,
} from "./spentAllowance";

// INF-443 piece 1: an xAI 402 names no reset, so the hold takes the limiting
// window of the sign-in's own latest reading. The shape is Grok's saved
// reading on INF-438's Mac mini: 19% left, credits resetting Monday 8:59 PM
// Pacific (2026-10-20T03:59Z).
const NOW = Date.parse("2026-10-18T18:48:00Z");
const RESET = Date.parse("2026-10-20T03:59:00Z");

function snapshot(windows: QuotaSnapshotView["providers"][number]["windows"]): QuotaSnapshotView {
  return {
    generatedAt: new Date(NOW).toISOString(),
    fetchedAt: NOW,
    providers: [
      {
        provider: "grok",
        label: "Grok",
        accountId: "acct_grok",
        status: "ok",
        stale: false,
        measuredAt: NOW,
        windows,
      },
    ],
  };
}

const credits = { id: "credits", label: "Credits", percentRemaining: 19, resetsAtMs: RESET };

describe("spentAllowanceOf", () => {
  it("holds against the window with the least left, with its reset and reading", () => {
    const reading = snapshot([
      { id: "daily", label: "Daily", percentRemaining: 60, resetsAtMs: NOW + 3_600_000 },
      credits,
    ]);
    expect(spentAllowanceOf(reading, "acct_grok", NOW)).toMatchObject({
      resetsAt: RESET,
      leftPercent: 19,
      window: { id: "credits" },
    });
  });

  it("holds nothing when the reading names no reset still ahead", () => {
    expect(
      spentAllowanceOf(
        snapshot([{ id: "credits", label: "Credits", percentRemaining: 19 }]),
        "acct_grok",
        NOW,
      ),
    ).toBeUndefined();
    expect(spentAllowanceOf(snapshot([{ ...credits, resetsAtMs: NOW }]), "acct_grok", NOW)).toBe(
      undefined,
    );
  });

  it("holds nothing from another sign-in's reading or one that is not a reading", () => {
    expect(spentAllowanceOf(snapshot([credits]), "acct_other", NOW)).toBeUndefined();
    const unavailable = snapshot([credits]);
    unavailable.providers[0] = { ...unavailable.providers[0]!, status: "unavailable" };
    expect(spentAllowanceOf(unavailable, "acct_grok", NOW)).toBeUndefined();
    expect(spentAllowanceOf(undefined, "acct_grok", NOW)).toBeUndefined();
  });
});

describe("heldAgainst", () => {
  const reading = snapshot([credits]);

  it("serves only xAI's spent allowance that names no reset", () => {
    const spent = { class: "no_headroom" } as const;
    expect(heldAgainst(spent, "xai", reading, "acct_grok", NOW)?.resetsAt).toBe(RESET);
    // Claude's and anyone else's refusal keeps its own rules.
    expect(heldAgainst(spent, "anthropic-claude", reading, "acct_grok", NOW)).toBeUndefined();
    expect(
      heldAgainst({ class: "no_headroom", resetsAt: RESET }, "xai", reading, "acct_grok", NOW),
    ).toBeUndefined();
    expect(heldAgainst({ class: "refused" }, "xai", reading, "acct_grok", NOW)).toBeUndefined();
  });
});

describe("lowestLeft", () => {
  it("is the least percent left across a reading, and none when no window shows one", () => {
    expect(lowestLeft([credits, { id: "daily", label: "Daily", percentRemaining: 4 }])).toBe(4);
    expect(lowestLeft([{ id: "credits", label: "Credits" }])).toBeUndefined();
  });
});

describe("recordCutOff", () => {
  function seams(provider: string, reading: QuotaSnapshotView | undefined, sensed?: number) {
    const calls: unknown[][] = [];
    let held = false;
    const seam: SpentAllowanceSeams = {
      providerOf: () => provider,
      latest: () => reading,
      sensedLeft: () => sensed,
      hold: (id, cutOff, seen) => {
        calls.push(["hold", id, cutOff, seen]);
        // The vault holds a spent allowance only with a reset.
        held = cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined;
      },
      holding: () => held,
      refuse: (id, refused) => calls.push(["refuse", id, refused]),
      refresh: () => calls.push(["refresh"]),
    };
    return { seam, calls };
  }

  it("holds xAI's refusal to the limiting window's reset and lays 0% over the meter until then", () => {
    const reading = snapshot([credits]);
    const { seam, calls } = seams("xai", reading);
    recordCutOff(seam, "acct_grok", { class: "no_headroom" }, NOW);
    expect(calls).toEqual([
      ["hold", "acct_grok", { class: "no_headroom", resetsAt: RESET }, { leftPercent: 19 }],
      ["refuse", "acct_grok", { windowId: "credits", resetsAt: RESET, at: NOW }],
      ["refresh"],
    ]);

    // The refused reading, laid over Grok's saved one, reads 0% left until the reset.
    const overlaid = withRejectedReadings(
      reading.providers[0]!,
      [{ windowId: "credits", status: "rejected", resetsAt: RESET, at: NOW }],
      NOW,
    );
    expect(overlaid.windows.map((w) => [w.id, w.percentRemaining])).toEqual([["credits", 0]]);
    expect(
      withRejectedReadings(
        reading.providers[0]!,
        [{ windowId: "credits", status: "rejected", resetsAt: RESET, at: NOW }],
        RESET,
      ).windows[0]?.percentRemaining,
    ).toBe(19);
  });

  it("lays nothing over the meter when no reset is known, so the 402 stays an ordinary failure", () => {
    const { seam, calls } = seams("xai", snapshot([{ id: "credits", label: "Credits" }]));
    recordCutOff(seam, "acct_grok", { class: "no_headroom" }, NOW);
    expect(calls).toEqual([["hold", "acct_grok", { class: "no_headroom" }, undefined]]);
  });

  // Reported: a Fable reset left Claude's refused meter at 0% and the account
  // held until the week's reset, because the hold kept no reading to end on.
  it("holds a refusal that names its own reset against the sensor's lowest reading", () => {
    const { seam, calls } = seams("anthropic-claude", undefined, 2);
    recordCutOff(seam, "acct_claude", { class: "no_headroom", resetsAt: RESET }, NOW);
    expect(calls).toEqual([
      ["hold", "acct_claude", { class: "no_headroom", resetsAt: RESET }, { leftPercent: 2 }],
    ]);
  });

  it("passes another provider's cut-off through as it was", () => {
    const { seam, calls } = seams("anthropic-claude", snapshot([credits]));
    recordCutOff(seam, "acct_grok", { class: "no_headroom", resetsAt: RESET }, NOW);
    expect(calls).toEqual([
      ["hold", "acct_grok", { class: "no_headroom", resetsAt: RESET }, undefined],
    ]);
  });
});
