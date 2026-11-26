import { describe, expect, it } from "vitest";
import {
  type CountedPanel,
  type PanelFailingAsk,
  type PanelFailingTold,
  PanelReadCounting,
} from "./panelReadCounting";
import { PanelReadFailures } from "./panelReadFailures";

/*
 * The captain's plan for the panel status mark: the reads of their own panels
 * that keep failing are counted, the first mate hears each once, and Ask the
 * first mate tells it once. A panel added from elsewhere, a runbook's and a
 * draft are their makers' to fix.
 */

const HOUR = 3_600_000;
const LIMIT = "Error: 429 Too Many Requests: the connector allows 150 reads a day";

function panel(overrides: Partial<CountedPanel> = {}): CountedPanel {
  return {
    id: "growth",
    source: "yours",
    runbook: null,
    slice: "growth",
    serverHash: "s1",
    panel: { hash: "p1" },
    manifest: { title: "Growth" },
    ...overrides,
  };
}

function harness(panels: CountedPanel[]) {
  let now = Date.parse("2026-11-24T09:00:00.000Z");
  const failures = new PanelReadFailures({ now: () => now, periodMs: 60_000 });
  const told: PanelFailingTold[] = [];
  const asked: PanelFailingAsk[] = [];
  const counting = new PanelReadCounting(
    { failures, tell: (t) => told.push(t), ask: (a) => asked.push(a) },
    {
      loaded: () => panels,
      get: (id) => panels.find((p) => p.id === id),
      keyOf: (p) => `${p.source}:${p.slice}`,
      // A draft's slice is `<id>.draft`, as the panels service names it.
      isLive: (slice) => !slice.endsWith(".draft"),
    },
  );
  counting.watch(() => {});
  return {
    counting,
    told,
    asked,
    later: (ms: number) => {
      now += ms;
    },
  };
}

/** Two failed hourly runs an hour apart: failing on the automation's rule. */
function failTwice(h: ReturnType<typeof harness>, id = "growth", slice = id): void {
  const ran = h.counting.ran(id, slice);
  ran("refresh", HOUR, LIMIT);
  h.later(HOUR);
  ran("refresh", HOUR, LIMIT);
}

describe("PanelReadCounting", () => {
  it("counts the captain's own live panel and tells the first mate once, naming its code's version", () => {
    const growth = panel();
    const h = harness([growth]);
    h.counting.restart("growth", "growth", "p1");
    failTwice(h);
    expect(h.told).toEqual([
      {
        id: "growth",
        title: "Growth",
        version: "s1:p1",
        read: "background\u0000refresh",
        failing: {
          read: { kind: "background", task: "refresh" },
          since: "2026-11-24T09:00:00.000Z",
          tries: 2,
          answer: LIMIT,
          asked: false,
        },
      },
    ]);
    expect(h.counting.lines(growth)).toMatchObject({ failing: [{ tries: 2 }] });
  });

  it("counts nothing for a panel added from elsewhere, a runbook's panel or a draft", () => {
    const installed = panel({ id: "desk", slice: "desk", source: "installed" });
    const runbook = panel({ id: "batches", slice: "batches", runbook: "batch-repair" });
    const draft = panel({ id: "clock", slice: "clock.draft" });
    const h = harness([installed, runbook, draft]);
    for (const p of [installed, runbook, draft]) {
      const { reads } = h.counting.callerReads(p) as { reads?: unknown };
      expect(reads).toBeUndefined();
      expect(h.counting.lines(p)).toEqual({});
    }
    failTwice(h, "clock", "clock.draft");
    expect(h.told).toEqual([]);
  });

  it("starts a panel's reads over when its drawing changes or new background code starts", () => {
    const growth = panel();
    const h = harness([growth]);
    h.counting.restart("growth", "growth", "p1");
    failTwice(h);
    growth.panel = { hash: "p2" };
    h.counting.sweep();
    expect(h.counting.lines(growth)).toEqual({});

    failTwice(h);
    h.counting.restart("growth", "growth", "p2");
    expect(h.counting.lines(growth)).toEqual({});
  });

  it("tells the first mate of the captain's Ask the first mate once per failing read", () => {
    const growth = panel();
    const h = harness([growth]);
    expect(h.counting.ask(growth)).toBe(false);
    failTwice(h);
    expect(h.counting.ask(growth)).toBe(true);
    expect(h.asked).toMatchObject([{ id: "growth", title: "Growth", failing: [{ asked: true }] }]);
    expect(h.counting.ask(growth)).toBe(false);
    expect(h.asked).toHaveLength(1);
  });

  it("forgets the failing reads of a panel that left", () => {
    const growth = panel();
    const h = harness([growth]);
    failTwice(h);
    h.counting.drop("growth");
    expect(h.counting.lines(growth)).toEqual({});
  });
});
