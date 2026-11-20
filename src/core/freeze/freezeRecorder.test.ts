import { join } from "node:path";
import { describe, expect, it } from "vitest";
import releaseConfig from "../../../packaging/release-source.json" with { type: "json" };
import { knowledgeFreeze } from "../../../tests/fixtures/freeze-triage/incident";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderWake } from "../orchestrator/wakes";
import {
  type FreezeIncident,
  type FreezeLine,
  freezeIncidentSchema,
  freezeWake,
  infinitaryProject,
} from "./freezeRecorder";
import { FreezeTally, type VersionSummary } from "./freezeTally";
import { isFreezeRecorderEnabled } from "./watchdog";

// INF-2066: the captain's answer on INF-2061's first mate question, "activate
// it only in alpha builds, and offer a fix task only if the canonical
// infinitary github repo is a project in the project list".

/** INF-2059's freeze as the recorder names it (INF-2061's lab reading). */
const OPEN_MESSAGES: FreezeLine = {
  at: "2026-10-31T07:12:04.512Z",
  wallMs: 1_020,
  cpuMs: 986,
  frames: [
    { name: "taskIdsWithRef", file: "index.js", line: 48213, column: 22 },
    { name: "askActedOn", file: "index.js", line: 51877, column: 15 },
    { name: "renderOpenAsks", file: "index.js", line: 52004, column: 9 },
  ],
};

const project = (id: string, origin: string | null) => ({ id, name: id, origin });

describe("whether a build runs the freeze recorder", () => {
  const env = {};
  it("runs in an alpha build", () => {
    expect(isFreezeRecorderEnabled({ packaged: true, version: "0.6.2-alpha.44", env })).toBe(true);
  });

  it("stays off in a stable build and an unpackaged run", () => {
    expect(isFreezeRecorderEnabled({ packaged: true, version: "0.6.1", env })).toBe(false);
    expect(isFreezeRecorderEnabled({ packaged: false, version: "0.6.2-alpha.44", env })).toBe(
      false,
    );
  });

  it("runs where the run turns it on, for a journey that reads the record", () => {
    expect(
      isFreezeRecorderEnabled({
        packaged: false,
        version: "0.1.30",
        env: { INFINITARY_FREEZE_RECORDER: "1" },
      }),
    ).toBe(true);
  });
});

describe("the project a freeze's fix goes to", () => {
  it("defaults to the release build's active source", () => {
    const own = project("infinitary", `https://github.com/${releaseConfig.repository}`);
    expect(infinitaryProject([project("meter", "https://github.com/acme/meter"), own])).toBe(own);
  });

  it.each([
    ["infinitary", "infinitary-apps"],
    ["infinitary-apps", "infinitary"],
  ])("matches %s over %s when it is the active release source", (active, inactive) => {
    const other = project("other", `https://github.com/infinitary-labs/${inactive}`);
    const own = project("inf", `git@github.com:Infinitary-Labs/${active}.git`);
    const repository = `infinitary-labs/${active}`;
    expect(infinitaryProject([other, own], repository)).toBe(own);
    expect(infinitaryProject([other], repository)).toBeUndefined();
  });

  it("is none when no project lives there, such as a fork or a project kept on this Mac", () => {
    expect(
      infinitaryProject([
        project("fork", "https://github.com/someone/infinitary"),
        project("local", null),
        project("tap", "https://github.com/infinitary-labs/homebrew-tap"),
      ]),
    ).toBeUndefined();
  });
});

describe("the first mate's wake about a version's freezes", () => {
  const own = { id: "infinitary", name: "infinitary" };
  const VERSION = "0.6.2-alpha.44";

  /** A version's summary from the tally, as the next version's first start takes it (INF-3044). */
  function summaryOf(lines: FreezeIncident[], version = VERSION): VersionSummary {
    const path = join(scratchDir("infinitary-freeze-wake-"), "freeze-tally.json");
    const old = new FreezeTally(path, version);
    old.startRun();
    old.ran(10 * 60_000);
    for (const line of lines) old.add(line);
    old.flush();
    const [summary] = new FreezeTally(path, `${version}-next`).takeEarlier();
    if (!summary) throw new Error("the tally summarized nothing");
    return summary;
  }

  it("names every location with its counts, the project, and offers a fix task on the captain's choice", () => {
    const shorter = {
      ...OPEN_MESSAGES,
      wallMs: 120,
      cpuMs: 110,
      frames: [{ name: "hashFile", file: "index.js", line: 9, column: 3 }],
    };
    const text = renderWake(freezeWake(summaryOf([shorter, OPEN_MESSAGES, shorter]), own));
    expect(text).toContain(`the app has started on a version after ${VERSION}`);
    expect(text).toContain("over 1 runs of it on this computer and 10 minutes awake");
    expect(text).toContain("stop answering 3 times (about 0.3 a minute awake), 1260 ms in all");
    expect(text).toContain(
      "1. 1 stalls, 1020 ms in all, 986 ms processor time, longest 1020 ms, first 2026-10-31T07:12:04.512Z, last 2026-10-31T07:12:04.512Z: taskIdsWithRef (index.js:48213:22) <- askActedOn (index.js:51877:15) <- renderOpenAsks (index.js:52004:9)",
    );
    expect(text).toContain("2. 2 stalls, 240 ms in all, 220 ms processor time, longest 120 ms");
    expect(text).toContain("The longest stopped it for 1020 ms at 2026-10-31T07:12:04.512Z");
    expect(text).toContain('project "infinitary" (repo_id infinitary)');
    expect(text).toContain("offer a fix task in that project on a decision card");
    expect(text).not.toContain("marked waited");
  });

  it("reports interruption without invented duration, CPU time or names (INF-2205)", () => {
    const text = renderWake(
      freezeWake(
        summaryOf([
          {
            incidentId: "interrupted-stall",
            status: "interrupted",
            at: OPEN_MESSAGES.at,
            interruptedAt: "2026-10-31T07:14:04.512Z",
          },
        ]),
        own,
      ),
    );
    expect(text).toContain("stop answering 0 times");
    expect(text).toContain(
      "found 1 that never finished, whose duration, processor time and location are unknown",
    );
    expect(text).toContain("no location is known");
    expect(text).toContain(
      "None finished; the newest that never finished began at 2026-10-31T07:12:04.512Z",
    );
  });

  it("says how many of a location's stalls had uncertain names", () => {
    const wait = { ...OPEN_MESSAGES, cpuMs: 5, uncertain: "waited" as const };
    const text = renderWake(freezeWake(summaryOf([wait, OPEN_MESSAGES]), own));
    expect(text).toContain("1 marked waited");
    expect(text).toContain("likely waiting outside JavaScript");
  });

  // INF-2262: a busy interval does not time the short JavaScript in its stack.
  it("reports the retained misleading high-CPU location without assigning its duration to the lookup", () => {
    const text = renderWake(freezeWake(summaryOf([knowledgeFreeze]), own));
    expect(text).toContain(`${knowledgeFreeze.wallMs} ms in all`);
    expect(text).toContain(`${knowledgeFreeze.cpuMs} ms processor time`);
    expect(text).toContain(
      knowledgeFreeze.frames
        .map((frame) => `${frame.name} (${frame.file}:${frame.line}:${frame.column})`)
        .join(" <- "),
    );
    expect(text).toContain("not a cause or per-function timing");
    expect(text).toContain("even high processor use");
    expect(text).toContain("first work is diagnosis, not a targeted repair");
    expect(text).toContain("causal before/after evidence");
    expect(text).toContain("captured: not recorded");
    expect(text).toContain("Treat any cause as a hypothesis until measured");
    expect(text).toContain("comparable workload and instrumentation");
    expect(text).toContain("report it as unknown rather than substituting another hypothesis");
    console.info("Retained incident triage replay:", text);
  });

  it("preserves the longest stall's request/capture readings and build identity", () => {
    const captureRequestedAt = "2026-10-31T07:12:04.600Z";
    const capturedAt = "2026-10-31T07:12:05.600Z";
    const build = {
      computer: "recording computer",
      version: "0.6.2-alpha.47",
      commit: "c1e941529438207bf1cca34c437df3c2e9d80477",
      mutable: false,
    };
    const line = freezeIncidentSchema.parse({
      ...OPEN_MESSAGES,
      incidentId: "retained-late-capture",
      status: "completed",
      build,
      captureRequestedAt,
      capturedAt,
      uncertain: "late",
    });
    const wake = freezeWake(summaryOf([line], "0.6.2-alpha.47"), own);
    expect(wake.facts).toMatchObject({
      summary: { build, example: { incidentId: line.incidentId, captureRequestedAt, capturedAt } },
    });
    const text = renderWake(wake);
    expect(text).toContain(
      `capture requested: ${captureRequestedAt}; captured: ${capturedAt}; incident: ${line.incidentId}; status: completed`,
    );
    expect(text).toContain("1 marked late");
    expect(text).toContain(JSON.stringify(build));
    const missing = renderWake(
      freezeWake(summaryOf([{ ...OPEN_MESSAGES, frames: [], captureRequestedAt }]), own),
    );
    expect(missing).toContain("no JavaScript frames captured");
    expect(missing).toContain("captured: not recorded");
  });

  it("uses the approved INF-2205 version-wide identity across different call paths", () => {
    const one = freezeWake(summaryOf([OPEN_MESSAGES]), own);
    const other = freezeWake(
      summaryOf([
        { ...OPEN_MESSAGES, frames: [{ name: "hashFile", file: "index.js", line: 9, column: 3 }] },
      ]),
      own,
    );
    expect(other.once).toBe(one.once);
    expect(freezeWake(summaryOf([OPEN_MESSAGES], "0.6.2-alpha.45"), own).once).not.toBe(one.once);
  });
});
