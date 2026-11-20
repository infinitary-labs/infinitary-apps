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
const fixture = (onLine?: (line: string) => void) => {
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
    onLine,
  });
  return { child, stop, evidence, children, observing };
};

describe("the native gate's pre-failure log", () => {
  it("delivers complete readings immediately for fault-time diagnostics", async () => {
    // INF-1066: the sampler must hear the real timeout before the typing wait ends.
    const onLine = vi.fn();
    const { child, observing } = fixture(onLine);
    child.stdout.write("Filtering the log data using the requested predicate\n");
    const log = await observing;
    onLine.mockClear();
    const reading =
      "2026-10-24 16:41:17.302 F  Infinitary[7496:f94e] [com.apple.UIKit:KeyboardTaskQueue] -[UIKeyboardTaskQueue _lockWhenReadyForMainThread] Keyboard queue task timeout detected";
    child.stdout.write(reading.slice(0, 80));
    expect(onLine).not.toHaveBeenCalled();
    child.stdout.write(`${reading.slice(80)}\n`);
    expect(onLine).toHaveBeenCalledExactlyOnceWith(reading);
    await log.close();
  });

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
