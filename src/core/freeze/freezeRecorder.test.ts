import { describe, expect, it } from "vitest";
import { knowledgeFreeze } from "../../../tests/fixtures/freeze-triage/incident";
import { renderWake } from "../orchestrator/wakes";
import {
  type FreezeLine,
  freezeIncidentSchema,
  freezeWake,
  infinitaryProject,
  StallCounter,
} from "./freezeRecorder";
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
  it("is the captain's project that lives at Infinitary's own source", () => {
    const own = project("infinitary", "https://github.com/infinitary-labs/infinitary");
    expect(infinitaryProject([project("meter", "https://github.com/acme/meter"), own])).toBe(own);
    const ssh = project("inf", "git@github.com:Infinitary-Labs/infinitary.git");
    expect(infinitaryProject([ssh])).toBe(ssh);
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

describe("the first mate's wake about a recorded freeze", () => {
  const own = { id: "infinitary", name: "infinitary" };

  it("names the freeze, its call path and the project, and offers a fix task on the captain's choice", () => {
    const text = renderWake(freezeWake(OPEN_MESSAGES, own, "0.6.2-alpha.44"));
    expect(text).toContain("1020 ms");
    expect(text).toContain("986 ms of that was the main thread's own processor time");
    expect(text).toContain(
      "taskIdsWithRef (index.js:48213:22) <- askActedOn (index.js:51877:15) <- renderOpenAsks (index.js:52004:9)",
    );
    expect(text).toContain('project "infinitary" (repo_id infinitary)');
    expect(text).toContain("offer a fix task in that project on a decision card");
    expect(text).not.toContain("uncertain");
  });

  it("reports interruption without invented duration, CPU time or names (INF-2205)", () => {
    const text = renderWake(
      freezeWake(
        {
          incidentId: "interrupted-stall",
          status: "interrupted",
          at: OPEN_MESSAGES.at,
          interruptedAt: "2026-10-31T07:14:04.512Z",
        },
        own,
        "0.6.2-alpha.44",
      ),
    );
    expect(text).toContain("unknown duration (recording was interrupted)");
    expect(text).toContain("processor time is unknown");
    expect(text).toContain("captured no JavaScript frames");
  });

  it("says when a wait's names are uncertain", () => {
    const wait = { ...OPEN_MESSAGES, cpuMs: 5, uncertain: "waited" as const };
    expect(renderWake(freezeWake(wait, own, "0.6.2-alpha.44"))).toContain(
      "These names are uncertain",
    );
  });

  // INF-2262: a busy interval does not time the short JavaScript in its stack.
  it("reports the retained misleading high-CPU location without assigning its duration to the lookup", () => {
    const text = renderWake(freezeWake(knowledgeFreeze, own, "0.6.2-alpha.47"));
    expect(text).toContain(`${knowledgeFreeze.wallMs} ms`);
    expect(text).toContain(
      `${knowledgeFreeze.cpuMs} ms of that was the main thread's own processor time`,
    );
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

  it("preserves request/capture readings for late capture and reports unavailable frames honestly", () => {
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
    const wake = freezeWake(line, own, "0.6.2-alpha.47");
    expect(wake.facts).toMatchObject({
      incidentId: line.incidentId,
      status: line.status,
      build,
      captureRequestedAt,
      capturedAt,
    });
    const text = renderWake(wake);
    expect(text).toContain(`Capture requested: ${captureRequestedAt}; captured: ${capturedAt}`);
    expect(text).toContain("read only after the stall had ended");
    expect(text).toContain(JSON.stringify(build));
    expect(text).toContain(`Incident: ${line.incidentId}; status: ${line.status}`);
    const interrupted = freezeIncidentSchema.parse({
      ...line,
      status: "interrupted",
      wallMs: undefined,
      cpuMs: undefined,
    });
    const recovered = freezeWake(interrupted, own, "0.6.2-alpha.47");
    expect(recovered.facts).toMatchObject({
      incidentId: line.incidentId,
      status: "interrupted",
      build,
      captureRequestedAt,
      capturedAt,
      frames: [],
      wallMs: null,
      cpuMs: null,
    });
    const missing = renderWake(
      freezeWake({ ...OPEN_MESSAGES, frames: [], captureRequestedAt }, own, "0.6.2-alpha.47"),
    );
    expect(missing).toContain("captured no JavaScript frames; the cause remains unknown");
    expect(missing).toContain("captured: not recorded");
  });

  it("uses the approved INF-2205 version-wide identity across different call paths", () => {
    const again = freezeWake(
      { ...OPEN_MESSAGES, at: "2026-10-31T07:13:04.512Z", wallMs: 1_400 },
      own,
      "0.6.2-alpha.44",
    );
    expect(again.once).toBe(freezeWake(OPEN_MESSAGES, own, "0.6.2-alpha.44").once);
    const other = freezeWake(
      { ...OPEN_MESSAGES, frames: [{ name: "hashFile", file: "index.js", line: 9, column: 3 }] },
      own,
      "0.6.2-alpha.44",
    );
    expect(other.once).toBe(freezeWake(OPEN_MESSAGES, own, "0.6.2-alpha.44").once);
    expect(other.once).not.toBe(freezeWake(OPEN_MESSAGES, own, "0.6.2-alpha.45").once);
  });
});

// INF-2971's first finding, which the captain chose to start: the wake came
// with the first stall of each start, one stall each time, and the first
// mate judged each too short to look into while the app stopped about
// three times a minute. The summary now carries this run's stalls.
describe("the stalls a run has had", () => {
  const own = { id: "infinitary", name: "infinitary" };
  const since = "2026-11-07T08:18:00.000Z";
  const stall = (at: string, wallMs: number): FreezeLine => ({ ...OPEN_MESSAGES, at, wallMs });

  it("counts every completed stall and names the longest as the example", () => {
    const counter = new StallCounter(since);
    expect(counter.read("2026-11-07T08:19:00.000Z")).toBeUndefined();
    counter.add(stall("2026-11-07T08:18:22.000Z", 386));
    counter.add(stall("2026-11-07T08:20:01.000Z", 159));
    counter.add(stall("2026-11-07T08:21:40.000Z", 1_020));
    counter.add(stall("2026-11-07T08:22:13.000Z", 212));
    const tally = counter.read("2026-11-07T08:23:00.000Z");
    expect(tally).toMatchObject({
      since,
      until: "2026-11-07T08:23:00.000Z",
      stalls: 4,
      stallMs: 386 + 159 + 1_020 + 212,
      interrupted: 0,
      example: { at: "2026-11-07T08:21:40.000Z", wallMs: 1_020 },
    });
  });

  it("tells the first mate the rate since the app started, with the longest stall's facts", () => {
    const counter = new StallCounter(since);
    for (let minute = 0; minute < 15; minute += 1)
      counter.add(stall(new Date(Date.parse(since) + minute * 20_000).toISOString(), 159));
    counter.add(stall("2026-11-07T08:21:40.000Z", 1_020));
    const tally = counter.read("2026-11-07T08:23:00.000Z");
    if (!tally) throw new Error("the counter read no stall");
    const { example, ...rate } = tally;
    const wake = freezeWake(example, own, "0.6.3-alpha.280", rate);
    expect(wake.once).toBe(freezeWake(OPEN_MESSAGES, own, "0.6.3-alpha.280").once);
    const text = renderWake(wake);
    expect(text).toContain(
      "since this app started at 2026-11-07T08:18:00.000Z, the freeze recorder saw its main thread",
    );
    expect(text).toContain(
      `stop answering 16 times in 5 minutes (about 3.2 a minute), ${15 * 159 + 1_020} ms in all`,
    );
    expect(text).toContain("The longest stopped it for 1020 ms at 2026-11-07T08:21:40.000Z");
    expect(text).toContain("986 ms of that was the main thread's own processor time");
  });

  it("counts a stall that never finished without inventing its duration", () => {
    const counter = new StallCounter(since);
    counter.add({
      incidentId: "previous-run",
      status: "interrupted",
      at: "2026-11-07T08:10:00.000Z",
      interruptedAt: "2026-11-07T08:18:01.000Z",
    });
    const tally = counter.read("2026-11-07T08:23:00.000Z");
    if (!tally) throw new Error("the counter read no stall");
    expect(tally).toMatchObject({ stalls: 0, stallMs: 0, interrupted: 1 });
    const { example, ...rate } = tally;
    const text = renderWake(freezeWake(example, own, "0.6.3-alpha.280", rate));
    expect(text).toContain("stop answering 0 times in 5 minutes");
    expect(text).toContain("found 1 that never finished, a previous run's included");
    expect(text).toContain(
      "The example is one that never finished, which began at 2026-11-07T08:10:00.000Z",
    );
    expect(text).toContain("its processor time is unknown");
  });
});
