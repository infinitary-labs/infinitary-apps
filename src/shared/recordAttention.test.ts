// The task record's attention sentence and closed line (INF-2261: "A
// failure, an interruption, a hold or a wait keeps its sentence at the top of
// the body, above the goal"). These moved from the record's frame to the
// window with the Info tab; each case is the frame test it was ported from.
import { describe, expect, it } from "vitest";
import { partsDoTheWork, recordAttentionOf, recordClosedLineOf } from "./recordAttention";
import { waitChainWords } from "./taskPresentation";
import type { TaskDetail } from "./tasks";

const now = new Date("2026-09-16T14:30:00Z").getTime();

function task(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "test",
    key: "DEMO-42",
    projectId: "demo",
    parentId: null,
    kind: "work",
    title: "Fix search",
    goal: "Find tasks by key.",
    priority: 2,
    status: "active",
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: now - 600_000,
    updatedAt: now,
    startedAt: now - 300_000,
    closedAt: null,
    intent: null,
    rigor: null,
    deliverable: null,
    basis: null,
    skippedPlanBecause: null,
    brief: "",
    outcome: null,
    modelLabel: null,
    cards: [],
    events: [],
    plan: null,
    activityLog: [],
    closing: null,
    problem: null,
    asks: [],
    ...patch,
  } as TaskDetail;
}

const say = (detail: TaskDetail) => recordAttentionOf(detail, now);

describe("the record's attention sentence", () => {
  it("says nothing when nothing needs saying, and a blocker when one is live", () => {
    expect(say(task({ outcomeSummary: "Fixed." }))).toBeNull();
    expect(say(task({ blockedBy: ["DEMO-38"] }))).toEqual({
      title: "Waiting on DEMO-38",
      guidance: "This task is blocked by other work.",
      urgent: true,
      danger: false,
    });
  });

  it("paints an interruption as danger in plain words, and leaves a waiting decision to the bar", () => {
    expect(say(task({ blockedBy: ["DEMO-38"], waitingCardId: "card" }))?.title).toBe(
      "Waiting on DEMO-38",
    );
    expect(
      say(
        task({
          activity: "interrupted",
          problem: "The connection dropped - try again.",
        }),
      ),
    ).toEqual({
      title: "Work was interrupted",
      guidance: "The connection dropped - try again.",
      urgent: true,
      danger: true,
    });
    expect(
      say(
        task({
          waitingCardId: "card",
          flags: { blocked: false, held: true, needsYou: true, ready: false },
        }),
      ),
    ).toBeNull();
  });

  it("says what was dropped and whom to ask when a blocked task has no live blocker", () => {
    expect(
      say(
        task({
          status: "open",
          activity: null,
          flags: { blocked: true, held: false, needsYou: true, ready: false },
        }),
      ),
    ).toEqual({
      title: "A task it waits on was dropped",
      guidance: "Ask your first mate about its dependencies before starting.",
      urgent: false,
      danger: false,
    });
  });

  it("leaves an open task's next step to its status reason, and says a parent's parts do the work", () => {
    expect(
      say(
        task({
          activity: "idle",
          delivery: {
            mode: "direct-pr",
            prNumber: 57,
            changeLabel: "#57",
            ci: "pending",
          },
        }),
      ),
    ).toBeNull();
    expect(say(task({ status: "open", activity: null, startPolicy: "on-request" }))).toBeNull();
    const parent = {
      status: "open",
      activity: null,
      startPolicy: "on-request",
    } as const;
    expect(say(task({ ...parent, children: { total: 5, closed: 3 } }))).toMatchObject({
      title: "Its 5 parts do the work",
      guidance: "3 closed, 2 still open.",
    });
    expect(say(task({ ...parent, children: { total: 1, closed: 0 } }))).toMatchObject({
      title: "Its 1 part does the work",
      guidance: "0 closed, 1 still open.",
    });
    expect(
      say(
        task({
          ...parent,
          blockedBy: ["DEMO-38"],
          children: { total: 5, closed: 3 },
        }),
      )?.title,
    ).toBe("Waiting on DEMO-38");
  });

  // INF-6805: "there's no way to see children parts, and \"waiting for start\" is also misleading" -
  // a parent with open parts says what its parts wait on, never a Start of its own.
  it("says what a parent's open parts wait on, with the most pressing first", () => {
    const parent = {
      status: "open",
      activity: null,
      startPolicy: "on-request",
    } as const;
    const closed = task({
      key: "DEMO-43",
      status: "done",
      activity: null,
      closedReason: "merged",
    });
    const backlog = task({ key: "DEMO-44", ...parent });
    const working = task({ key: "DEMO-45" });
    const waiting = task({
      key: "DEMO-46",
      activity: "idle",
      waitingCardId: "card",
    });
    const of = (...parts: TaskDetail[]) =>
      say(
        task({
          ...parent,
          children: { total: parts.length, closed: 1 },
          parts,
        }),
      );
    expect(of(closed, backlog)).toEqual({
      title: "Its last part waits for your Start",
      guidance: "DEMO-44 is in your backlog. This task closes by itself once its parts close.",
      urgent: false,
      danger: false,
    });
    expect(of(closed, working)).toMatchObject({
      title: "Waiting for its last part",
      guidance: "DEMO-45 is working. This task closes by itself once its parts close.",
    });
    expect(of(closed, waiting)).toMatchObject({
      title: "Its last part is waiting on you",
      guidance: "DEMO-46 has a card for you. This task closes by itself once its parts close.",
    });
    expect(of(closed, backlog, working, waiting)).toMatchObject({
      title: "Waiting for 3 of its 4 parts",
      guidance:
        "1 waiting on you, 1 working and 1 in your backlog. This task closes by itself once its parts close.",
    });
    expect(
      say(
        task({
          ...parent,
          blockedBy: ["DEMO-38"],
          children: { total: 2, closed: 1 },
          parts: [closed, backlog],
        }),
      )?.title,
    ).toBe("Waiting on DEMO-38");
    // Only a parent that never runs itself closes by itself: a program runs its
    // script while open, and a when-ready parent starts by itself when nothing
    // holds it.
    const parts = { children: { total: 2, closed: 1 }, parts: [closed, backlog] };
    for (const runs of [
      { ...parent, program: true as const },
      { ...parent, startPolicy: "when-ready" as const },
    ])
      expect(say(task({ ...runs, ...parts }))?.title).toBe("Its 2 parts do the work");
  });

  // INF-6805 plan, run_facts "hidden": a parent that never runs itself leaves
  // out Now, Delivery, Runs on and Use; one that runs keeps them.
  it("counts only an unstarted on-request parent as one that never runs itself", () => {
    const parent = {
      status: "open",
      activity: null,
      startPolicy: "on-request",
      children: { total: 2, closed: 1 },
    } as const;
    expect(partsDoTheWork(task(parent))).toBe(true);
    expect(partsDoTheWork(task({ ...parent, program: true }))).toBe(false);
    expect(partsDoTheWork(task({ ...parent, startPolicy: "when-ready" }))).toBe(false);
    expect(partsDoTheWork(task({ ...parent, status: "active", activity: "running" }))).toBe(false);
    expect(partsDoTheWork(task({ ...parent, children: { total: 0, closed: 0 } }))).toBe(false);
  });

  it("does not equate needsYou with a decision, and keeps the reported blocker in view", () => {
    expect(
      say(
        task({
          flags: { blocked: false, held: true, needsYou: true, ready: false },
        }),
      )?.title,
    ).toBe("Work is paused");
    expect(
      say(
        task({
          activity: "idle",
          captainWait: true,
          outcomeSummary: "The session cannot open a pull request: a required tool is missing.",
          flags: { blocked: false, held: false, needsYou: true, ready: false },
        }),
      ),
    ).toMatchObject({
      title: "Work is paused",
      guidance: "The session cannot open a pull request: a required tool is missing.",
    });
  });

  it("does not ask the captain while checks continue, and never fabricates a missing reason", () => {
    expect(
      say(
        task({
          activity: "idle",
          captainWait: true,
          workPosture: { state: "active", reason: "checks" },
          flags: { blocked: false, held: true, needsYou: true, ready: false },
          outcomeSummary: "An older blocker.",
        }),
      ),
    ).toBeNull();
    expect(say(task({ activity: "idle", captainWait: true, outcomeSummary: null }))?.guidance).toBe(
      "No reason has been reported yet.",
    );
    expect(
      say(
        task({
          activity: "idle",
          waitingCardId: "choice",
          outcomeSummary: "An older blocker.",
        }),
      ),
    ).toBeNull();
  });

  it("names a failed task's problem", () => {
    expect(
      say(
        task({
          status: "dropped",
          activity: null,
          closedReason: "failed",
          problem: "The provider did not accept your sign-in - sign in again.",
        }),
      ),
    ).toMatchObject({
      title: "Task failed",
      guidance: "The provider did not accept your sign-in - sign in again.",
      danger: true,
    });
  });

  it("keeps all standing non-check waits and preserves failure guidance", () => {
    const waits: NonNullable<TaskDetail["waits"]> = [
      {
        id: "dependency:web",
        kind: "dependency",
        label: "WEB-41",
        taskKeys: ["WEB-41"],
        since: now - 60000,
      },
      {
        id: "start",
        kind: "start",
        label: "Scheduled start",
        next: { kind: "start", at: now - 30000 },
      },
      {
        id: "run:42:1",
        kind: "run",
        label: "Website checks",
        next: { kind: "next-read", at: now + 60000 },
      },
    ];
    const failed = say(
      task({
        activity: "interrupted",
        problem: "The computer disconnected.",
        blockedBy: ["WEB-41"],
        waits,
      }),
    );
    expect(failed?.title).toBe("Work was interrupted");
    expect(failed?.guidance).toMatch(/^The computer disconnected\./);
    expect(failed?.guidance).toContain("Waiting on WEB-41 · wait recorded");
    expect(failed?.guidance).toContain("start time was due");
    expect(failed?.guidance).not.toContain("Website checks");
    const waiting = say(task({ blockedBy: ["WEB-41"], waits }));
    expect(waiting?.title).toContain("Waiting on WEB-41 · wait recorded");
    expect(waiting?.title).toContain("start time was due");
  });

  // INF-5578 finding 4: the tile named where a line of waits stops while the
  // record named only the task waited on; the record says the same as the tile.
  it("names where a lone task wait's line stops, keeping when the wait was recorded", () => {
    const waits: NonNullable<TaskDetail["waits"]> = [
      {
        id: "dependency:web",
        kind: "dependency",
        label: "WEB-41",
        since: now - 60000,
      },
    ];
    for (const waitChain of [
      { on: "WEB-41", end: "WEB-40", update: true as const },
      { on: "WEB-41", until: now + 3_600_000 },
    ]) {
      const title = say(task({ activity: "idle", blockedBy: ["WEB-41"], waits, waitChain }))?.title;
      expect(title?.startsWith(`${waitChainWords(waitChain, now)} · wait recorded `)).toBe(true);
      expect(title).not.toContain("time unknown");
    }
    // A line that stops at the task waited on, with no hold, keeps the wait's own words.
    const plain = say(
      task({
        activity: "idle",
        blockedBy: ["WEB-41"],
        waits,
        waitChain: { on: "WEB-41" },
      }),
    );
    expect(plain?.title).toMatch(/^Waiting on WEB-41 · wait recorded/);
  });
});

describe("a closed task's line", () => {
  it("is absent while the task is open", () => {
    expect(recordClosedLineOf(task())).toBeNull();
  });

  it("closes a merge on one line, naming the change and its checks once", () => {
    expect(
      recordClosedLineOf(
        task({
          status: "done",
          closedReason: "merged",
          closedAt: now - 46 * 60_000,
          closing: { at: now - 46 * 60_000, note: null },
          delivery: {
            mode: "direct-pr",
            prUrl: "https://github.com/demo/repo/pull/57",
            prNumber: 57,
            changeLabel: "#57",
            ci: "green",
            ciAt: now - 50 * 60_000,
          },
        }),
      ),
    ).toEqual({
      lead: "Merged ",
      at: now - 46 * 60_000,
      change: {
        noun: "pull request",
        label: "#57",
        url: "https://github.com/demo/repo/pull/57",
      },
      tail: ". The checks passed.",
    });
  });

  // INF-3169's plan, piece 3: a close as done on the captain's word says so
  // once, in its lead; the saved note keeps the host's own words for readers
  // that do not read onWord (the phone's closed line).
  it("says a close on the captain's word in its lead, once", () => {
    const closed = (note: string) =>
      recordClosedLineOf(
        task({
          status: "done",
          closedReason: "finished",
          closedAt: now,
          closing: { at: now, note, onWord: true },
        }),
      );
    expect(closed("finished on the captain's word")).toEqual({
      lead: "Finished on your word ",
      at: now,
      change: null,
      tail: ".",
    });
    expect(closed("The meter reads on time.")?.tail).toBe(": The meter reads on time.");
  });

  it("reads a dropped task by its recorded note, not as a missing report", () => {
    expect(
      recordClosedLineOf(
        task({
          status: "dropped",
          closedReason: "cancelled",
          closedAt: now - 3_600_000,
          closing: { at: now - 3_600_000, note: "Duplicate of FI3-125." },
        }),
      ),
    ).toEqual({
      lead: "Dropped ",
      at: now - 3_600_000,
      change: null,
      tail: ": Duplicate of FI3-125.",
    });
  });
});
