import { describe, expect, it } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import { flush, harness } from "../../../tests/helpers/taskBrowserStandIn";
import type { AnswerReading } from "./pageAnswers";
import type { PageStart, StartOutcome } from "./pageStarts";
import type { TaskBrowsersOptions } from "./taskBrowsers";

/**
 * A page's saved start (docs/task-browser.md, "Starting a page again"):
 * the crewmate's `open --start` keeps it, and the host runs it when nothing
 * answers at the page the captain waits at, waking the crewmate only when
 * it fails. The start's own process is `PageStarts`'s
 * (pageStarts.integration.test.ts); here it is a stand-in whose outcome
 * each test settles.
 */

type StartsStandIn = NonNullable<TaskBrowsersOptions["starts"]> & {
  saved: Map<string, PageStart>;
  runs: {
    taskId: string;
    start: PageStart;
    outcome: Promise<StartOutcome>;
    settle: (outcome: StartOutcome) => void;
  }[];
  calls: string[];
};

function startsStandIn(): StartsStandIn {
  const saved = new Map<string, PageStart>();
  const waiting = new Set<string>();
  const runs: StartsStandIn["runs"] = [];
  const calls: string[] = [];
  return {
    saved,
    runs,
    calls,
    keep: (taskId, start) => {
      saved.set(taskId, start);
    },
    kept: (taskId, origin) => {
      const start = saved.get(taskId);
      return start?.origin === origin ? start : undefined;
    },
    starting: (taskId) => waiting.has(taskId),
    run: (taskId, start) => {
      // A start still waiting is shared, as PageStarts shares it.
      const current = runs.findLast((run) => run.taskId === taskId);
      if (current && waiting.has(taskId)) return current.outcome;
      waiting.add(taskId);
      const outcome = deferred<StartOutcome>();
      runs.push({
        taskId,
        start,
        outcome: outcome.promise,
        settle: (settled) => {
          waiting.delete(taskId);
          outcome.resolve(settled);
        },
      });
      return outcome.promise;
    },
    stopWithBrowser: (taskId) => {
      waiting.delete(taskId);
      calls.push(`stop ${taskId}`);
    },
    turn: (taskId, running, browserOpen) => {
      calls.push(
        `turn ${taskId} ${running ? "running" : "ended"}, browser ${browserOpen ? "open" : "stopped"}`,
      );
    },
    forget: (taskId) => {
      saved.delete(taskId);
      calls.push(`forget ${taskId}`);
    },
    stopAll: () => {
      calls.push("stopAll");
    },
  };
}

const START = { command: "pnpm dev --port 5173", withinSeconds: 60, cwd: "/work/copy" };
const LOG = "/tasks/t1/temp/page-start.log";

describe("a crewmate's open with --start", () => {
  it("keeps the start and, with nothing answering, runs it and opens the page once it answers", async () => {
    const starts = startsStandIn();
    const { browsers, pages } = harness({ starts, probe: async () => "refused" });
    const answer = browsers
      .forTask("t1")
      .navigate({ url: "http://localhost:5173/settings", start: START });
    await flush();
    expect(starts.saved.get("t1")).toEqual({
      command: "pnpm dev --port 5173",
      folder: "/work/copy",
      origin: "http://localhost:5173",
      withinMs: 60_000,
    });
    // Nothing is loaded while the build starts.
    expect(pages).toEqual([]);
    starts.runs[0]?.settle({ kind: "answered", log: LOG });
    const done = await answer;
    expect(done.refused).toBeUndefined();
    expect(pages[0]?.effects).toContain("load http://localhost:5173/settings");
    expect(done.next?.[0]).toContain("Infinitary ran your --start command in /work/copy");
    expect(done.next?.[0]).toContain(LOG);
  });

  it("waits for its build outside the task's queue, so the captain's press is not held behind it", async () => {
    let reading: AnswerReading = "answered";
    const starts = startsStandIn();
    const { browsers } = harness({ starts, probe: async () => reading });
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    browsers.stopByCaptain("t1");
    reading = "refused";
    const open = browsers.forTask("t1").navigate({ url: "http://localhost:5173/", start: START });
    await flush();
    expect(starts.runs).toHaveLength(1);
    // The captain's Open again answers while the crewmate's build still starts.
    await expect(browsers.reopen("t1")).resolves.toMatchObject({ ok: true });
    reading = "answered";
    starts.runs[0]?.settle({ kind: "answered", log: LOG });
    expect((await open).next?.[0]).toContain("Infinitary ran your --start command");
  });

  it("only keeps the start when something already answers there", async () => {
    const starts = startsStandIn();
    const { browsers, pages } = harness({ starts, probe: async () => "answered" });
    const answer = await browsers
      .forTask("t1")
      .navigate({ url: "http://localhost:5173/", start: START });
    expect(starts.runs).toEqual([]);
    expect(starts.saved.has("t1")).toBe(true);
    expect(pages[0]?.effects).toContain("load http://localhost:5173/");
    expect(answer.next?.[0]).toContain("Saved your --start command for http://localhost:5173");
  });

  it("says how the start failed and opens nothing", async () => {
    const starts = startsStandIn();
    const { browsers, pages } = harness({ starts, probe: async () => "refused" });
    const answer = browsers.forTask("t1").navigate({ url: "http://localhost:5173/", start: START });
    await flush();
    starts.runs[0]?.settle({ kind: "failed", exit: 1, log: LOG });
    const done = await answer;
    expect(done.refused).toBe("refused");
    expect(done.text).toContain("it exited (code 1) before anything answered");
    expect(done.text).toContain(LOG);
    expect(pages).toEqual([]);
  });

  it("refuses --start for an address this computer does not serve, keeping nothing", async () => {
    const starts = startsStandIn();
    const { browsers, pages } = harness({ starts });
    const answer = await browsers
      .forTask("t1")
      .navigate({ url: "https://example.com/", start: START });
    expect(answer.refused).toBe("refused");
    expect(answer.text).toContain("--start is only for a page a project serves on this computer");
    expect(starts.saved.size).toBe(0);
    expect(pages).toEqual([]);
  });

  it("refuses --start on a computer that keeps no starts", async () => {
    const { browsers } = harness();
    const answer = await browsers
      .forTask("t1")
      .navigate({ url: "http://localhost:5173/", start: START });
    expect(answer).toMatchObject({ refused: "refused" });
  });
});

describe("emit_card's line for a served page with no saved start", () => {
  it("is said for a page this computer serves until a start is saved for it, and never for another site", async () => {
    const starts = startsStandIn();
    const { browsers } = harness({ starts, probe: async () => "answered" });
    expect(browsers.unstarted("t1")).toBe(false);
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    expect(browsers.unstarted("t1")).toBe(true);
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/", start: START });
    expect(browsers.unstarted("t1")).toBe(false);
    await browsers.forTask("t1").navigate({ url: "http://localhost:4000/" });
    expect(browsers.unstarted("t1")).toBe(true);
    await browsers.forTask("t1").navigate({ url: "https://example.com/" });
    expect(browsers.unstarted("t1")).toBe(false);
  });

  it("is never said on a computer that keeps no starts", async () => {
    const { browsers } = harness();
    await browsers.forTask("t1").navigate({ url: "http://localhost:5173/" });
    expect(browsers.unstarted("t1")).toBe(false);
  });
});

describe("the captain's press on a page with a saved start", () => {
  async function stoppedBuild() {
    let reading: AnswerReading = "answered";
    const starts = startsStandIn();
    const h = harness({ starts, session: "run-1", probe: async () => reading });
    await h.browsers
      .forTask("t1")
      .navigate({ url: "http://localhost:5173/settings", start: START });
    h.browsers.stopByCaptain("t1");
    // The build stopped while the browser was stopped.
    reading = "refused";
    return { ...h, starts, answers: (next: AnswerReading) => (reading = next) };
  }

  it("runs the saved start instead of waking the crewmate, and loads the page once it answers", async () => {
    const { browsers, starts, unanswered, pages, answers } = await stoppedBuild();
    expect(starts.calls).toContain("stop t1");
    await browsers.reopen("t1");
    expect(starts.runs).toHaveLength(1);
    expect(browsers.fact("t1")).toMatchObject({ state: "open", unanswered: true, starting: true });
    expect(unanswered).toEqual([]);
    answers("answered");
    starts.runs[0]?.settle({ kind: "answered", log: LOG });
    await flush();
    await flush();
    const loads = pages.at(-1)?.effects.filter((effect) => effect.startsWith("load ")) ?? [];
    expect(loads).toEqual([
      "load http://localhost:5173/settings",
      "load http://localhost:5173/settings",
    ]);
    expect(browsers.fact("t1")).not.toHaveProperty("unanswered");
    expect(browsers.fact("t1")).not.toHaveProperty("starting");
    expect(unanswered).toEqual([]);
  });

  it("loads the page again once, from the press that started it, and never over a page that moved on", async () => {
    const { browsers, starts, pages, answers } = await stoppedBuild();
    await browsers.reopen("t1");
    // The captain looks again while it starts: the same run, no second load.
    const unwatch = browsers.watch("t1", () => undefined);
    await flush();
    unwatch();
    expect(starts.runs).toHaveLength(1);
    // The crewmate moves the page elsewhere before the build answers.
    answers("answered");
    await browsers.forTask("t1").navigate({ url: "http://127.0.0.1:8080/docs" });
    starts.runs[0]?.settle({ kind: "answered", log: LOG });
    await flush();
    await flush();
    const loads = pages.at(-1)?.effects.filter((effect) => effect.startsWith("load ")) ?? [];
    expect(loads).toEqual([
      "load http://localhost:5173/settings",
      "load http://127.0.0.1:8080/docs",
    ]);
  });

  it("wakes the crewmate once with how the start failed, and runs it no more in that outage", async () => {
    const { browsers, starts, unanswered } = await stoppedBuild();
    await browsers.reopen("t1");
    starts.runs[0]?.settle({ kind: "failed", ranOut: true, log: LOG });
    await flush();
    expect(unanswered).toEqual([
      {
        taskId: "t1",
        unanswered: {
          site: "localhost:5173",
          url: "http://localhost:5173/settings",
          once: "page-unanswered:run-1:t1:1",
          start: { command: "pnpm dev --port 5173", ranOut: true, log: LOG },
        },
      },
    ]);
    expect(browsers.fact("t1")).toMatchObject({ unanswered: true });
    expect(browsers.fact("t1")).not.toHaveProperty("starting");
    // The captain looks again while it is still down: the same outage's wake, no new start.
    const unwatch = browsers.watch("t1", () => undefined);
    await flush();
    unwatch();
    expect(starts.runs).toHaveLength(1);
    expect(unanswered.map((told) => told.unanswered.once)).toEqual([
      "page-unanswered:run-1:t1:1",
      "page-unanswered:run-1:t1:1",
    ]);
  });

  it("tells the start owner of each turn, and whether the browser is open again at its end", async () => {
    const { browsers, starts } = await stoppedBuild();
    browsers.turn("t1", true);
    browsers.turn("t1", false);
    await browsers.reopen("t1");
    browsers.turn("t1", false);
    expect(starts.calls.filter((call) => call.startsWith("turn"))).toEqual([
      "turn t1 running, browser stopped",
      "turn t1 ended, browser stopped",
      "turn t1 ended, browser open",
    ]);
  });

  it("stops the build it started with the browser, forgets the start at the close, and stops all at the quit", async () => {
    const { browsers, starts } = await stoppedBuild();
    await browsers.reopen("t1");
    browsers.stopByCaptain("t1");
    expect(starts.calls.filter((call) => call === "stop t1")).toHaveLength(2);
    browsers.closeTask("t1");
    expect(starts.calls).toContain("forget t1");
    expect(starts.saved.has("t1")).toBe(false);
    browsers.closeAll();
    expect(starts.calls.at(-1)).toBe("stopAll");
  });
});
