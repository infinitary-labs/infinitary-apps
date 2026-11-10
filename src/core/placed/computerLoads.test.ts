import { takesWork } from "@shared/contractFeatures";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { LOAD_ORDER, type LoadSnapshot } from "@shared/load";
import { RESOURCE_MAX_AGE_MS, RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkDeviceContact, WorkDeviceVersion } from "../connection/connection";
import { ComputerLoads } from "./computerLoads";

// INF-1621 piece 2: the home's reader must not invent completion when contact is lost.
// This is the declaration exercised by the real native-command integration, not measured use.
const snapshot: LoadSnapshot = {
  runs: [
    {
      id: "ca5b9ada-aff3-452b-a4ce-a7cd92324237",
      taskId: "first",
      demand: { cpu: 4, memoryBytes: 4096 * 1024 ** 2 },
      state: "running",
      ahead: 0,
    },
  ],
};
// The name an older major advertised before INF-1109 absorbed it into the work major.
const change = "heavy-run-line";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture() {
  let now = 0;
  let reachable = true;
  let version: WorkDeviceVersion = {
    contract: PROTOCOL_VERSION,
    takesWork: true,
    changes: [],
  };
  let contact: (event: WorkDeviceContact) => void = () => {};
  const ask = vi.fn(
    async (_device: string, _channel: string, _args: unknown): Promise<unknown> => snapshot,
  );
  const localReads = vi.fn(() => snapshot);
  const taskIds = vi.fn(() => snapshot.runs.map((run) => run.taskId));
  const reader = new ComputerLoads({
    local: { snapshot: localReads, taskIds, reconsider: () => {} },
    overrides: () => ["captain-approved"],
    work: {
      ask,
      inReach: () => reachable,
      takesCurrentWork: () => takesWork(version.contract),
      onWorkDevice: (listener) => {
        contact = listener;
        return () => {};
      },
    },
    now: () => now,
  });
  cleanups.push(() => reader.dispose());
  return {
    reader,
    ask,
    localReads,
    taskIds,
    age: (age: number) => {
      now = age;
    },
    // A computer on the previous major takes no work, so it has no line to read.
    older: () => {
      version = {
        contract: `${Number(PROTOCOL_VERSION.split(".")[0]) - 1}.0.0`,
        takesWork: false,
      };
    },
    version: (next: WorkDeviceVersion) => {
      version = next;
    },
    contact: (state: "in-reach" | "gone") => {
      reachable = state === "in-reach";
      contact({ deviceId: "mini", contact: state });
    },
  };
}

describe("a computer's declared runs at the home", () => {
  // INF-2186: crewStatus's job check rebuilt the local declared-run queue per row.
  it("shares declared-run facts across one roster read without carrying freshness across reads", async () => {
    const f = fixture();
    for (let row = 0; row < 40; row += 1) expect(f.reader.hasTask("first", null)).toBe(true);
    const baseline = f.taskIds.mock.calls.length;
    f.taskIds.mockClear();
    await f.reader.refresh("mini");
    let projected = 0;
    f.reader.readProjection(() => {
      for (let row = 0; row < 40; row += 1) {
        expect(f.reader.hasTask("first", null)).toBe(true);
        expect(f.reader.hasTask("missing", null)).toBe(false);
      }
      projected = f.taskIds.mock.calls.length;
      expect(f.taskIds).toHaveBeenCalledTimes(1);
      expect(f.localReads).not.toHaveBeenCalled();
      expect(f.reader.hasTask("first", "mini")).toBe(true);
      f.contact("gone");
      expect(f.reader.hasTask("first", "mini")).toBe(false);
      expect(f.reader.read("mini")).toEqual({ status: "unknown", ...snapshot });
    });
    expect(baseline).toBe(40);
    f.reader.hasTask("first", null);
    expect(f.taskIds).toHaveBeenCalledTimes(2);
    expect(f.localReads).not.toHaveBeenCalled();
    console.info(
      JSON.stringify({
        intent: "INF-2186 running-job checks",
        baseline,
        projected,
        capacitySnapshots: f.localReads.mock.calls.length,
      }),
    );
  });
  it("asks only a computer on this major and carries the recorded overrides", async () => {
    const f = fixture();
    expect(f.reader.read("mini")).toBeUndefined();
    await f.reader.refresh("mini");
    expect(f.ask).toHaveBeenCalledExactlyOnceWith("mini", LOAD_ORDER, [
      { overrides: ["captain-approved"] },
    ]);
    expect(f.reader.read("mini")).toEqual({ status: "fresh", ...snapshot });
    expect(f.reader.hasTask("first", "mini")).toBe(true);
    expect(f.reader.hasTask("someone-else", "mini")).toBe(false);
    f.older();
    await f.reader.refresh("mini");
    expect(f.ask).toHaveBeenCalledTimes(1);
  });

  it("does not grant a load command to an older-major computer even when it lists the retired name (INF-1109)", async () => {
    const f = fixture();
    f.version({
      contract: `${Number(PROTOCOL_VERSION.split(".")[0]) - 1}.0.0`,
      takesWork: false,
      changes: [change],
    });
    expect(f.reader.supports("mini")).toBe(false);
    await f.reader.refresh("mini");
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.reader.read("mini")).toBeUndefined();
  });

  it("keeps last-known runs explicitly unavailable on stale readings and disconnects", async () => {
    const f = fixture();
    await f.reader.refresh("mini");
    f.age(RESOURCE_MAX_AGE_MS + 1);
    expect(f.reader.read("mini")).toEqual({ status: "unknown", ...snapshot });
    expect(f.reader.hasTask("first", "mini")).toBe(false);
    await f.reader.refresh("mini");
    expect(f.reader.hasTask("first", "mini")).toBe(true);
    f.contact("gone");
    expect(f.reader.read("mini")).toEqual({ status: "unknown", ...snapshot });
    expect(f.reader.hasTask("first", "mini")).toBe(false);
    await f.reader.refresh("mini");
    expect(f.ask).toHaveBeenCalledTimes(2);
  });

  it("keeps a timed-out request single-flight and discards answers from before reconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let answer: (value: unknown) => void = () => {};
    f.ask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = f.reader.refresh("mini");
    await vi.advanceTimersByTimeAsync(RESOURCE_READ_TIMEOUT_MS);
    await first;
    await f.reader.refresh("mini");
    expect(f.ask).toHaveBeenCalledTimes(1);
    f.contact("gone");
    f.contact("in-reach");
    f.ask.mockResolvedValueOnce({ runs: [] });
    await f.reader.refresh("mini");
    answer(snapshot);
    await Promise.resolve();
    expect(f.reader.read("mini")).toEqual({ status: "fresh", runs: [] });
  });

  it("does not replace a known living run with an empty answer on malformed data", async () => {
    const f = fixture();
    await f.reader.refresh("mini");
    f.ask.mockResolvedValueOnce({ error: "unavailable" });
    await f.reader.refresh("mini");
    expect(f.reader.read("mini")).toEqual({ status: "unknown", ...snapshot });
  });
});
