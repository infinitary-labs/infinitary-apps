import { constants } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { phoneDecision } from "../scripts/affected-phone";
import { keepPhoneFailureLogs, runPhoneLog } from "../scripts/phone-failure-logs";
import { hostEnv } from "../src/core/hostEnv";
import { logTime } from "./helpers/phonePhotos";
import { phoneWebContentStartup } from "./helpers/phoneWebContent";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1885: a failed phone part exceeded V8's string ceiling while collecting its
// simulator log. Exercise actual child pipes and saved files, not source matching.
const emitter = resolve("tests/fixtures/phone-failure-logs/emitter.mjs");
const cwd = resolve(".");
const testing = new Date("2026-10-29T23:20:00Z");
const fixture = () => {
  const evidence = scratchDir("phone-failure-logs-");
  const children = new Set<ChildProcess>();
  const reports: string[] = [];
  const calls: { args: string[]; log: string }[] = [];
  let number = 0;
  const options = {
    device: "owned-simulator",
    testing,
    appPredicate: 'process == "Infinitary"',
    systemPredicate: 'process == "SpringBoard"',
    evidence,
    webContent: phoneWebContentStartup(),
    nextLog: () => join(evidence, `${++number}-xcrun.log`),
    report: (message: string) => {
      reports.push(message);
    },
    closeLive: async () => {
      expect(children.size).toBe(0);
      reports.push("live reader joined");
    },
  };
  const run = (log: string, mode = "success", command = process.execPath) =>
    runPhoneLog({
      command,
      args: [emitter, mode, join(evidence, "receipt.json")],
      cwd,
      env: { ...hostEnv(), HOME: evidence, CFFIXED_USER_HOME: evidence },
      children,
      log,
    });
  const keep = async (mode = "success") => {
    await keepPhoneFailureLogs({
      ...options,
      keepLog: async (args, log) => {
        calls.push({ args, log });
        await run(log, calls.length === 1 ? mode : "success");
      },
    });
  };
  return { evidence, children, reports, calls, options, run, keep };
};
const digest = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

describe("failed phone parts keep logs without whole-output strings (INF-1885)", () => {
  it("selects the native gate when its failure-log collector changes", () => {
    expect(phoneDecision(["scripts/phone-failure-logs.ts"]).run).toBe(true);
  });

  // Real work: write, reread and hash over half a GiB; budget follows docs/test-cohorts.md.
  it("retains more than V8's largest string byte for byte and still reads the last witness", {
    timeout: 55_000,
  }, async () => {
    const { evidence, children, reports, keep } = fixture();
    await keep("large");
    const receipt = JSON.parse(readFileSync(join(evidence, "receipt.json"), "utf8"));
    const log = join(evidence, "1-xcrun.log");
    expect(receipt.bytes).toBeGreaterThan(constants.MAX_STRING_LENGTH);
    expect(statSync(log).size).toBe(receipt.bytes);
    expect(await digest(log)).toBe(receipt.sha256);
    expect(children.size).toBe(0);
    expect(reports).toContain("The simulator's system log is in 2-xcrun.log");
    const startup = readFileSync(join(evidence, "webcontent-startup.log"), "utf8");
    expect(startup).toContain("WebKit reported 202.786854 seconds to launch");
    expect(reports.indexOf("live reader joined")).toBeLessThan(reports.indexOf(startup.trimEnd()));
  });

  it("joins an interrupted collector and rejects instead of reporting a saved log", async () => {
    const { evidence, children, run } = fixture();
    const collecting = run(join(evidence, "interrupted.log"));
    const rejected = expect(collecting).rejects.toThrow("failed (null)");
    const [child] = children;
    if (!child) throw new Error("The collector did not track its child");
    child.once("spawn", () => child.kill("SIGTERM"));
    await rejected;
    expect(children.size).toBe(0);
  });

  it("keeps stdout and stderr and preserves the owned device, time range and predicates", async () => {
    const { evidence, calls, options, keep } = fixture();
    await keep();
    for (const [index, predicate] of [options.appPredicate, options.systemPredicate].entries()) {
      expect(calls[index]?.args).toEqual([
        "simctl",
        "spawn",
        options.device,
        "log",
        "show",
        "--start",
        logTime(testing),
        "--style",
        "compact",
        "--info",
        "--predicate",
        predicate,
      ]);
      const log = readFileSync(join(evidence, `${index + 1}-xcrun.log`), "utf8");
      expect(log).toContain("WebContent process (0x1260b00c0) took 202.786854 seconds to launch");
      expect(log).toContain("Filtering the log data using the requested predicate");
    }
  });

  it.each(["exit", "spawn", "writer", "reader", "interrupted"] as const)(
    "reports a %s failure, then collects the system log and finishes the failure snapshot",
    async (fault) => {
      const { evidence, children, options, reports, calls, run } = fixture();
      await keepPhoneFailureLogs({
        ...options,
        keepLog: async (args, log) => {
          calls.push({ args, log });
          if (calls.length !== 1) return run(log);
          if (fault === "interrupted") throw new Error("The native gate was interrupted");
          if (fault === "writer") mkdirSync(log); // Actual evidence-writer open failure.
          await run(
            log,
            fault === "exit" ? "fail" : "success",
            fault === "spawn" ? join(evidence, "missing-xcrun") : process.execPath,
          );
          if (fault === "reader") rmSync(log); // Lost before the witness reader opens it.
        },
      });
      expect(children.size).toBe(0);
      expect(calls).toHaveLength(2);
      expect(reports[0]).toMatch(/The simulator's log (could not be kept or read|is in)/);
      expect(
        reports.some((line) => line.startsWith("The simulator's log could not be kept or read:")),
      ).toBe(true);
      expect(reports).toContain("The simulator's system log is in 2-xcrun.log");
      expect(reports).toContain("live reader joined");
      expect(readFileSync(join(evidence, "webcontent-startup.log"), "utf8")).toContain(
        "startup is unknown",
      );
      if (fault === "exit")
        expect(readFileSync(join(evidence, "1-xcrun.log"), "utf8")).toContain(
          "Domain is tearing down",
        );
    },
  );

  it("joins live evidence and returns even when neither log nor the startup file can be written", async () => {
    const { evidence, options, reports, run } = fixture();
    for (const name of ["1-xcrun.log", "2-xcrun.log", "webcontent-startup.log"])
      mkdirSync(join(evidence, name));
    await keepPhoneFailureLogs({ ...options, keepLog: async (_args, log) => run(log) });
    expect(reports.filter((line) => line.includes("could not be kept or read:"))).toHaveLength(2);
    expect(reports).toContain("live reader joined");
    expect(reports.at(-1)).toMatch(/^WebContent startup evidence could not be kept:/);
  });

  // INF-1936 / INF-2185: the collector, not its caller's wrapper, owns independent diagnostic cleanup.
  it("keeps the startup snapshot after live-reader failure without replacing the native failure", async () => {
    const { evidence, options, reports, run } = fixture();
    const closeTarget = join(evidence, "live-reader.log");
    mkdirSync(closeTarget);
    const failure = new Error("The original xcodebuild test failure");
    const finish = async () => {
      try {
        await keepPhoneFailureLogs({
          ...options,
          keepLog: async (_args, log) => run(log),
          closeLive: async () => {
            writeFileSync(closeTarget, "evidence");
          },
        });
        throw failure;
      } finally {
        reports.push("outer cleanup finished");
      }
    };
    await expect(finish()).rejects.toBe(failure);
    const notice = reports.find((message) =>
      message.startsWith("Simulator log could not be kept:"),
    );
    expect(notice).toContain("Error: EISDIR");
    const startup = readFileSync(join(evidence, "webcontent-startup.log"), "utf8");
    expect(startup).toBe(options.webContent.report() + "\n");
    expect(reports.indexOf(notice!)).toBeLessThan(reports.indexOf(startup.trimEnd()));
    expect(reports.at(-1)).toBe("outer cleanup finished");
  });
});
