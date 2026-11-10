import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  finishPhoneCheck,
  joinPhoneObserver,
  keepPhoneDiagnostic,
  runEveryCheck,
} from "../scripts/phone-checks";
import { phoneRecording } from "../scripts/phone-recording";
import { scratchDir } from "./helpers/scratchDirs";

// INF-663 (captain: "will that discover all the test failures across all journeys, or will it
// only discover the first one that failed?"): a failed check before the simulator tests no
// longer hides the checks after it. The messages are the native gate's own, from scripts/test-phone.ts.
const failed = (command: string, log: string) => async () => {
  throw new Error(`${command} failed (1); see ${log}`);
};

// INF-1936 / INF-2176 observer-close-replaces-result: the native outcome and output
// survive an evidence writer's real EISDIR, and later diagnostics still finish.
// Native result fixture: run 41118788839's retained testCards failure.
describe("diagnostic failures preserve the native result", () => {
  it.each(["passed", "failed"])("keeps a %s native result and its output", async (outcome) => {
    const path = join(scratchDir("phone-diagnostic-close-"), "worker.log");
    mkdirSync(path);
    const nativeOutput =
      outcome === "failed"
        ? "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' failed (353.667 seconds).\n"
        : "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' passed (679.147 seconds).\n";
    const nativeError = Object.assign(new Error("xcodebuild failed (65)"), {
      output: nativeOutput,
    });
    const notices: string[] = [];
    const finished: string[] = [];
    let output = "";
    let result: unknown;
    // INF-2176: mirror the runner's required-output boundary, not its superseded diagnostic wrapper.
    await finishPhoneCheck(
      (outcome === "failed" ? Promise.reject(nativeError) : Promise.resolve(nativeOutput)).then(
        (log) => {
          output = log;
        },
        (error: Error & { output?: string }) => {
          output = error.output ?? "";
          throw error;
        },
      ),
      async () => {
        await keepPhoneDiagnostic(
          "Guest observer",
          async () => writeFileSync(path, "evidence"),
          (message) => notices.push(message),
        );
        await keepPhoneDiagnostic("Recording", () => {
          finished.push("recording");
        });
        finished.push("demo");
      },
    )
      .catch((error: Error) => {
        result = error;
      })
      .finally(() =>
        keepPhoneDiagnostic(
          "Final observer cleanup",
          () => writeFileSync(path, "evidence"),
          (message) => notices.push(message),
        ),
      );
    expect(result).toBe(outcome === "failed" ? nativeError : undefined);
    expect(output).toBe(nativeOutput);
    expect(finished).toEqual(["recording", "demo"]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("Guest observer could not be kept: Error: EISDIR");
    expect(notices[1]).toContain("Final observer cleanup could not be kept: Error: EISDIR");
  });

  it("joins a pending diagnostic before continuing", async () => {
    let finish!: () => void;
    let joined = false;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = keepPhoneDiagnostic("Guest observer", () => pending).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish();
    await work;
    expect(joined).toBe(true);
  });
});

// INF-2176 demo-failure-swallowed: a requested recording is a deliverable, while
// its failure cannot replace an earlier native failure. Exercise an actual missing raw file.
describe("required phone check finalization", () => {
  it.each(["passed", "failed"])(
    "keeps error precedence after a %s native result",
    async (outcome) => {
      const root = scratchDir("phone-required-recording-");
      const raw = join(root, "conversation.mp4");
      const nativeOutput =
        "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' passed (679.147 seconds).\n";
      const nativeError = Object.assign(new Error("xcodebuild failed (65)"), {
        output:
          "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' failed (353.667 seconds).\n",
      });
      const report = vi.spyOn(console, "log").mockImplementation(() => {});
      const recording = phoneRecording("raw", async () => {
        throw new Error("Raw recording needs no encoder");
      });
      try {
        const result = finishPhoneCheck(
          outcome === "failed" ? Promise.reject(nativeError) : Promise.resolve(nativeOutput),
          () => recording.finish([{ name: "conversation", raw }], root),
        );
        if (outcome === "failed") {
          await expect(result).rejects.toBe(nativeError);
          expect(report).toHaveBeenCalledWith(
            expect.stringContaining("Phone check finalization could not be kept: Error: ENOENT"),
          );
        } else {
          await expect(result).rejects.toMatchObject({ code: "ENOENT", path: raw });
          expect(report).not.toHaveBeenCalled();
        }
      } finally {
        report.mockRestore();
      }
    },
  );

  it("returns the native result only after required finalization completes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const nativeOutput =
      "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' passed (679.147 seconds).\n";
    let completed = false;
    const result = finishPhoneCheck(Promise.resolve(nativeOutput), () => pending).then((output) => {
      completed = true;
      return output;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await expect(result).resolves.toBe(nativeOutput);
    expect(completed).toBe(true);
  });
});

describe("the native gate's checks before its simulator tests", () => {
  it("runs every check after a failed one and reports each failure", async () => {
    const ran: string[] = [];
    const passed = (name: string) => async () => {
      ran.push(name);
    };
    const failures = await runEveryCheck(
      [
        failed("node", "/tmp/phone/iphone/1-node.log"),
        passed("theme"),
        passed("cards"),
        failed("swift", "/tmp/phone/iphone/4-swift.log"),
      ],
      () => false,
    );
    expect(ran).toEqual(["theme", "cards"]);
    expect(failures).toEqual([
      "node failed (1); see /tmp/phone/iphone/1-node.log",
      "swift failed (1); see /tmp/phone/iphone/4-swift.log",
    ]);
  });
  it("stops at once when the gate is interrupted", async () => {
    let after = false;
    await expect(
      runEveryCheck(
        [
          async () => {
            throw new Error("The native gate was interrupted");
          },
          async () => {
            after = true;
          },
        ],
        () => true,
      ),
    ).rejects.toThrow("The native gate was interrupted");
    expect(after).toBe(false);
  });
});

// INF-3042: an observer can fail before stop joins it, without escaping cleanup.
it("observes an early observer failure and still throws it at the required join", async () => {
  const folder = scratchDir("phone-observer-failure-");
  const joinObserver = joinPhoneObserver(
    Promise.resolve().then(() => writeFileSync(folder, "observer log")),
  );
  // Let Node finish the rejection turn before stop, as a running phone test does.
  await new Promise<void>((resolve) => setImmediate(resolve));
  let cleaned = false;
  await expect(
    finishPhoneCheck(Promise.resolve(), async () => {
      try {
        await joinObserver();
      } finally {
        cleaned = true;
      }
    }),
  ).rejects.toMatchObject({ code: "EISDIR", path: folder });
  expect(cleaned).toBe(true);
});
