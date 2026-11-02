import { describe, expect, it } from "vitest";
import { ProcessAttribution, processesFromPs, processResources } from "./processResources";
import { ProcessRoots } from "./processRoots";

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

  // INF-2228: a retained zombie PID is not evidence of a living payload launch.
  it("keeps birth identity separate from a recorded exited process state", () => {
    // Disposable fork retained with waitid(WNOWAIT), captured by this Mac's ps.
    const row = processesFromPs("81662 81648 81644 0:00.00 0 Sun Nov 1 19:09:50 2026 Z")?.[0];
    expect(row).toMatchObject({ pid: 81662, started: "Sun Nov 1 19:09:50 2026", exited: true });
    expect(processesFromPs(PS)?.every((process) => process.exited === undefined)).toBe(true);
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

  // INF-1621 piece 2: a declared group is not an everlasting claim on its leader's PID.
  it("attributes a registered group without claiming an unrelated process that reuses its leader PID", () => {
    const rows = processesFromPs(PS) ?? [];
    const [launchd, leader, other] = rows;
    if (!launchd || !leader || !other) throw new Error("The recorded process table is incomplete");
    const roots = new ProcessRoots();
    const release = roots.addGroup(leader.group, "declared", leader.started);
    expect(
      new ProcessAttribution().owners(rows, roots.read(), roots.readGroups()).get(leader.pid),
    ).toBe("declared");
    const reusedInOtherGroup = { ...other, pid: leader.pid };
    expect(
      new ProcessAttribution()
        .owners([reusedInOtherGroup], roots.read(), roots.readGroups())
        .has(leader.pid),
    ).toBe(false);
    const reusedGroup = { ...leader, started: launchd.started };
    expect(
      new ProcessAttribution()
        .owners([reusedGroup], roots.read(), roots.readGroups())
        .has(leader.pid),
    ).toBe(false);
    const nested = roots.add(leader.pid, "nested");
    expect(
      new ProcessAttribution().owners(rows, roots.read(), roots.readGroups()).get(leader.pid),
    ).toBe("nested");
    nested();
    release();
    expect(roots.readGroups().size).toBe(0);
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
