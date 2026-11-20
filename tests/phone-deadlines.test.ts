import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepPhoneDiagnostic } from "../scripts/phone-checks";
import {
  endPhoneHang,
  PHONE_PART_BUDGET_FLOOR_MS,
  PhoneDeadlinePassed,
  phonePartBudget,
  withinPhoneDeadline,
} from "../scripts/phone-deadlines";
import { runPhoneLog } from "../scripts/phone-failure-logs";
import { PHONE_PART_TIMES, partTimes } from "../scripts/phone-test-plan";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

// INF-5387's plan, piece 1 (the captain: "how can we make them last <30m at max"): a phone check whose screenshot froze
// a simulator waited 3 hours 50 minutes on a test program that could never start again (run 44682920550). The fault
// cannot be made on request, so a stand-in command that never returns, with a child of its own, plays it here.
const STAND_IN = `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("waiting on a frozen simulator");
setInterval(() => {}, 1000);`;
const env = hostEnv();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const childrenOf = (pid: number) =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([own]) => own!);

describe("a frozen simulator's command ends at its deadline", () => {
  it("ends a command that never returns, with its child, keeps what it waited on, and starts it once", async () => {
    const evidence = scratchDir("phone-deadlines-");
    let started = 0;
    let child: ChildProcess | undefined;
    const closed = new Promise<number | null>((resolve, reject) => {
      started++;
      child = spawn(process.execPath, ["-e", STAND_IN], { env, stdio: ["ignore", "pipe", "pipe"] });
      child.once("error", reject);
      child.once("close", resolve);
    });
    const pid = child!.pid!;
    // The stand-in's own child is running before the deadline passes.
    await new Promise<void>((resolve) => child!.stdout!.once("data", () => resolve()));
    const grandchild = childrenOf(pid)[0];
    expect(grandchild).toBeDefined();
    const ended = withinPhoneDeadline("xcodebuild test-without-building", 1_000, closed, () =>
      endPhoneHang({ name: "xcodebuild test-without-building", pid, evidence, env }),
    );
    const error = await ended.catch((problem: unknown) => problem);
    expect(error).toBeInstanceOf(PhoneDeadlinePassed);
    expect((error as Error).message).toMatch(
      /^xcodebuild test-without-building did not finish within its 0\.0-minute deadline, so the check ended it and retried nothing; what it waited on is in hung-xcodebuild-test-without-building-\d+\.txt$/,
    );
    // Ended, both of them, and never started again.
    await closed;
    expect(alive(pid)).toBe(false);
    expect(started).toBe(1);
    const record = readFileSync(
      join(evidence, (error as Error).message.match(/hung-[\w-]+\.txt/)![0]),
      "utf8",
    );
    expect(record).toContain("xcodebuild test-without-building passed its deadline");
    expect(record).toContain(String(pid));
    expect(record).toContain(String(grandchild));
    for (let tries = 0; alive(grandchild!) && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(grandchild!)).toBe(false);
  });

  it("leaves a diagnostic whose close never returns, so the rest of the clean-up runs", async () => {
    const reports: string[] = [];
    const closes: string[] = [];
    await keepPhoneDiagnostic(
      "Simulator log",
      () => new Promise(() => {}),
      (line) => reports.push(line),
      200,
    );
    await keepPhoneDiagnostic(
      "Recording",
      () => closes.push("recording"),
      (line) => reports.push(line),
      200,
    );
    expect(reports).toEqual([
      "Simulator log could not be kept: Error: Simulator log did not finish within its 0.0-minute deadline, so the check ended it and retried nothing; the check went on without it",
    ]);
    expect(closes).toEqual(["recording"]);
  });

  it("ends a simulator log read that never returns and fails it naming the read", async () => {
    const evidence = scratchDir("phone-deadlines-");
    const children = new Set<ChildProcess>();
    await expect(
      runPhoneLog({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: evidence,
        env,
        children,
        log: join(evidence, "1-xcrun.log"),
        budget: 1_000,
      }),
    ).rejects.toThrow(/did not finish within its 0\.0-minute deadline, so the check ended it/);
    expect(children.size).toBe(0);
  });
});

describe("a part's deadline", () => {
  const times = partTimes(readFileSync(join(import.meta.dirname, "..", PHONE_PART_TIMES), "utf8"))!;

  it("is twice the part's recorded time, and at least the floor", () => {
    for (const [part, time] of times)
      expect(phonePartBudget(part, times), part).toBe(
        Math.max(2 * time, PHONE_PART_BUDGET_FLOOR_MS),
      );
  });

  it("counts a part with no recorded time as the median recorded part", () => {
    const sorted = [...times.values()].toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(phonePartBudget("a-new-part", times)).toBe(
      Math.max(2 * median, PHONE_PART_BUDGET_FLOOR_MS),
    );
  });
});
