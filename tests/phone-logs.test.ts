import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observePhoneLog } from "./helpers/phoneLogs";
import { scratchDir } from "./helpers/scratchDirs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// INF-1122: actual failing phone runs could not start log show after XCTest tore
// the simulator's domain down. A live stream must retain its earlier readings.
const fixture = () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const stop = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 124);
  };
  child.kill.mockImplementation(() => {
    stop();
    return true;
  });
  spawn.mockReturnValue(child);
  const evidence = scratchDir("phone-log-stream-");
  const children = new Set<ChildProcess>();
  const observing = observePhoneLog({
    device: "owned-simulator",
    env: {},
    evidence,
    children,
    predicate: 'process == "Infinitary"',
  });
  return { child, stop, evidence, children, observing };
};

describe("the native gate's pre-failure log", () => {
  it("keeps the earlier app reading when the simulator domain tears down", async () => {
    const { child, stop, evidence, children, observing } = fixture();
    child.stdout.write('Filtering the log data using "process == \\"Infinitary\\""\n');
    const log = await observing;
    child.stdout.write("Infinitary: card's choice reached its host\n");
    child.stderr.write("Domain is tearing down\n");
    stop();
    await log.close();
    expect(readFileSync(join(evidence, "simulator-live.log"), "utf8")).toContain(
      "card's choice reached its host",
    );
    expect(readFileSync(join(evidence, "simulator-live.log"), "utf8")).toContain(
      "Domain is tearing down",
    );
    expect(children.size).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("joins its stream and evidence writer before successful simulator cleanup", async () => {
    const { child, evidence, children, observing } = fixture();
    child.stdout.write("Filtering the log data using the requested predicate\n");
    const log = await observing;
    child.stdout.write("Infinitary: last native reading\n");
    await log.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(children.size).toBe(0);
    expect(readFileSync(join(evidence, "simulator-live.log"), "utf8")).toContain(
      "last native reading",
    );
  });

  it("fails startup and still keeps the reason the stream could not enter its domain", async () => {
    const { child, stop, evidence, observing } = fixture();
    const failed = expect(observing).rejects.toThrow("The simulator log stopped before it started");
    child.stderr.write("Domain is tearing down\n");
    stop();
    await failed;
    expect(readFileSync(join(evidence, "simulator-live.log"), "utf8")).toContain(
      "Domain is tearing down",
    );
  });

  it("terminates a stream that never reports startup rather than hanging the gate", async () => {
    vi.useFakeTimers();
    const { child, children, observing } = fixture();
    const failed = expect(observing).rejects.toThrow("The simulator log did not start");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(children.size).toBe(0);
  });
});
