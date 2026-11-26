import { describe, expect, it } from "vitest";
import { LOOKS_FAILING_TICKS } from "../orchestrator/scheduler";
import { PanelReadFailures, type PanelReadTurnedFailing } from "./panelReadFailures";

/*
 * The captain's plan for the panel status mark: a read of their panel that
 * keeps failing gets a mark, on the automation's own rule for a look that keeps
 * failing, and the first mate hears it once. Shaped like the panel that showed
 * the gap: an hourly background job whose every run hit the connector's read
 * limit, while the panel kept showing the previous day's numbers.
 */

const PERIOD = 60_000;
/** The automation's window on the minute tick: an hour. */
const WINDOW = LOOKS_FAILING_TICKS * PERIOD;
const HOUR = 3_600_000;
const START = Date.parse("2026-11-24T09:00:00.000Z");
const LIMIT = "Error: 429 Too Many Requests: the connector allows 150 reads a day";
const JOB = { kind: "background", task: "refresh" } as const;
const PANEL = "yours:growth";

function harness() {
  let now = START;
  const failures = new PanelReadFailures({ now: () => now, periodMs: PERIOD });
  const heard: PanelReadTurnedFailing[] = [];
  let changes = 0;
  failures.onFailing((turned) => heard.push(turned));
  failures.subscribe(() => {
    changes += 1;
  });
  return {
    failures,
    heard,
    changes: () => changes,
    at: (ms: number) => {
      now = START + ms;
    },
  };
}

describe("PanelReadFailures", () => {
  it("marks an hourly job failing at its second failed run and tells its listeners once", () => {
    const h = harness();
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.failing(PANEL)).toEqual([]);
    expect(h.heard).toEqual([]);
    expect(h.changes()).toBe(0);

    h.at(HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    const row = {
      read: { kind: "background", task: "refresh" },
      since: "2026-11-24T09:00:00.000Z",
      tries: 2,
      answer: LIMIT,
      asked: false,
    };
    expect(h.failures.failing(PANEL)).toEqual([row]);
    expect(h.heard).toEqual([{ panel: PANEL, key: "background\u0000refresh", failing: row }]);

    h.at(2 * HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.failing(PANEL)).toEqual([{ ...row, tries: 3 }]);
    expect(h.heard).toHaveLength(1);
  });

  it("marks a job every five minutes failing only once its failures span the window", () => {
    const h = harness();
    const every = 5 * 60_000;
    // Each failure counts for its whole five minutes, so the span reaches the
    // window at the failure that starts its last five minutes.
    const turning = WINDOW / every;
    for (let run = 1; run < turning; run += 1) {
      h.at((run - 1) * every);
      h.failures.failed(PANEL, JOB, LIMIT, every);
    }
    expect(h.failures.failing(PANEL)).toEqual([]);
    h.at((turning - 1) * every);
    h.failures.failed(PANEL, JOB, LIMIT, every);
    expect(h.failures.failing(PANEL).map((row) => row.tries)).toEqual([turning]);
    expect(h.heard).toHaveLength(1);
  });

  it("never marks a single failure, however long its cadence", () => {
    const h = harness();
    h.failures.failed(PANEL, JOB, LIMIT, 24 * HOUR);
    expect(h.failures.failing(PANEL)).toEqual([]);
  });

  it("counts an integration call, which has no cadence, from its first failure to its newest", () => {
    const h = harness();
    const call = {
      kind: "call",
      integration: "conn-1",
      place: "Analytics",
      action: "visits",
    } as const;
    h.failures.failed(PANEL, call, LIMIT);
    h.at(HOUR - 60_000);
    h.failures.failed(PANEL, call, LIMIT);
    expect(h.failures.failing(PANEL)).toEqual([]);
    h.at(HOUR);
    h.failures.failed(PANEL, call, LIMIT);
    expect(h.failures.failing(PANEL)).toEqual([
      {
        read: { kind: "call", place: "Analytics", action: "visits" },
        since: "2026-11-24T09:00:00.000Z",
        tries: 3,
        answer: LIMIT,
        asked: false,
      },
    ]);
  });

  it("clears a failing read at the first run that works, so the next failure starts over", () => {
    const h = harness();
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    h.at(HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    const before = h.changes();
    h.at(2 * HOUR);
    h.failures.worked(PANEL, JOB);
    expect(h.failures.failing(PANEL)).toEqual([]);
    expect(h.changes()).toBe(before + 1);

    h.at(3 * HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.failing(PANEL)).toEqual([]);
    h.at(4 * HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.failing(PANEL)).toMatchObject([
      { since: "2026-11-24T12:00:00.000Z", tries: 2 },
    ]);
    expect(h.heard).toHaveLength(2);
  });

  it("answers the captain's Ask the first mate once per failing read", () => {
    const h = harness();
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.ask(PANEL)).toEqual([]);
    h.at(HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.ask(PANEL)).toMatchObject([{ read: { task: "refresh" }, asked: true }]);
    expect(h.failures.failing(PANEL)).toMatchObject([{ asked: true }]);
    expect(h.failures.ask(PANEL)).toEqual([]);
  });

  it("forgets a panel whose code changed or that left", () => {
    const h = harness();
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    h.at(HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    h.failures.forget(PANEL);
    expect(h.failures.failing(PANEL)).toEqual([]);
    h.at(2 * HOUR);
    h.failures.failed(PANEL, JOB, LIMIT, HOUR);
    expect(h.failures.failing(PANEL)).toEqual([]);
  });
});
