import { describe, expect, it } from "vitest";
import { ProcessAttribution, processesFromPs, processResources } from "./processResources";

// INF-1621 piece 1: metadata fields from this Mac's ps reading, not %CPU or arguments.
const PS = `    1     0     1   2:01.03  23008 Tue Oct 27 11:03:29 2026
  118     1   118   1:17.87  45040 Tue Oct 27 11:03:36 2026
  119     1   119   0:01.46   6320 Tue Oct 27 11:03:36 2026
`;

describe("accepted load plan: explicit task process shares", () => {
  it("reads cumulative time and resident bytes, and refuses a malformed table", () => {
    const rows = processesFromPs(PS);
    expect(rows?.[0]?.cpuMs).toBe(121030);
    expect(rows?.[1]?.residentBytes).toBe(45040 * 1024);
    expect(processesFromPs(`${PS}truncated row`)).toBeNull();
    expect(processesFromPs(PS.replace("2:01.03", "1-02:01:03"))?.[0]?.cpuMs).toBe(
      (86400 + 2 * 3600 + 63) * 1000,
    );
  });

  it("attributes each process once, with explicit nested roots overriding an ancestor", () => {
    const rows = processesFromPs(PS)!;
    const attribution = new ProcessAttribution();
    const owners = attribution.owners(
      rows,
      new Map([
        [1, "outer"],
        [118, "inner"],
      ]),
    );
    const facts = processResources(rows, rows, owners, 250);
    expect(facts.status).toBe("sampled");
    if (facts.status !== "sampled") throw new Error("Expected measured processes");
    expect(facts.tasks.find((task) => task.taskId === "inner")).toEqual({
      taskId: "inner",
      processCount: 1,
      residentBytes: 45040 * 1024,
      cpuCores: 0,
    });
    expect(
      facts.tasks.reduce((sum, task) => sum + task.processCount, facts.other.processCount),
    ).toBe(rows.length);
    expect(
      facts.tasks.reduce((sum, task) => sum + task.residentBytes, facts.other.residentBytes),
    ).toBe(rows.reduce((sum, row) => sum + row.residentBytes, 0));
  });

  it("keeps known orphans but drops ownership on PID reuse and leaves new CPU counters unknown", () => {
    const rows = processesFromPs(PS)!;
    const attribution = new ProcessAttribution();
    attribution.owners(rows, new Map([[1, "task"]]));
    const orphan = rows.slice(1).map((row) => ({ ...row, parent: 0 }));
    expect(attribution.owners(orphan, new Map()).get(118)).toBe("task");
    const reused = orphan.map((row) => ({ ...row, started: "Tue Oct 27 12:03:36 2026" }));
    expect(attribution.owners(reused, new Map()).size).toBe(0);
    const facts = processResources([], rows, new Map([[118, "task"]]), 250);
    if (facts.status !== "sampled") throw new Error("Expected measured processes");
    expect(facts.tasks[0]?.cpuCores).toBeUndefined();
    expect(facts.tasks[0]?.residentBytes).toBe(45040 * 1024);
  });
});
