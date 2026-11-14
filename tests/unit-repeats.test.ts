import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROBE_FILES } from "../scripts/affected-probes.ts";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import {
  REACH_RUN_FILES,
  REPEATS,
  reachArgs,
  repetitionArgs,
  runLinuxReach,
  runLocalUnits,
  runRepetitions,
  selectLinuxReach,
  selectLocalUnits,
  selectRepeats,
} from "../scripts/unit-repeats.ts";

/** INF-2259 and the captain's subsequent INF-2273 override: ordinary local
 * coverage plus two more runs for every edited unit file, including portable
 * files, without a duplicate PR CI repeat job. */
describe("a change's local unit-file rounds", () => {
  // A changed list shaped like a real pull request's: product code, docs, a
  // journey, a renamed-away test, a Mac-only test and two ordinary tests.
  it("picks every surviving edited Vitest file locally and identifies native prerequisites", () => {
    const macOnly = MAC_UNIT_FILES[0];
    const gone = "tests/removed-in-this-change.test.ts";
    const changed = [
      "src/core/placed/loadLine.ts",
      "src/core/placed/loadLine.test.ts",
      "docs/testing.md",
      "tests/e2e/request-merge.spec.ts",
      "tests/checks-mode.test.ts",
      "src/renderer/src/cards/CardStack.test.tsx",
      gone,
      macOnly,
      "tests/fixtures/accepted-plan/inf64.json",
    ];
    const selection = selectRepeats(changed, (path) => path !== gone);
    expect(selection.repeat).toEqual([
      "src/core/placed/loadLine.test.ts",
      macOnly,
      "src/renderer/src/cards/CardStack.test.tsx",
      "tests/checks-mode.test.ts",
    ]);
    expect(selection.onMac).toEqual([macOnly]);
  });

  // INF-2203, separated from INF-1109: its 37-file workload reached round ten
  // but exceeded the CI deadline. Keep every file, ten fresh rounds and retry 0.
  it.each([undefined, "1/2", "2/2"])(
    "passes every candidate and the chosen shard %s to Vitest without retries",
    (shard) => {
      const files = [
        "src/core/orchestrator/crewSupervisor.test.ts",
        "src/core/placed/placedSessions.test.ts",
      ];
      expect(repetitionArgs(files, shard)).toEqual([
        "exec",
        "vitest",
        "run",
        "--retry",
        "0",
        ...(shard === undefined ? [] : ["--shard", shard]),
        ...files,
      ]);
    },
  );

  it("uses the declared local worker count without adding another round", () => {
    const file = "tests/unit-repeats.test.ts";
    const run = vi.fn((_args: string[]) => 0);
    expect(runRepetitions([file], undefined, run, () => {}, "2")).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [args] of run.mock.calls)
      expect(args).toEqual(["exec", "vitest", "run", "--retry", "0", "--maxWorkers", "2", file]);
    expect(() => repetitionArgs([file], undefined, "0")).toThrow("Invalid worker count");
  });

  it("keeps a one-file change on the first shard without allowing missing tests", () => {
    const files = ["src/core/helper/sessionHost.test.ts"];
    expect(repetitionArgs(files, "1/2")).toEqual(repetitionArgs(files));
    expect(repetitionArgs(files, "2/2")).toBeUndefined();
  });

  it.each(["", "0/2", "3/2", "1/0", "1/2/3"])(
    "refuses the invalid shard %s instead of silently dropping repetitions",
    (shard) => {
      expect(() => repetitionArgs(["tests/unit-repeats.test.ts"], shard)).toThrow(
        "Invalid repetition shard",
      );
    },
  );

  it.each(["1/2", "2/2"])(
    "includes ordinary coverage in three fresh complete rounds for shard %s",
    (shard) => {
      const files = [
        "src/core/orchestrator/crewSupervisor.test.ts",
        "src/core/placed/placedSessions.test.ts",
      ];
      const run = vi.fn((_args: string[]) => 0);
      const report = vi.fn();
      expect(runRepetitions(files, shard, run, report)).toBe(0);
      // INF-2259 accepted override: ordinary run plus two more, not ten.
      expect(run).toHaveBeenCalledTimes(3);
      for (const [args] of run.mock.calls) expect(args).toEqual(repetitionArgs(files, shard));
      expect(report).toHaveBeenLastCalledWith([`All ${REPEATS} rounds passed.`]);
    },
  );

  it.each([1, null])("stops at a failed or interrupted round (%s), never retrying it", (status) => {
    const run = vi
      .fn<(_args: string[]) => number | null>()
      .mockReturnValueOnce(0)
      .mockReturnValue(status);
    const report = vi.fn();
    expect(runRepetitions(["tests/unit-repeats.test.ts"], "1/2", run, report)).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith([
      `Round 2 of ${REPEATS} failed; later rounds did not run.`,
    ]);
  });

  it("invokes nothing for an empty selection or the unused shard of a lone file", () => {
    const run = vi.fn((_args: string[]) => 0);
    const report = vi.fn();
    expect(runRepetitions([], "1/2", run, report)).toBe(0);
    expect(runRepetitions(["tests/unit-repeats.test.ts"], "2/2", run, report)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(["Shard 2/2 owns no selected test files."]);
  });

  it("repeats nothing when the change edits no test file", () => {
    expect(selectRepeats(["docs/testing.md", ".github/workflows/ci.yml"], () => true)).toEqual({
      repeat: [],
      onMac: [],
    });
  });
});

// INF-2394 measure 3 preserves the edited-file rule and adds disjoint once-only proof.
describe("direct-reader local execution", () => {
  const selection = {
    repeat: ["tests/unit-repeats.test.ts"],
    once: ["tests/unit-repeats-workflow.test.ts"],
    onMac: [],
  };

  it("runs direct readers once and edited tests three times with the same worker bound", () => {
    const run = vi.fn((_args: string[]) => 0);
    expect(runLocalUnits(selection, undefined, run, () => {}, "2")).toBe(0);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      repetitionArgs(selection.once, undefined, "2"),
      ...Array.from({ length: REPEATS }, () => repetitionArgs(selection.repeat, undefined, "2")),
    ]);
  });

  it.each([1, null])("stops after a failed or interrupted direct-reader round (%s)", (status) => {
    const run = vi.fn((_args: string[]) => status);
    expect(runLocalUnits(selection, undefined, run, () => {})).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a product-only selection once, retaining Vitest sharding", () => {
    const run = vi.fn((_args: string[]) => 0);
    const once = ["tests/generate-self-source.test.ts", "tests/phone-order.test.ts"];
    expect(runLocalUnits({ repeat: [], once, onMac: [] }, "2/2", run, () => {})).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith(repetitionArgs(once, "2/2"));
  });
});

// INF-2394: native prerequisites still apply to unedited direct importers.
it("identifies native direct readers in the once-only local selection", () => {
  const native = "src/main/host/darwinFreshAuthentication.test.ts";
  const selection = selectLocalUnits(["src/main/host/darwinFreshAuthentication.ts"]);
  expect(selection.once).toContain(native);
  expect(selection.onMac).toContain(native);
  expect(selection.repeat).toEqual([]);
});

// INF-2441, the captain's choice: the pull request's build check runs the
// tests that read each changed file. actions.ts is imported by actions.test.ts.
// INF-2478: the round once listed integration readers and never ran them.
describe("the pull request's direct-reader round", () => {
  const root = resolve(import.meta.dirname, "..");
  const ran = (files: readonly string[]) => ({
    testResults: files.map((file) => ({ name: join(root, file) })),
  });

  it("runs the unedited direct readers of a changed file and leaves a Mac-only one to the local round", () => {
    const { run, elsewhere } = selectLinuxReach([
      "src/shared/actions.ts",
      "src/main/host/darwinFreshAuthentication.ts",
    ]);
    expect(run).toContain("src/shared/actions.test.ts");
    expect(run).not.toContain("src/main/host/darwinFreshAuthentication.test.ts");
    expect(elsewhere).toContainEqual({
      file: "src/main/host/darwinFreshAuthentication.test.ts",
      where: "needs a Mac: the crewmate's local round",
    });
    for (const file of run) expect(MAC_UNIT_FILES).not.toContain(file);
  });

  // INF-2473's break: a ci.yml change broke the Linux gate's workflow test, an
  // integration file the round listed and never ran.
  it("runs an integration reader of a changed workflow", () => {
    const { run } = selectLinuxReach([".github/workflows/ci.yml"]);
    expect(run).toContain("tests/release-workflows-pr-checks.test.ts");
  });

  // A probe can fail with no code change, so main's full check runs every one
  // (docs/test-cohorts.md, "Probes"). The paths are joined so this file does
  // not read them itself.
  it("lists a probe reader apart, with where it runs", () => {
    const { run, elsewhere } = selectLinuxReach([["scripts", "release-notes.ts"].join("/")]);
    expect(elsewhere).toContainEqual({
      file: "tests/release-notes.test.ts",
      where: "a probe: main's full check runs every probe",
    });
    expect(run).not.toContain("tests/release-notes.test.ts");
  });

  // INF-2999: two changes on main edited src/shared/cards.ts and no renderer
  // file, so the browser step skipped and the browser tests that import it,
  // such as card-threads, ran nowhere on the pull request.
  const cards = ["src", "shared", "cards.ts"].join("/");
  const cardThreads = ["tests", "browser", "card-threads.test.tsx"].join("/");

  it("runs the browser readers of a changed shared file when the renderer is untouched", () => {
    const { run, elsewhere } = selectLinuxReach([cards]);
    expect(run).toContain(cardThreads);
    expect(elsewhere.filter(({ file }) => file.startsWith("tests/browser/"))).toEqual([]);
  });

  // The renderer path of a real change (scripts/pr-paths.ts's test): the
  // browser step then runs every browser file, so none runs twice.
  it("lists the browser readers apart when the browser step runs every browser test", () => {
    const renderer = ["src", "renderer", "src", "accounts", "signInFlight.ts"].join("/");
    const { run, elsewhere } = selectLinuxReach([cards, renderer]);
    expect(run.filter((file) => file.startsWith("tests/browser/"))).toEqual([]);
    expect(run).toContain("src/shared/cards.test.ts");
    expect(elsewhere).toContainEqual({
      file: cardThreads,
      where: "a browser test: the browser step runs every browser test for this change",
    });
  });

  // INF-3690's gap 3 (the captain's "Yes: start it now"): PRs #1398, #1455 and
  // #1420 edited tests that passed their local Mac rounds and first failed on
  // Linux in the merge batch, so the pull request runs each edited file once.
  it("runs an edited test file once on Linux, beside its unedited readers", () => {
    // #1420's edited test; the path is joined so this file does not read it.
    const edited = ["tests", "run-temp-root.test.ts"].join("/");
    const { run } = selectLinuxReach([edited, "src/shared/actions.ts"]);
    expect(run).toContain(edited);
    expect(run).toContain("src/shared/actions.test.ts");
    expect(new Set(run).size).toBe(run.length);
  });

  // Linux runs a Mac-listed file's portable cases too (scripts/mac-unit-tests.ts),
  // and #1420's edited run-temp-root test is Mac-listed: an edited one runs here.
  it("runs an edited Mac-listed test on Linux too", () => {
    const mac = "src/main/host/darwinFreshAuthentication.test.ts";
    expect(MAC_UNIT_FILES).toContain(mac);
    expect(selectLinuxReach([mac])).toEqual({ run: [mac], elsewhere: [] });
  });

  it("lists an edited probe or browser test apart, as it does a reader", () => {
    const [probe = ""] = PROBE_FILES;
    const browser = ["tests", "browser", "after-merge-strip.test.tsx"].join("/");
    expect(existsSync(join(root, browser))).toBe(true);
    const { run, elsewhere } = selectLinuxReach([probe, browser]);
    expect(run).not.toContain(probe);
    expect(run).not.toContain(browser);
    expect(elsewhere).toEqual(
      expect.arrayContaining([
        { file: probe, where: "a probe: main's full check runs every probe" },
        {
          file: browser,
          where: "a browser test: the browser step runs every browser test for this change",
        },
      ]),
    );
  });

  it("selects no test file the change deletes", () => {
    const gone = ["src", "shared", "removedByThisChange.test.ts"].join("/");
    expect(selectLinuxReach([gone]).run).not.toContain(gone);
  });

  it("selects nothing for a change no test reads", () => {
    expect(selectLinuxReach([["docs", "unread-page.md"].join("/")])).toEqual({
      run: [],
      elsewhere: [],
    });
  });

  it("runs once in the in-memory, integration and browser cohorts, with no retry and a report of what ran", () => {
    const args = reachArgs(["src/shared/actions.test.ts"], "report.json");
    expect(args).not.toContain("--passWithNoTests");
    expect(args.slice(args.indexOf("--retry"), args.indexOf("--retry") + 2)).toEqual([
      "--retry",
      "0",
    ]);
    expect(args.filter((_, i) => args[i - 1] === "--project")).toEqual([
      "pure",
      "unit",
      "unit-isolated",
      "integration",
      "browser",
    ]);
    expect(args).toContain("--reporter=json");
    expect(args).toContain("--outputFile.json=report.json");
    expect(args.at(-1)).toBe("src/shared/actions.test.ts");
  });

  it("passes when Vitest's report shows every selected reader ran", () => {
    const files = ["src/shared/actions.test.ts", "tests/release-workflows-pr-checks.test.ts"];
    let reportFile = "";
    const run = vi.fn((args: string[], file: string) => {
      reportFile = file;
      expect(args).toEqual(reachArgs(files, file));
      writeFileSync(file, JSON.stringify(ran(files)));
      return 0;
    });
    const report = vi.fn();
    expect(runLinuxReach(files, run, report, root)).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    // The report's folder goes with the round.
    expect(existsSync(dirname(reportFile))).toBe(false);
  });

  it("fails, naming each selected reader Vitest's report does not show", () => {
    const files = ["src/shared/actions.test.ts", "tests/release-workflows-pr-checks.test.ts"];
    const run = vi.fn((_args: string[], file: string) => {
      writeFileSync(file, JSON.stringify(ran(["src/shared/actions.test.ts"])));
      return 0;
    });
    const report = vi.fn();
    expect(runLinuxReach(files, run, report, root)).toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith([
      "These selected test files did not run in pure, unit, unit-isolated, integration, browser:",
      "- `tests/release-workflows-pr-checks.test.ts`",
    ]);
  });

  it("fails when the round wrote no report", () => {
    const report = vi.fn();
    expect(runLinuxReach(["src/shared/actions.test.ts"], () => 0, report, root)).toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith([
      "These selected test files did not run in pure, unit, unit-isolated, integration, browser:",
      "- `src/shared/actions.test.ts`",
    ]);
  });

  it.each([1, null])("returns a failed or interrupted round's status (%s)", (status) => {
    const report = vi.fn();
    expect(runLinuxReach(["src/shared/actions.test.ts"], () => status, report, root)).toBe(
      status ?? 1,
    );
    expect(report).not.toHaveBeenCalled();
  });

  // INF-4163: a branch whose selection reached 454 files ran two unit workers
  // at 3.2 and 2.4 GB on the check's 7.9 GB runner, and a sibling branch's
  // runner stopped answering in this step, since a worker keeps what every
  // file it ran leaves behind until its run ends.
  describe("a selection wider than one run", () => {
    // The project's own test files, as a change that reaches nearly all of them selects them.
    // Listed here rather than through the reach script's own lister: the reach test's real
    // example of a reader that is not direct is this file, which reaches that script only through unit-repeats.
    const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts"))
      .map((path) => join("src", path))
      .toSorted()
      .slice(0, 2 * REACH_RUN_FILES + 1);

    it("runs as the fewest runs of at most REACH_RUN_FILES files, each file in exactly one, one after another", () => {
      const parts: string[][] = [];
      const reports = new Set<string>();
      const run = vi.fn((args: string[], file: string) => {
        const part = args.slice(args.indexOf("browser") + 1);
        expect(args).toEqual(reachArgs(part, file));
        parts.push(part);
        reports.add(file);
        writeFileSync(file, JSON.stringify(ran(part)));
        return 0;
      });
      const report = vi.fn();
      expect(runLinuxReach(files, run, report, root)).toBe(0);
      expect(parts).toHaveLength(3);
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(REACH_RUN_FILES);
      expect(parts.flat()).toEqual(files);
      expect(reports.size).toBe(3);
      expect(report).toHaveBeenCalledExactlyOnceWith([
        `The ${files.length} selected files run as 3 Vitest runs of at most ${REACH_RUN_FILES} files, one after another, each with fresh workers.`,
      ]);
    });

    it("fails, naming a file no run's report shows", () => {
      const [missed = ""] = files.slice(-1);
      const run = (args: string[], file: string) => {
        const part = args.slice(args.indexOf("browser") + 1).filter((path) => path !== missed);
        writeFileSync(file, JSON.stringify(ran(part)));
        return 0;
      };
      const report = vi.fn();
      expect(runLinuxReach(files, run, report, root)).toBe(1);
      expect(report).toHaveBeenLastCalledWith([
        "These selected test files did not run in pure, unit, unit-isolated, integration, browser:",
        `- \`${missed}\``,
      ]);
    });

    it("runs every part after a failed one and returns the failed run's status", () => {
      const run = vi.fn((args: string[], file: string) => {
        writeFileSync(file, JSON.stringify(ran(args.slice(args.indexOf("browser") + 1))));
        return run.mock.calls.length === 1 ? 1 : 0;
      });
      expect(runLinuxReach(files, run, () => {}, root)).toBe(1);
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("ends at an interrupted run", () => {
      const run = vi.fn((_args: string[], _file: string) => null);
      expect(runLinuxReach(files, run, () => {}, root)).toBe(1);
      expect(run).toHaveBeenCalledOnce();
    });
  });

  it("runs nothing for an empty selection", () => {
    const run = vi.fn((_args: string[], _file: string) => 0);
    expect(runLinuxReach([], run, () => {}, root)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
