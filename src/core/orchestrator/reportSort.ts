/**
 * The whose-turn rule (S7c, captain call C7 A - heuristics only; the
 * restated rule at the end of the scout report's R4.8). A crewmate's report
 * used to be handed to a second Pi session that read its words and voted
 * routine-or-captain. That session is retired: what the Firstmate actually
 * needs from a report is not a reading of its prose but an answer to one
 * question the host can settle from typed state - whose turn is it now?
 *
 * The answers, in order, each a branch of `sortReport`:
 *
 *  0. The captain wrote the newest message in one of this task's card
 *     threads (cards-as-threads phase 1): the CREWMATE's turn, because the
 *     author owes him an answer. It outranks the open-card branch below
 *     deliberately - the captain has spoken since that card went up, so the
 *     card no longer holds the turn.
 *  0a. The report declared that the Firstmate must act (FI3-710): wake, on
 *     any backend and whatever card is up. The crewmate's typed request -
 *     a captain decision only the Firstmate can carry out, such as a build
 *     approved by reply - never a reading of its words. After row 0, so
 *     the captain's reply is answered first; before every row that would
 *     otherwise hold the report quiet.
 *  1. An open DECISION card for the task: the CAPTAIN's turn. No wake; the
 *     report is already a feed line and the click returns to its author.
 *     A note never holds the turn on its own (R4.8 question 1 - a crewmate
 *     may post an FYI and keep working), so only a card with actions
 *     counts - or a wait on the captain its crewmate declared in a report,
 *     which places the task's captain gate (FI3-435).
 *  1a. The report declared the work finished - the captain has read its
 *     outcome and nothing is left (FI3-435): wake, so the Firstmate closes
 *     the task. The crewmate's declaration, never a reading of its words.
 *  2. The report filed follow-ups this turn: wake, as before. The filings
 *     ride the report wake and are the Firstmate's to triage.
 *  2a. The task waits on work nobody has started (FI3-671): a task its
 *     standing baseline wait names, or a blocker holding its close, that
 *     only a start begins. Wake on any backend: only the Firstmate (or the
 *     captain) can start it, and the wake names it.
 *  3. The crewmate is provably still moving - a job running inside its
 *     bound, guidance its lane will still deliver, a captured settle, a
 *     timed wait on its gate, or a wait on work underway (FI3-250) whose
 *     close the sweep turns into its steer: the CREWMATE's turn. No wake;
 *     its next report runs this rule again.
 *  4. The task is held for the captain by its gate and no card is up (a
 *     round cap before the Firstmate's card): the FIRSTMATE's turn, which
 *     owes that card. Wake. Never the crewmate's - it cannot act.
 *  4b. A declared internal step has reported its answer, with no witness
 *     holding its turn: the FIRSTMATE's turn. Wake on any backend so it
 *     can start the next step; the report is the step's deliverable.
 *  5. The crewmate is provably stopped: NOBODY's turn. Wake now, with the
 *     report's own words. This is the stuck, blocked, and
 *     finished-with-no-card case - the one the captain named.
 *  6. The host cannot tell, because the backend runs its own background
 *     work (Claude): no wake now. The idle ladder's clock covers it - if
 *     nothing moves the task, its first rung acts ten minutes later.
 *
 * Only a backend whose background work is the HOST's own can reach step 5:
 * Pi's bash is a host tool, so a running job is in the job registry and its
 * exit is a lane row - all four witnesses are complete and "nothing will
 * ever start its next turn" is provable. A client-side backend gets step 6
 * instead, and so does a task with no transport at all: not knowing is its
 * own answer, and the clock is the safe side of it.
 *
 * The same witnesses, read the same way, decide the idle ladder's turn
 * (`idleTurn` below, `IdleLadder.reconcileIdle`, docs/report-sort.md): a
 * report is one idle boundary, and the ladder reads every idle record on
 * every tick. One gatherer (`IdleLadder.witnesses`) collects them for both.
 *
 * Pure and DOM-free on purpose: the supervisor gathers the facts, this
 * decides, and `reportSort.test.ts` walks the branches as a table.
 */

/** Which branch answered; stamped on the record as `rule:<id>` (R4.4). */
export type ReportSortRule =
  | "thread-unanswered"
  | "needs-firstmate"
  | "captain-card"
  | "finished"
  | "filed-followups"
  | "waits-unstarted"
  | "still-moving"
  | "captain-gate"
  | "step-answered"
  | "stopped"
  | "cannot-tell";

/**
 * The idle ladder's rungs, the job bound and the cut-off wakes
 * (docs/report-sort.md), recorded the same way when they act: the nudge to
 * the crewmate, the wake to the Firstmate and its repeat, the host's own
 * card, a background job past its bound, and an account whose crewmates a
 * cut-off paused, or let go on.
 */
export type IdleRule =
  | "idle-nudge"
  | "idle-wake"
  | "idle-repeat"
  | "idle-card"
  | "job-bound"
  | "provider-cut-off"
  | "provider-back";

/** The verdict vocabulary is unchanged (R4.4): the record still reads the same. */
export type ReportVerdict = "routine" | "captain";

/**
 * The witness set (docs/report-sort.md): the typed facts that say a task is
 * moving or is someone's turn. Gathered in one place (`IdleLadder.witnesses`)
 * and read by both the report's sort and the idle ladder, so a new witness
 * is added once and read the same way everywhere.
 */
export type Witnesses = {
  /**
   * A current open card waits for its author's answer
   * (`CardStore.awaitingAuthor`), not merely a historical captain message.
   */
  threadAwaitingAuthor: boolean;
  /**
   * A card with actions is open on the task (`cardWord` === "decision"),
   * whoever wrote it, or the task's captain gate names an open card, or its
   * crewmate's last report declared a wait on the captain (FI3-435), or its
   * browser is in the captain's hands (`browserWithCaptain`).
   */
  decisionCardOpen: boolean;
  /** Its crewmate's last report declared a wait on the captain (counted in `decisionCardOpen`). */
  captainWait?: boolean;
  /**
   * Its crewmate's last report asked the Firstmate to act (`needs_firstmate`,
   * FI3-710), and the Firstmate has not acted on the task since
   * (`IdleLadder.firstmateActedSince`; FI3-714). The idle ladder alone reads
   * it: the report's sort reads the report's own declaration.
   */
  askedFirstmate?: boolean;
  /**
   * The task's browser is paused for the captain's help or under his
   * control (docs/task-browser.md, "Taking control"): his Return control is
   * the crewmate's next wake (counted in `decisionCardOpen`).
   */
  browserWithCaptain?: boolean;
  /**
   * The task's gate holds it for the captain and no card is behind it: the
   * Firstmate owes the card (a round cap before its decision card).
   */
  captainGateOwed: boolean;
  /**
   * Guidance its lane will still deliver, including a row waiting out the
   * honest retry's backoff (`InboxStore.hasDeliverable`).
   */
  deliverable: boolean;
  /** A background job is running for the task inside its bound (`JOB_BOUND_MS`). */
  jobsRunning: boolean;
  /** A settle captured this idle boundary (`pendingSettle`). */
  pendingSettle: boolean;
  /** A timed wait on the task's gate (`at-time`): the sweep clears it into a steer. */
  timedWait: boolean;
  /**
   * The host is watching checks or a named run (`ciWatch` / `runWatches`):
   * its next named wake is the crewmate's next turn (docs/forge.md).
   */
  checksWatched: boolean;
  /**
   * A typed cut-off stands on the task's account (the cut-off contract):
   * its lane waits on the account, which speaks for it, and goes on when
   * the cut-off ends (`IdleLadder.cutOffHolds`).
   */
  accountHeld: boolean;
  /**
   * The task runs on a computer that runs work which is out of reach, or
   * back and not yet caught up (docs/helper.md, "Holding a conversation"):
   * its turn goes on there unseen, and its lane goes on once it is back
   * (`CrewSupervisor.outOfReach`). Read like `accountHeld`.
   */
  outOfReach?: boolean;
  /**
   * The task waits on work only a start begins (FI3-671): a task its
   * standing baseline wait names, or a blocker holding its close
   * (`IdleLadder.unstartedWaits`). The report's sort alone reads it; the
   * idle ladder's turn does not.
   */
  waitsOnUnstarted: boolean;
  /**
   * The task waits on work underway or queued to start by itself, and on
   * nothing nobody has started (FI3-250; `IdleLadder.underwayWaits`): it
   * moves again when that work closes, whose close the ready sweep turns
   * into one steer on its lane.
   */
  waitsOnUnderway?: boolean;
};

export type ReportSortFacts = Witnesses & {
  /** The turn filed follow-ups (`filedThisTurn`). */
  filedFollowups: boolean;
  /** The report declared its work finished (the report tool's `finished`). */
  finished?: boolean;
  /** The report declared that the Firstmate must act (the report tool's `needs_firstmate`). */
  needsFirstmate?: boolean;
  /**
   * Whether every way this crewmate's work continues is visible to the
   * host (`ControlProfile.backgroundWork === "host"`). False for a
   * client-side backend and for a task whose transport is gone.
   */
  workObservable: boolean;
  /** The Firstmate declared this task an internal step (`shape.internal_step`). */
  internalStep?: boolean;
};

export type ReportSortResult = {
  rule: ReportSortRule;
  verdict: ReportVerdict;
  /** Wake the Firstmate now, with the report's own words. */
  wake: boolean;
  /** The record's summary: why this report was sorted the way it was. */
  reason: string;
};

export function sortReport(facts: ReportSortFacts): ReportSortResult {
  if (facts.threadAwaitingAuthor) {
    return {
      rule: "thread-unanswered",
      verdict: "routine",
      wake: false,
      reason:
        "the captain replied in this task's card thread and has no answer yet; the crewmate's turn.",
    };
  }
  if (facts.needsFirstmate) {
    return {
      rule: "needs-firstmate",
      verdict: "captain",
      wake: true,
      reason:
        "the crewmate declared that the first mate must act on its report; the first mate's turn.",
    };
  }
  if (facts.decisionCardOpen) {
    return {
      rule: "captain-card",
      verdict: "routine",
      wake: false,
      reason: facts.captainWait
        ? "its crewmate declared that it waits on the captain; the next move is his."
        : facts.browserWithCaptain
          ? "its browser is in the captain's hands until he returns control; the next move is his."
          : "a decision card for this task is on the captain's screen; the next move is his.",
    };
  }
  if (facts.finished) {
    return {
      rule: "finished",
      verdict: "captain",
      wake: true,
      reason:
        "the crewmate declared its work finished and read by the captain; the first mate closes it.",
    };
  }
  if (facts.filedFollowups) {
    return {
      rule: "filed-followups",
      verdict: "captain",
      wake: true,
      reason: "the report filed follow-ups; they are the first mate's to triage.",
    };
  }
  if (facts.waitsOnUnstarted) {
    return {
      rule: "waits-unstarted",
      verdict: "captain",
      wake: true,
      reason: "it waits on work nobody has started; only the first mate or the captain starts it.",
    };
  }
  if (stillMoving(facts)) {
    return {
      rule: "still-moving",
      verdict: "routine",
      wake: false,
      reason: facts.jobsRunning
        ? "a background job is still running; the crewmate's turn continues."
        : facts.deliverable
          ? "guidance is already pending on this task; the crewmate's turn continues."
          : facts.pendingSettle
            ? "a settle holds this boundary; the crewmate's turn continues."
            : facts.checksWatched
              ? "the host is watching its change's checks; the crewmate's turn continues when they finish."
              : facts.waitsOnUnderway
                ? "it waits on work underway; the crewmate's turn continues when that work closes."
                : "a timed wait holds this task; the crewmate's turn continues when it ends.",
    };
  }
  if (facts.captainGateOwed) {
    return {
      rule: "captain-gate",
      verdict: "captain",
      wake: true,
      reason: "the task is held for the captain and no card is up; the first mate owes the card.",
    };
  }
  // A cut-off holds only the crewmate's own turn: a card the Firstmate owes
  // is still owed, so the gate is read first.
  if (facts.accountHeld) {
    return {
      rule: "still-moving",
      verdict: "routine",
      wake: false,
      reason: "its account is cut off; the crewmate's turn continues when it serves again.",
    };
  }
  // So does a computer out of reach: the turn goes on there.
  if (facts.outOfReach) {
    return {
      rule: "still-moving",
      verdict: "routine",
      wake: false,
      reason:
        "the computer it runs on is out of reach; its turn continues there and catches up here when it is back.",
    };
  }
  if (facts.internalStep) {
    return {
      rule: "step-answered",
      verdict: "captain",
      wake: true,
      reason: "the internal step reported its answer; the first mate decides the next step.",
    };
  }
  if (facts.workObservable) {
    return {
      rule: "stopped",
      verdict: "captain",
      wake: true,
      reason: "the crewmate stopped with nothing running and nothing queued; nobody's turn.",
    };
  }
  return {
    rule: "cannot-tell",
    verdict: "routine",
    wake: false,
    reason: "this backend runs its own background work; the idle clock watches it instead.",
  };
}

/** Moving on its own: nobody needs to act for its next turn to start. */
function stillMoving(witnesses: Witnesses): boolean {
  return (
    witnesses.jobsRunning ||
    witnesses.deliverable ||
    witnesses.pendingSettle ||
    witnesses.timedWait ||
    witnesses.checksWatched ||
    witnesses.waitsOnUnderway === true
  );
}

/**
 * Whose turn an IDLE crewmate's is, from the same witnesses in the same
 * order as `sortReport` (docs/report-sort.md, "The idle ladder"):
 *
 *  - `thread`: the captain wrote last under one of its cards and nothing
 *    deliverable will answer him - nobody's turn, and the nudge says reply.
 *    Before the card check, as row 0 outranks row 1 in the sort.
 *  - `asked`: its crewmate's request that the Firstmate act still stands
 *    unanswered (FI3-714) - the Firstmate's turn, whatever card is up or
 *    whatever still moves, as row 0a outranks them in the sort; after an
 *    unanswered captain reply, which the crewmate answers first.
 *  - `captain`: a card with actions is up - nothing fires.
 *  - `moving`: it will move on its own - nothing fires.
 *  - `owed`: held for the captain with no card up - the Firstmate's turn,
 *    so the ladder's wakes and its card apply and its nudge never does.
 *    Before a cut-off on its account, which holds only the crewmate's turn.
 *  - `nobody`: the ladder climbs from its nudge.
 */
export type IdleTurn = "thread" | "asked" | "captain" | "moving" | "owed" | "nobody";

export function idleTurn(witnesses: Witnesses): IdleTurn {
  // A lane its account holds cannot answer either way: a nudge would only
  // wait on the lane, and the account's wakes already speak for it.
  if (
    witnesses.threadAwaitingAuthor &&
    !witnesses.deliverable &&
    !witnesses.accountHeld &&
    !witnesses.outOfReach
  ) {
    return "thread";
  }
  // The crewmate answers a reply the captain wrote since its request first,
  // as row 0 holds row 0a; the reply on its lane is that answer coming.
  if (witnesses.askedFirstmate && !witnesses.threadAwaitingAuthor) return "asked";
  if (witnesses.decisionCardOpen) return "captain";
  if (stillMoving(witnesses)) return "moving";
  if (witnesses.captainGateOwed) return "owed";
  if (witnesses.accountHeld || witnesses.outOfReach) return "moving";
  return "nobody";
}
