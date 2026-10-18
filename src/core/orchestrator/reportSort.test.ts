import { describe, expect, it } from "vitest";
import {
  type IdleTurn,
  idleTurn,
  type ReportSortFacts,
  type ReportSortRule,
  sortReport,
  type Witnesses,
} from "./reportSort";

/**
 * The whose-turn rule as a table (S7c, R4.8's restated rule). Every branch,
 * and the order between them: the order IS the rule, so each case names the
 * facts that would have answered differently one step later.
 */

/** Nothing is true: an unobservable backend with a quiet, empty task. */
const NOTHING: ReportSortFacts = {
  threadAwaitingAuthor: false,
  decisionCardOpen: false,
  captainGateOwed: false,
  filedFollowups: false,
  jobsRunning: false,
  deliverable: false,
  pendingSettle: false,
  timedWait: false,
  checksWatched: false,
  accountHeld: false,
  waitsOnUnstarted: false,
  workObservable: false,
};

const facts = (over: Partial<ReportSortFacts> = {}): ReportSortFacts => ({ ...NOTHING, ...over });

describe("sortReport", () => {
  it.each([false, true])(
    "an internal step wakes independently of backend observability (%s)",
    (workObservable) => {
      expect(sortReport(facts({ internalStep: true, workObservable }))).toMatchObject({
        rule: "step-answered",
        wake: true,
        verdict: "captain",
      });
    },
  );

  it.each([
    ["threadAwaitingAuthor", "thread-unanswered"],
    ["decisionCardOpen", "captain-card"],
    ["jobsRunning", "still-moving"],
    ["deliverable", "still-moving"],
    ["pendingSettle", "still-moving"],
    ["timedWait", "still-moving"],
    ["checksWatched", "still-moving"],
    ["waitsOnUnderway", "still-moving"],
    ["accountHeld", "still-moving"],
    ["outOfReach", "still-moving"],
    ["captainGateOwed", "captain-gate"],
    ["needsFirstmate", "needs-firstmate"],
    ["finished", "finished"],
    ["filedFollowups", "filed-followups"],
    ["waitsOnUnstarted", "waits-unstarted"],
  ] as const)("an internal step preserves %s precedence", (witness, rule) => {
    expect(sortReport(facts({ internalStep: true, [witness]: true })).rule).toBe(rule);
  });

  const cases: Array<{
    name: string;
    facts: ReportSortFacts;
    rule: ReportSortRule;
    verdict: "routine" | "captain";
    wake: boolean;
  }> = [
    {
      // The captain has spoken since that card went up, so the card no
      // longer holds the turn: the author owes him an answer in the thread.
      name: "0. the captain replied in a thread and has no answer: the crewmate's turn",
      facts: facts({
        threadAwaitingAuthor: true,
        decisionCardOpen: true,
        filedFollowups: true,
        workObservable: true,
      }),
      rule: "thread-unanswered",
      verdict: "routine",
      wake: false,
    },
    {
      // FI3-710: the crewmate's own request, on a backend the host cannot
      // watch, with its card still up and a declared wait beside it.
      name: "0a. the report asks the Firstmate to act: wake, whatever card is up",
      facts: facts({
        needsFirstmate: true,
        decisionCardOpen: true,
        captainWait: true,
        jobsRunning: true,
      }),
      rule: "needs-firstmate",
      verdict: "captain",
      wake: true,
    },
    {
      name: "1. a decision card is open: the captain's turn",
      facts: facts({ decisionCardOpen: true, workObservable: true }),
      rule: "captain-card",
      verdict: "routine",
      wake: false,
    },
    {
      // A note's crewmate that declared it waits on him (FI3-435): its gate
      // counts as a card up, whatever the backend.
      name: "1'. its crewmate declared a wait on the captain: the captain's turn",
      facts: facts({ decisionCardOpen: true, captainWait: true }),
      rule: "captain-card",
      verdict: "routine",
      wake: false,
    },
    {
      // Its browser in the captain's hands (docs/task-browser.md, "Taking
      // control"): his Return control is the crewmate's next wake.
      name: "1''. its browser is in the captain's hands: the captain's turn",
      facts: facts({ decisionCardOpen: true, browserWithCaptain: true, workObservable: true }),
      rule: "captain-card",
      verdict: "routine",
      wake: false,
    },
    {
      // The crewmate's declaration, on a backend the host cannot watch too.
      name: "1a. the report declared its work finished: wake, so the Firstmate closes it",
      facts: facts({ finished: true, jobsRunning: true }),
      rule: "finished",
      verdict: "captain",
      wake: true,
    },
    {
      name: "2. the report filed follow-ups: wake",
      facts: facts({ filedFollowups: true }),
      rule: "filed-followups",
      verdict: "captain",
      wake: true,
    },
    {
      // FI3-671: on a backend the host cannot watch too - only the Firstmate
      // or the captain starts the work it waits on.
      name: "2a. it waits on work nobody has started: wake, whatever the backend",
      facts: facts({ waitsOnUnstarted: true }),
      rule: "waits-unstarted",
      verdict: "captain",
      wake: true,
    },
    {
      name: "2a'. the same wait on a backend the host watches: wake",
      facts: facts({ waitsOnUnstarted: true, workObservable: true }),
      rule: "waits-unstarted",
      verdict: "captain",
      wake: true,
    },
    {
      name: "3a. a job is running: the crewmate's turn",
      facts: facts({ jobsRunning: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      name: "3b. guidance its lane will still deliver: the crewmate's turn",
      facts: facts({ deliverable: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      name: "3c. a settle holds the boundary: the crewmate's turn",
      facts: facts({ pendingSettle: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      name: "3d. a timed wait on its gate: the crewmate's turn",
      facts: facts({ timedWait: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      name: "3d'. the host watches its change's checks: the crewmate's turn when they finish",
      facts: facts({ checksWatched: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      // FI3-250: on a backend the host watches too - the work's close is
      // what moves it, and the sweep turns that close into its steer.
      name: "3d''. it waits on work underway: the crewmate's turn when that work closes",
      facts: facts({ waitsOnUnderway: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      name: "3e. a cut-off holds its account: the crewmate's turn when it serves again",
      facts: facts({ accountHeld: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      // Its turn goes on there unseen; it catches up here once that
      // computer is back (docs/helper.md, "Holding a conversation").
      name: "3f. the computer it runs on is out of reach: the crewmate's turn when it is back",
      facts: facts({ outOfReach: true, workObservable: true }),
      rule: "still-moving",
      verdict: "routine",
      wake: false,
    },
    {
      // A round cap before the Firstmate's card: the crewmate cannot act,
      // so the turn is the Firstmate's whatever the backend.
      name: "4. held for the captain with no card up: the Firstmate's turn, wake",
      facts: facts({ captainGateOwed: true }),
      rule: "captain-gate",
      verdict: "captain",
      wake: true,
    },
    {
      name: "5. provably stopped: nobody's turn, wake now",
      facts: facts({ workObservable: true }),
      rule: "stopped",
      verdict: "captain",
      wake: true,
    },
    {
      // INF-11: a report nothing holds is never routine, on any backend.
      name: "6. the host cannot tell: nothing it sees holds the turn, so wake now",
      facts: NOTHING,
      rule: "cannot-tell",
      verdict: "captain",
      wake: true,
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const sorted = sortReport(entry.facts);
      expect(sorted.rule).toBe(entry.rule);
      expect(sorted.verdict).toBe(entry.verdict);
      expect(sorted.wake).toBe(entry.wake);
      expect(sorted.reason).not.toBe("");
    });
  }

  it("a decision card outranks everything, including filings", () => {
    expect(
      sortReport(
        facts({
          decisionCardOpen: true,
          filedFollowups: true,
          jobsRunning: true,
          workObservable: true,
        }),
      ).rule,
    ).toBe("captain-card");
  });

  it("filings outrank a crewmate that is still moving", () => {
    expect(sortReport(facts({ filedFollowups: true, jobsRunning: true })).rule).toBe(
      "filed-followups",
    );
  });

  it("a wait on unstarted work sits after a card and filings, and before a crewmate still moving", () => {
    expect(sortReport(facts({ waitsOnUnstarted: true, decisionCardOpen: true })).rule).toBe(
      "captain-card",
    );
    expect(sortReport(facts({ waitsOnUnstarted: true, filedFollowups: true })).rule).toBe(
      "filed-followups",
    );
    for (const moving of ["jobsRunning", "checksWatched", "accountHeld", "outOfReach"] as const) {
      expect(sortReport(facts({ waitsOnUnstarted: true, [moving]: true })).rule, moving).toBe(
        "waits-unstarted",
      );
    }
  });

  it("a wait on work underway reads after a card, filings and a wait on unstarted work", () => {
    expect(sortReport(facts({ waitsOnUnderway: true, decisionCardOpen: true })).rule).toBe(
      "captain-card",
    );
    expect(sortReport(facts({ waitsOnUnderway: true, filedFollowups: true })).rule).toBe(
      "filed-followups",
    );
    expect(sortReport(facts({ waitsOnUnderway: true, waitsOnUnstarted: true })).rule).toBe(
      "waits-unstarted",
    );
    expect(sortReport(facts({ waitsOnUnderway: true })).reason).toBe(
      "it waits on work underway; the crewmate's turn continues when that work closes.",
    );
  });

  // INF-11, from the captain's words "make this missed escalation
  // structurally impossible": a report stays quiet only while a witness
  // holds its turn - a card on his screen, a reply its crewmate owes, or
  // work that moves on its own. Every combination of the facts is tried.
  it("never leaves a report quiet without a witness that holds its turn (INF-11)", () => {
    const flags = [
      "threadAwaitingAuthor",
      "decisionCardOpen",
      "captainWait",
      "browserWithCaptain",
      "captainGateOwed",
      "deliverable",
      "jobsRunning",
      "pendingSettle",
      "timedWait",
      "checksWatched",
      "accountHeld",
      "outOfReach",
      "waitsOnUnstarted",
      "waitsOnUnderway",
      "filedFollowups",
      "finished",
      "needsFirstmate",
      "workObservable",
      "internalStep",
    ] as const;
    const holds = (over: ReportSortFacts) =>
      over.threadAwaitingAuthor ||
      over.decisionCardOpen ||
      over.deliverable ||
      over.jobsRunning ||
      over.pendingSettle ||
      over.timedWait ||
      over.checksWatched ||
      over.accountHeld ||
      over.outOfReach === true ||
      over.waitsOnUnderway === true;
    const unheld: string[] = [];
    for (let mask = 0; mask < 1 << flags.length; mask += 1) {
      const over = facts(
        Object.fromEntries(flags.map((flag, bit) => [flag, (mask & (1 << bit)) !== 0])),
      );
      const sorted = sortReport(over);
      if (
        sorted.verdict !== (sorted.wake ? "captain" : "routine") ||
        (!sorted.wake && !holds(over))
      )
        unheld.push(`${sorted.rule} at ${flags.filter((_, bit) => mask & (1 << bit)).join("+")}`);
    }
    expect(unheld).toEqual([]);
  });

  it("an unobservable backend can never be called stopped", () => {
    for (const over of [{}, { jobsRunning: true }, { decisionCardOpen: true }]) {
      expect(sortReport(facts(over)).rule).not.toBe("stopped");
    }
  });

  it("a card the captain gate names holds the turn above the gate's own wait", () => {
    expect(sortReport(facts({ decisionCardOpen: true, captainGateOwed: true })).rule).toBe(
      "captain-card",
    );
  });

  it("a crewmate still moving is its own turn even while the gate holds it", () => {
    expect(sortReport(facts({ captainGateOwed: true, jobsRunning: true })).rule).toBe(
      "still-moving",
    );
  });

  it("a declared wait says so on the record, not that a card is up", () => {
    expect(sortReport(facts({ decisionCardOpen: true, captainWait: true })).reason).toContain(
      "declared that it waits on the captain",
    );
  });

  it("a decision card up outranks a finished declaration", () => {
    expect(sortReport(facts({ decisionCardOpen: true, finished: true })).rule).toBe("captain-card");
  });

  it("a request for the Firstmate sits after an unanswered reply and before every quiet row (FI3-710)", () => {
    // The captain's reply is answered first: the crewmate's turn, no wake.
    expect(sortReport(facts({ needsFirstmate: true, threadAwaitingAuthor: true })).rule).toBe(
      "thread-unanswered",
    );
    for (const quiet of [
      "decisionCardOpen",
      "jobsRunning",
      "deliverable",
      "pendingSettle",
      "timedWait",
      "checksWatched",
      "waitsOnUnderway",
      "accountHeld",
      "outOfReach",
    ] as const) {
      expect(sortReport(facts({ needsFirstmate: true, [quiet]: true })).rule, quiet).toBe(
        "needs-firstmate",
      );
    }
    // Beside a waking declaration it names the rule, and the wake is one.
    expect(
      sortReport(facts({ needsFirstmate: true, finished: true, filedFollowups: true })),
    ).toEqual(expect.objectContaining({ rule: "needs-firstmate", wake: true }));
    // Without it the same open card holds the report quiet, as before.
    expect(sortReport(facts({ decisionCardOpen: true })).wake).toBe(false);
  });
});

describe("idleTurn: the same witnesses, read the same way, for an idle crewmate", () => {
  const QUIET: Witnesses = {
    threadAwaitingAuthor: false,
    decisionCardOpen: false,
    captainGateOwed: false,
    deliverable: false,
    jobsRunning: false,
    pendingSettle: false,
    timedWait: false,
    checksWatched: false,
    accountHeld: false,
    waitsOnUnstarted: false,
  };
  const idle = (over: Partial<Witnesses>): IdleTurn => idleTurn({ ...QUIET, ...over });

  it("answers in the sort's order", () => {
    expect(idle({})).toBe("nobody");
    expect(idle({ threadAwaitingAuthor: true, decisionCardOpen: true })).toBe("thread");
    expect(idle({ decisionCardOpen: true, captainGateOwed: true, jobsRunning: true })).toBe(
      "captain",
    );
    for (const moving of [
      "deliverable",
      "jobsRunning",
      "pendingSettle",
      "timedWait",
      "checksWatched",
    ] as const) {
      expect(idle({ [moving]: true, captainGateOwed: true }), moving).toBe("moving");
    }
    expect(idle({ captainGateOwed: true })).toBe("owed");
    // A cut-off holds only the crewmate's own turn: a card still owed is owed.
    expect(idle({ accountHeld: true, captainGateOwed: true })).toBe("owed");
    expect(idle({ accountHeld: true })).toBe("moving");
    // So does a computer out of reach: its turn goes on there.
    expect(idle({ outOfReach: true, captainGateOwed: true })).toBe("owed");
    expect(idle({ outOfReach: true })).toBe("moving");
  });

  it("a wait on unstarted work leaves the idle turn as it was: the report's wake carries it", () => {
    expect(idle({ waitsOnUnstarted: true })).toBe("nobody");
    expect(idle({ waitsOnUnstarted: true, jobsRunning: true })).toBe("moving");
  });

  it("a wait on work underway is moving: no rung climbs until that work closes (FI3-250)", () => {
    expect(idle({ waitsOnUnderway: true })).toBe("moving");
    expect(idle({ waitsOnUnderway: true, decisionCardOpen: true })).toBe("captain");
    // Like every moving witness, it reads before a card the gate owes.
    expect(idle({ waitsOnUnderway: true, captainGateOwed: true })).toBe("moving");
  });

  it("a thread its account's cut-off holds is not nudged: nothing could answer it yet", () => {
    expect(idle({ threadAwaitingAuthor: true, accountHeld: true })).toBe("moving");
  });

  it("a thread whose computer is out of reach is not nudged: its answer comes once it is back", () => {
    expect(idle({ threadAwaitingAuthor: true, outOfReach: true })).toBe("moving");
  });

  it("a reply its lane will still deliver is not a stranded thread", () => {
    expect(idle({ threadAwaitingAuthor: true, deliverable: true })).toBe("moving");
    expect(idle({ threadAwaitingAuthor: true, deliverable: true, decisionCardOpen: true })).toBe(
      "captain",
    );
  });

  it("agrees with the sort on every witness the two share", () => {
    const shared: Array<[Partial<Witnesses>, ReportSortRule, IdleTurn]> = [
      [{ threadAwaitingAuthor: true }, "thread-unanswered", "thread"],
      [{ decisionCardOpen: true }, "captain-card", "captain"],
      [{ timedWait: true }, "still-moving", "moving"],
      [{ checksWatched: true }, "still-moving", "moving"],
      [{ accountHeld: true }, "still-moving", "moving"],
      [{ accountHeld: true, captainGateOwed: true }, "captain-gate", "owed"],
      [{ outOfReach: true }, "still-moving", "moving"],
      [{ outOfReach: true, captainGateOwed: true }, "captain-gate", "owed"],
      [{ captainGateOwed: true }, "captain-gate", "owed"],
      [{}, "stopped", "nobody"],
    ];
    for (const [over, rule, turn] of shared) {
      expect(sortReport(facts({ ...over, workObservable: true })).rule).toBe(rule);
      expect(idle(over)).toBe(turn);
    }
  });
});
