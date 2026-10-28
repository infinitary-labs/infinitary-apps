import { join } from "node:path";
import type { ResourceObservation } from "@shared/resources";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { LoadLine } from "./loadLine";
import { type ProcessReading, processesFromPs } from "./processResources";

// INF-1685 accepted direction A: the plan's worked 14-core case and its busy
// lone-run rule. Identities are recorded Mac metadata from processResources.test.ts.
// The line owns admission; exercise its public claims and observed process windows,
// including two runs belonging to one task, rather than substituting task totals.
const identities =
  processesFromPs(`  118 1 118 1:17.87 45040 Tue Oct 27 11:03:36 2026
  119 1 119 0:01.46 6320 Tue Oct 27 11:03:36 2026
`) ?? [];
const reading: Extract<ResourceObservation, { status: "sampled" }> = {
  epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
  sequence: 1,
  status: "sampled",
  sampleMs: 2000,
  cpu: { logicalCpus: 14, idleFraction: 0 },
  memory: {
    totalBytes: 24 * 1024 ** 3,
    freeBytes: 16 * 1024 ** 3,
    availableBytes: 16 * 1024 ** 3,
    memoryPressure: "normal",
  },
};
const lines: LoadLine[] = [];
afterEach(() => {
  for (const line of lines.splice(0)) line.dispose();
});
function rowAt(rows: ProcessReading[], index: number): ProcessReading {
  const row = rows[index];
  if (!row) throw new Error("The recorded process identity is missing");
  return row;
}
function addWork(rows: ProcessReading[], cores: number, elapsedMs: number) {
  const row = rowAt(rows, 0);
  if (row.cpuMs === undefined) throw new Error("The recorded CPU counter is missing");
  rows[0] = { ...row, cpuMs: row.cpuMs + cores * elapsedMs };
}
function setup() {
  const rows: ProcessReading[] = identities.map((row) => ({ ...row }));
  const line = new LoadLine({
    stateFile: join(scratchDir("cpu-line-"), "holds.json"),
    now: () => 0,
    processes: async () => rows,
    groupExists: () => true,
  });
  lines.push(line);
  const claim = (index: number, cpu = 4) =>
    line
      .forTask("same-task")
      .claim({ pid: rowAt(rows, index).pid, demand: { cpu, memoryBytes: 1024 ** 3 } });
  return { line, rows, claim };
}

describe("accepted counted-once admission", () => {
  it("starts a lone run at zero idle but still requires fresh memory and normal pressure", async () => {
    const { line, claim } = setup();
    expect((await claim(0)).state).toBe("waiting");
    line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
    expect(line.snapshot().runs[0]?.reason).toBe("pressure");
    line.observe({ ...reading, memory: { ...reading.memory, availableBytes: 0 } }, null);
    expect(line.snapshot().runs[0]?.state).toBe("waiting");
    line.observe(reading, null);
    expect(line.snapshot().runs[0]?.state).toBe("running");
    expect((await claim(1)).state).toBe("waiting");
    console.info("Lone-run proof", JSON.stringify(line.snapshot()));
  });

  it("admits the second run in the worked case, then leaves a third waiting", async () => {
    const { line, rows, claim } = setup();
    line.observe(reading, null);
    await claim(0);
    const window = { first: rows.map((row) => ({ ...row })), elapsedMs: 2000 };
    addWork(rows, 4, window.elapsedMs);
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } }, rows, 0, window);
    expect((await claim(1)).state).toBe("running");
    const both = { first: rows.map((row) => ({ ...row })), elapsedMs: 2000 };
    for (const row of rows) row.cpuMs = (row.cpuMs ?? 0) + 4 * both.elapsedMs;
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 5.5 / 14 } }, rows, 0, both);
    // Add a new process identity by reusing the recorded launchd row from the same capture.
    rows.push(rowAt(processesFromPs("1 0 1 2:01.03 23008 Tue Oct 27 11:03:29 2026") ?? [], 0));
    expect((await claim(2)).state).toBe("waiting");
    console.info("Counted-once proof", JSON.stringify(line.snapshot()));
  });

  it("uses the larger measured share and never restores unknown process use", async () => {
    const { line, rows, claim } = setup();
    line.observe(reading, null);
    await claim(0);
    const window = { first: rows.map((row) => ({ ...row })), elapsedMs: 2000 };
    addWork(rows, 8, window.elapsedMs);
    // 80% of (6 + 8), minus 8 = 3.2: a second four-core run must wait.
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 6 / 14 } }, rows, 0, window);
    expect((await claim(1)).state).toBe("waiting");
    // No measured window: reserve the declaration without inventing an add-back.
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 9.5 / 14 } }, rows);
    expect(line.snapshot().runs[1]?.state).toBe("waiting");
    console.info("Unknown and over-declaration proof", JSON.stringify(line.snapshot()));
  });
});
