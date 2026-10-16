import { describe, expect, it } from "vitest";
import { modelNames } from "./modelDisplayName";
import { browserDriverOf, canOpenAgain, type TaskBrowserStop } from "./taskBrowser";
import { TASK_FACTS, taskFactsOf } from "./taskFacts";
import type { TaskActivityRow, TaskDetail } from "./tasks";

const now = new Date("2026-10-02T18:00:00Z").getTime();
function row(kind: TaskActivityRow["kind"], text: string, at: number): TaskActivityRow {
  return { id: at, at, kind, text };
}
function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "t1",
    key: "SCR-3",
    projectId: "p1",
    parentId: null,
    kind: "work",
    title: "Speed up the first paint",
    goal: null,
    priority: 2,
    status: "active",
    activity: "idle",
    workPosture: { state: "idle", reason: "checks" },
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 3",
    model: "openrouter/google/gemini-3-pro-image",
    tier: "medium",
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: now - 600_000,
    updatedAt: now,
    startedAt: now - 500_000,
    closedAt: null,
    intent: null,
    rigor: "standard",
    deliverable: "change",
    basis: null,
    skippedPlanBecause: null,
    brief: "",
    outcome: null,
    modelLabel: "Nano Banana Pro",
    reasoning: { level: "off" },
    modelReason: { rule: "R4", asked: "medium", served: "medium", basis: "SCR-1" },
    events: [],
    activityLog: [
      row("dispatched", "crewmate 3 started on Nano Banana Pro.", now - 500_000),
      row("progress", "Measured the paint at 410 ms", now - 300_000),
      row("pr_opened", "Opened pull request #612.", now - 120_000),
    ],
    plan: null,
    closing: null,
    problem: null,
    asks: [],
    ...patch,
  } as TaskDetail;
}
const names = modelNames([
  { provider: "openrouter", id: "google/gemini-3-pro-image", label: "Google: Nano Banana Pro" },
]);

describe("the shared task facts", () => {
  it("keeps one order, the fact strip's cells as the merge card names them, then why that model", () => {
    expect(TASK_FACTS).toEqual([
      "status",
      "task",
      "now",
      "plan",
      "model",
      "intelligence",
      "reasoning",
      "change",
      "checks",
      "review",
      "reason",
      "browser",
    ]);
  });

  it("reads the newest activity of any kind as Now, the model through the one lookup, and its readout", () => {
    const facts = taskFactsOf(
      detail({
        delivery: {
          mode: "direct-pr",
          prNumber: 612,
          changeLabel: "#612",
          prUrl: "https://github.com/demo/repo/pull/612",
          ci: "pending",
          ciAt: now - 60_000,
        },
      }),
      names,
    );
    expect(facts).toEqual({
      key: "SCR-3",
      status: { mark: "idle", word: "Idle", reason: "Waiting for checks" },
      title: "Speed up the first paint",
      // Not the crewmate's own newest words: the opened pull request is newer.
      now: { text: "Opened pull request #612.", at: now - 120_000 },
      plan: null,
      model: "Nano Banana Pro",
      tier: "medium",
      reasoning: { level: "off" },
      reason: "Building from the plan in SCR-1",
      delivery: {
        change: {
          noun: "Pull request",
          label: "#612",
          url: "https://github.com/demo/repo/pull/612",
        },
        // The merge card's words and dot for the same reading.
        checks: { dot: "running", words: "running", at: now - 60_000 },
        review: null,
      },
      browser: null,
    });
  });

  it("keeps the words of Now that name its pull request, so a surface that takes clicks links them", () => {
    const change = { url: "https://github.com/demo/repo/pull/612", from: 7, to: 24 };
    const facts = taskFactsOf(
      detail({
        activityLog: [{ ...row("pr_opened", "Opened pull request #612.", now), change }],
      }),
      names,
    );
    expect(facts.now).toEqual({ text: "Opened pull request #612.", at: now, change });
    expect(facts.now?.text.slice(change.from, change.to)).toBe("pull request #612");
  });

  it("holds Now open until the record answers, and has none for a record with no row", () => {
    const { activityLog: _, ...board } = detail();
    expect(taskFactsOf(board, names).now).toBeUndefined();
    expect(taskFactsOf(detail({ activityLog: [] }), names).now).toBeNull();
  });

  it("carries the plan the record read, held open until it answers (FI3-734)", () => {
    const { activityLog: _, plan: __, ...board } = detail();
    expect(taskFactsOf(board, names).plan).toBeUndefined();
    const plan = {
      at: now - 300_000,
      items: [
        {
          label: "Measure the paint",
          short: "Measure",
          state: "done" as const,
          since: now - 400_000,
        },
        {
          label: "Cut the first request",
          short: "Cut",
          state: "current" as const,
          since: now - 300_000,
        },
      ],
    };
    expect(taskFactsOf(detail({ plan }), names).plan).toEqual(plan);
  });

  it("has no readout before assignment, and names an unknown model by its bare id", () => {
    const unassigned = taskFactsOf(detail({ model: null }), names);
    expect(unassigned).toMatchObject({ model: null, tier: null, reasoning: null, reason: null });
    expect(taskFactsOf(detail({ model: "fm-mock/mock-1" }), names).model).toBe("mock-1");
  });

  it("names a branch on a plain Git host, and the checks before any change", () => {
    expect(
      taskFactsOf(
        detail({ delivery: { mode: "direct-pr", changeLabel: "fm/task-ab12", ci: "green" } }),
        names,
      ).delivery,
    ).toEqual({
      change: { noun: "Branch", label: "fm/task-ab12", url: null },
      checks: { dot: "ok", words: "passed", at: null },
      review: null,
    });
    expect(
      taskFactsOf(detail({ delivery: { mode: "direct-pr", ci: "red", ciAt: now } }), names)
        .delivery,
    ).toEqual({ change: null, checks: { dot: "failed", words: "failed", at: now }, review: null });
    // A change no reading has reached yet.
    expect(
      taskFactsOf(detail({ delivery: { mode: "direct-pr", prNumber: 7 } }), names).delivery?.checks,
    ).toEqual({ dot: "idle", words: "not read yet", at: null });
    // Nothing proposed and nothing read: no line at all.
    expect(taskFactsOf(detail({ delivery: { mode: "local-only" } }), names).delivery).toBeNull();
    expect(
      taskFactsOf(detail({ delivery: { mode: "direct-pr", ci: "no-pr" } }), names).delivery,
    ).toBeNull();
  });

  it("keeps a review's verdict beside the checks, and only it once the task has closed", () => {
    const delivery = {
      mode: "direct-pr" as const,
      prNumber: 84,
      ci: "red" as const,
      reviewVerdict: "findings" as const,
      reviewRisk: "high" as const,
    };
    expect(taskFactsOf(detail({ delivery }), names).delivery).toEqual({
      change: { noun: "Pull request", label: "#84", url: null },
      checks: { dot: "failed", words: "failed", at: null },
      review: { dot: "warn", words: "findings · risk high" },
    });
    // A closed task names its change once, on its closing line.
    expect(
      taskFactsOf(detail({ status: "done", closedReason: "merged", delivery }), names).delivery,
    ).toEqual({
      change: null,
      checks: null,
      review: { dot: "warn", words: "findings · risk high" },
    });
  });

  it("reads the task's own browser: the crewmate drives while its turn runs, then nobody does", () => {
    const open = {
      state: "open" as const,
      site: "localhost:5173",
      url: "http://localhost:5173/signup",
      title: "Sign up",
      did: 'clicked "Send"',
    };
    expect(taskFactsOf(detail(), names).browser).toBeNull();
    expect(
      taskFactsOf(
        detail({
          browser: open,
          activity: "running",
          workPosture: { state: "active", reason: "turn" },
        }),
        names,
      ).browser,
    ).toEqual({ site: "localhost:5173", words: "the crewmate is driving", driver: "crewmate" });
    // Background work or a wait on the checks is not a turn: nobody uses the page.
    for (const workPosture of [
      { state: "active", reason: "job" },
      { state: "idle", reason: "checks" },
      { state: "idle", reason: "captain" },
    ] as const) {
      expect(taskFactsOf(detail({ browser: open, workPosture }), names).browser).toEqual({
        site: "localhost:5173",
        words: "nobody is driving",
        driver: "nobody",
      });
    }
    // A record read without a posture falls back to the activity.
    expect(browserDriverOf({ activity: "starting", workPosture: undefined })).toBe("crewmate");
    expect(browserDriverOf({ activity: "idle", workPosture: undefined })).toBe("nobody");
  });

  it('says when the browser is in the captain\'s hands, whatever the turn (docs/task-browser.md, "Taking control")', () => {
    const open = {
      state: "open" as const,
      site: "aurora.example",
      url: "http://aurora.example/signin",
      title: "Sign in",
    };
    const turn = {
      activity: "running" as const,
      workPosture: { state: "active" as const, reason: "turn" as const },
    };
    const line = (control: "waiting" | "taking" | "captain") =>
      taskFactsOf(detail({ browser: { ...open, control }, ...turn }), names).browser;
    expect(line("waiting")).toEqual({
      site: "aurora.example",
      words: "paused for your help",
      driver: "waiting",
    });
    expect(line("taking")).toEqual({
      site: "aurora.example",
      words: "you are taking control",
      driver: "taking",
    });
    expect(line("captain")).toEqual({
      site: "aurora.example",
      words: "you have control",
      driver: "captain",
    });
  });

  it("says what stopped the task's browser, and offers Open again until the task closes", () => {
    const stopped = (why: TaskBrowserStop) => ({
      state: "stopped" as const,
      site: "localhost:5173",
      url: "http://localhost:5173/",
      stopped: why,
      at: now,
    });
    expect(taskFactsOf(detail({ browser: stopped("captain") }), names).browser).toEqual({
      site: "localhost:5173",
      words: "you stopped it",
    });
    expect(taskFactsOf(detail({ browser: stopped("idle") }), names).browser?.words).toBe(
      "stopped after 30 minutes unused",
    );
    expect(canOpenAgain(stopped("crewmate"))).toBe(true);
    expect(canOpenAgain(stopped("task-closed"))).toBe(false);
  });
});
