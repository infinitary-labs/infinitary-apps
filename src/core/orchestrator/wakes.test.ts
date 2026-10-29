import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { CHECK_DIAGNOSIS_NEXT } from "./checkRepair";
import { idleStallWays } from "./holds";
import { REVIEW_FIX_RULES, renderRigorSection } from "./intentBrief";
import {
  answerMissingWake,
  answerRepairOnce,
  BROWSER_GONE_OPENING,
  captainTurn,
  ciCapWake,
  drainWakes,
  IDLE_ANSWER_NUDGE_TEXT,
  IDLE_NUDGE_TEXT,
  IDLE_STEP_NUDGE_TEXT,
  IDLE_THREAD_NUDGE_TEXT,
  idleNudge,
  isCardClosedSteer,
  jobBoundWake,
  providerBackWake,
  providerCutOffWake,
  REVIEW_NEW_HEAD_NEXT,
  REVIEW_PASSED_NEXT,
  REVIEWER_IDLE_NEXT,
  renderWake,
  reviewCapWake,
  reviewFindingsNext,
  STALL_RECOVERY_GUIDANCE,
  stillDownWake,
  type WakeFacts,
} from "./wakes";

describe("renderWake", () => {
  it("INF-1554 F4/F5: emits combined recovery guidance once and omits empty findings", () => {
    const facts: Extract<WakeFacts, { kind: "report" }> = {
      kind: "report",
      task: { id: "t1", title: "Recover the branch" },
      crewmate: "crewmate 1",
      excerpt: "The host record still blocks the same step.",
      filed: [],
      cards: [],
      stall: {
        kind: "repeated-wait",
        observation: "The running app still refuses this task's record",
      },
      recoveryWays: [
        {
          action: "Take over the branch",
          approach: "workaround",
          hold: "waits",
          basis: "record",
          needsConsent: false,
          evidence: "The host owns the refusal",
          nextFact: "The successor starts",
        },
      ],
    };
    const combined = renderWake({ facts });
    expect(combined).toContain("Typed stall:");
    expect(combined).toContain("Recovery ways");
    expect(combined.split(STALL_RECOVERY_GUIDANCE)).toHaveLength(2);
    const empty = renderWake({ facts: { ...facts, stall: undefined, recoveryWays: [] } });
    expect(empty).not.toContain("Recovery ways");
    expect(empty).not.toContain(STALL_RECOVERY_GUIDANCE);
  });

  // Source: the captain's fix-and-rerun choice on INF-1641, after a live first mate
  // started a recovery way and recorded it but ended its turn without reading it back.
  it("asks for a recovery way's result to be read back in the turn that took it", () => {
    const wake = renderWake({
      facts: {
        kind: "report",
        task: { id: "t1", title: "Recover the branch" },
        crewmate: "crewmate 1",
        excerpt: "The host record refused the delivery step again.",
        filed: [],
        cards: [],
        stall: { kind: "repeated-wait", observation: "The same host-record wait" },
      },
    });
    expect(wake).toContain(
      "record it with update_task verdict, then in the same turn read the result through tasks/crew_status or its owner.",
    );
  });

  it("serves prose as itself, from a body or a row", () => {
    expect(renderWake("[fm-op] a background job finished")).toBe(
      "[fm-op] a background job finished",
    );
    expect(renderWake({ text: "keep going" })).toBe("keep going");
  });

  // INF-87 R7: legacy answer records may have no human-readable task key.
  it.each(["", "SCR-7"])("recovers an answer by its key or id (%s)", (key) => {
    const text = renderWake({
      facts: {
        kind: "answer-closed",
        handoff: {
          version: 1,
          event: "answer_task_closed",
          task: { id: "plan-id", key, title: "The accepted plan" },
          card: { id: "card-plan", title: "Build the plan" },
          choice: { id: "build", label: "Approve and build", effect: null },
          close: { status: "done", reason: "answered", actor: "captain" },
        },
      },
    });
    expect(JSON.parse(text.slice("[fm-op] ".length)).read).toEqual({
      tool: "tasks",
      arguments: { key: key || "plan-id" },
    });
  });

  it("renders the nudge to the words the crewmate has always been sent", () => {
    expect(renderWake(idleNudge())).toBe(IDLE_NUDGE_TEXT);
    expect(renderWake(idleNudge(true))).toBe(IDLE_THREAD_NUDGE_TEXT);
  });

  it("names a note up on the task in the nudge, so a crewmate is never asked to post its outcome again (FI3-438)", () => {
    const note = { id: "card-t1-out", title: "Released 0.1.30" };
    expect(renderWake(idleNudge(false, note))).toBe(
      'You stopped with nothing running, and the note "Released 0.1.30" (card-t1-out) is up, asking the captain nothing. If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again. Otherwise either finish - report under the five headings and emit your completion card - or say what blocks you.',
    );
    // The captain's words in a thread come first: that nudge carries no note.
    expect(idleNudge(true, note).facts).toEqual({ kind: "idle-nudge", thread: true });
    expect(renderWake(idleNudge(true, note))).toBe(IDLE_THREAD_NUDGE_TEXT);
  });

  // INF-1732: an answer task's crewmate is asked for the finished flag, the
  // fallback that closes it, never a completion card its brief forbids.
  it("asks an answer task for finished, with the step's and the thread's words outranking it (INF-1732)", () => {
    expect(renderWake(idleNudge(false, undefined, false, [], true))).toBe(IDLE_ANSWER_NUDGE_TEXT);
    expect(IDLE_ANSWER_NUDGE_TEXT).toContain("report with finished true");
    const note = { id: "card-t1-answer", title: "The answer" };
    const noted = renderWake(idleNudge(false, note, false, [], true));
    expect(noted).toContain("report with waiting_on_captain naming it");
    expect(noted).toContain("report with finished true");
    expect(noted).not.toContain("completion card -");
    expect(renderWake(idleNudge(false, undefined, true, [], true))).toBe(IDLE_STEP_NUDGE_TEXT);
    expect(renderWake(idleNudge(true, undefined, false, [], true))).toBe(IDLE_THREAD_NUDGE_TEXT);
  });

  it("names finished when the captain closes a card on an answer task without choosing (INF-1732)", () => {
    const card = { id: "card-t1-answer", title: "The answer" };
    const plain = renderWake({ facts: { kind: "card-closed", card } });
    const answer = renderWake({ facts: { kind: "card-closed", card, answer: true } });
    expect(plain).toBe(
      'The captain closed your card "The answer" (card-t1-answer) without choosing.',
    );
    expect(answer.startsWith(plain)).toBe(true);
    expect(answer).toContain("report with finished true");
    expect(isCardClosedSteer(answer)).toBe(true);
  });

  it("says a note is up in the stall wake, never that no card is (FI3-438)", () => {
    const text = renderWake({
      facts: {
        kind: "idle-stall",
        task: { id: "t1", title: "Release 0.1.30" },
        crewmate: "crewmate 1",
        key: "FI3-7",
        idleMs: 25 * 60_000,
        thread: false,
        nudged: true,
        wakes: 1,
        note: { id: "card-t1-out", title: "Released 0.1.30" },
      },
      ways: idleStallWays("t1"),
    });
    expect(text.split("\n")[0]).toBe(
      '[fm-op] crewmate 1 on task t1 "Release 0.1.30" has been idle for 25m with nothing running, nothing queued and only the note "Released 0.1.30" (card-t1-out) up, which asks the captain nothing; the host\'s nudge did not move it. If that note is its outcome, steer it to report waiting on the captain naming the note, never to post it again.',
    );
    expect(text).not.toContain("no card up");
  });

  it("names the work a report's task waits on that nothing starts, as facts beside its filings (FI3-671)", () => {
    const report = (waits?: Extract<WakeFacts, { kind: "report" }>["waits"]) =>
      renderWake({
        facts: {
          kind: "report",
          task: { id: "t1", title: "Fix the meter" },
          crewmate: "crewmate 1",
          excerpt: "Blocked by a baseline failure.",
          filed: [{ key: "SCR-3", title: "Unblock", blocks: true }],
          ...(waits ? { waits } : {}),
          cards: [],
        },
      });
    expect(
      report([
        { key: "SCR-3", title: "Unblock", state: "not-started" },
        { key: "SCR-2", title: "Fix main", state: "dropped" },
      ]),
    ).toBe(
      '[fm-op] crewmate 1 reported on task t1 "Fix the meter": Blocked by a baseline failure. Filed this turn: SCR-3 "Unblock" (blocks this task). Each waits on request, discovered from this task. It waits on SCR-3 "Unblock" (not started), SCR-2 "Fix main" (dropped); nothing starts that work by itself.',
    );
    // No wait, no words: the wake reads as it always did.
    expect(report()).not.toContain("It waits on");
    expect(report([])).toBe(report());
  });

  // INF-735, the captain's "file a fix so a hold on another task's finding
  // ends when that task reports it": PR #184's task stayed held 2,393
  // minutes after INF-621 reported the finding it waited for. These words
  // are that rule's one home; whether the report carries the finding is the
  // first mate's judgment.
  it("names the started work held on a report's task and how its hold ends (INF-735)", () => {
    const report = (waiting?: Extract<WakeFacts, { kind: "report" }>["waiting"]) =>
      renderWake({
        facts: {
          kind: "report",
          task: { id: "438d43ea", title: "Prove the shared Mac image" },
          crewmate: "crewmate 9",
          // INF-621's report at 2:54 PM (event 91322), its closing sentence.
          excerpt:
            "PR #184's verdict remains the captured native readiness race and a controlled rerun, not an Escape-code rewrite.",
          filed: [],
          ...(waiting ? { waiting } : {}),
          cards: [],
        },
      });
    const inf595 = {
      id: "d8f35ffa",
      key: "INF-595",
      title: "Fix: task board Escape skips the open summary under load",
    };
    expect(report([inf595])).toBe(
      `[fm-op] crewmate 9 reported on task 438d43ea "Prove the shared Mac image": PR #184's verdict remains the captured native readiness race and a controlled rerun, not an Escape-code rewrite. Started work waits on this task through your link: INF-595 "Fix: task board Escape skips the open summary under load". If this report carries what such work waits for, such as a finding or an answer, pass it on now with steer_crewmate and end that wait with link_tasks remove; a wait on this task's merge stays.`,
    );
    expect(
      report([
        inf595,
        { id: "8bc93cc7", key: "INF-660", title: "Move phone checks off the Mac check lock" },
      ]),
    ).toContain(
      `through your link: INF-595 "Fix: task board Escape skips the open summary under load", INF-660 "Move phone checks off the Mac check lock". If this report`,
    );
    // Nothing held on it, no words: the wake reads as it always did.
    expect(report()).not.toContain("waits on this task");
    expect(report([])).toBe(report());
  });

  it("ends a report with the app's recorded checks when its task has a reading", () => {
    const report = (ci?: Extract<WakeFacts, { kind: "report" }>["ci"]) =>
      renderWake({
        facts: {
          kind: "report",
          task: { id: "t1", title: "Fix the meter" },
          crewmate: "crewmate 1",
          excerpt: "Opened the pull request.",
          filed: [],
          cards: [],
          ...(ci ? { ci } : {}),
        },
      });
    expect(
      report({
        overall: "pending",
        readAt: "2026-10-09T11:57:00.000Z",
        ageMinutes: 3,
        head: "abcdef1234",
      }),
    ).toBe(
      '[fm-op] crewmate 1 reported on task t1 "Fix the meter": Opened the pull request. The app\'s recorded checks: pending (read 3 min ago, head abcdef1); a merge rechecks them fresh.',
    );
    expect(report()).not.toContain("recorded checks");
  });

  it("names the crewmate by its task when no runtime holds it, and claims no nudge or last words it lacks", () => {
    const text = renderWake({
      facts: {
        kind: "idle-stall",
        task: { id: "t1", title: "Fix the pin" },
        key: "FI3-7",
        idleMs: 65 * 60_000,
        thread: false,
        nudged: false,
        wakes: 1,
      },
      ways: idleStallWays("t1"),
    });
    expect(text.split("\n")[0]).toBe(
      '[fm-op] the crewmate on FI3-7 on task t1 "Fix the pin" has been idle for 1h 5m with nothing running, nothing queued and no card up.',
    );
    expect(text.split("\n")[1]).toBe("```json");
  });

  it("words the outage and the job bound from their measurements, rounded as they always were", () => {
    const task = { id: "t1", title: "Fix the pin", key: "FI3-7" };
    const stillDown = (downMs: number) =>
      renderWake(stillDownWake(task, { since: 1_000, failures: 5 }, 1_000 + downMs));
    expect(stillDown(15.5 * 60_000)).toBe(
      '[fm-op] the crewmate on FI3-7 on task t1 "Fix the pin" is still failing at the provider after 16 minutes and 5 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.',
    );
    const job = { jobId: "poll-1", command: "gh run watch", startedAt: 1_000 };
    expect(renderWake(jobBoundWake(task, job, 1_000 + 3.25 * 3_600_000))).toBe(
      '[fm-op] task t1 "Fix the pin" has had a background job running for 3.3 hours: "gh run watch". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.',
    );
    // The once names: the outage by when it began, the job by its id and start.
    expect(stillDownWake(task, { since: 1_000, failures: 9 }, 9e6).once).toBe(
      stillDownWake(task, { since: 1_000, failures: 5 }, 2e6).once,
    );
    expect(jobBoundWake(task, job, 9e6).once).not.toBe(
      jobBoundWake(task, { ...job, startedAt: 2_000 }, 9e6).once,
    );
  });

  it("words an account's cut-off per class, naming every task it pauses and what ends it", () => {
    const account = { id: "acct_claude", provider: "Claude" };
    const tasks = [
      { id: "t1", title: "Fix the pin" },
      { id: "t2", title: "Tidy the docs" },
    ];
    const paused =
      'so the crewmates on it are paused: task t1 "Fix the pin", task t2 "Tidy the docs".';
    const after =
      "you will hear when it answers again. Nothing moves a crewmate to another model on its own: to go on sooner, spawn a follow-up on another model.";
    expect(renderWake(providerCutOffWake(account, { class: "refused", since: 5 }, tasks))).toBe(
      `[fm-op] Claude is refusing this sign-in, ${paused} Their guidance is kept, and nothing is sent to Claude until a different Claude account is signed in, its app is updated, or the captain asks to try again; ${after}`,
    );
    expect(renderWake(providerCutOffWake(account, { class: "signed_out", since: 5 }, tasks))).toBe(
      `[fm-op] Claude needs the captain to sign in again, ${paused} Their guidance is kept, and nothing is sent to Claude until the captain signs in again; ${after}`,
    );
    const spent = providerCutOffWake(
      account,
      { class: "no_headroom", since: 5, resetsAt: Date.parse("2026-09-27T18:00:00Z") },
      tasks,
    );
    expect(spent.facts).toMatchObject({ resetsAt: Date.parse("2026-09-27T18:00:00Z") });
    expect(renderWake(spent)).toBe(
      `[fm-op] Claude has used up this plan's allowance, ${paused} Their guidance is kept, and nothing is sent to Claude before it resets at 2026-09-27T18:00:00.000Z; ${after}`,
    );
    // A reset rides only a spent allowance.
    expect(
      providerCutOffWake(account, { class: "refused", since: 5, resetsAt: 9 }, tasks).facts,
    ).not.toHaveProperty("resetsAt");
  });

  it("words an account's return, with or without crewmates left waiting, once per cut-off", () => {
    const account = { id: "acct_claude", provider: "Claude" };
    expect(renderWake(providerBackWake(account, 5, [{ id: "t1", title: "Fix the pin" }]))).toBe(
      '[fm-op] Claude is answering again, so the crewmates paused on it go on: task t1 "Fix the pin". Their kept guidance goes out now.',
    );
    expect(renderWake(providerBackWake(account, 5, []))).toBe(
      "[fm-op] Claude is answering again; no crewmate is left waiting on it.",
    );
    // The once names: the cut-off by its account and start, its end by the same.
    const cutOff = providerCutOffWake(account, { class: "refused", since: 5 }, []);
    expect(cutOff.once).toBe(
      providerCutOffWake(account, { class: "refused", since: 5 }, [{ id: "t9", title: "x" }]).once,
    );
    expect(cutOff.once).not.toBe(
      providerCutOffWake(account, { class: "refused", since: 6 }, []).once,
    );
    expect(providerBackWake(account, 5, []).once).not.toBe(cutOff.once);
    expect(providerBackWake({ ...account, id: "acct_other" }, 5, []).once).not.toBe(
      providerBackWake(account, 5, []).once,
    );
  });

  // Accepted INF-1177: old typed notices cannot recreate retired count policy.
  it.each([
    "ci-cap",
    "review-cap",
    "delegated-review-cap",
    "idle-ci-cap",
    "idle-review-cap",
  ] as const)("serves a queued %s as history without an active count hold", (kind) => {
    const task = { id: "t1", title: "Fix the pin" };
    const wake =
      kind === "ci-cap"
        ? ciCapWake(task, { rounds: 3, cap: 3, headSha: "89abcdef0123" })
        : kind.startsWith("idle-")
          ? {
              facts: {
                kind: "idle-owed" as const,
                held: kind === "idle-ci-cap" ? ("ci-cap" as const) : ("review-cap" as const),
                task,
                idleMs: 60000,
                wakes: 1,
              },
            }
          : reviewCapWake(task, {
              rounds: 3,
              cap: 2,
              ...(kind === "delegated-review-cap" ? { owner: "firstmate" as const } : {}),
              findings: {
                kind: "review-verdict",
                task: { id: "r1", title: "Review" },
                builder: task,
                crewmate: "crewmate 2",
                verdict: "findings",
                excerpt: "F1 racy",
                cards: [],
              },
            });
    const body = renderWake(wake);
    expect(body).toContain(task.id);
    expect(body).toContain("count holds are retired");
    expect(body).toContain("grants no authorization");
    expect(body).not.toContain("until the captain answers");
    expect(body).not.toContain('"held":');
    if (kind === "review-cap" || kind === "delegated-review-cap") expect(body).toContain("F1 racy");
  });

  it("words each reviewed-tier step on the wake it arises on (FI3-566 cut C)", () => {
    const task = { id: "t1", title: "Fix the pin" };
    const review = { id: "r1", title: "Review: Fix the pin" };
    const verdict = (extra: { verdict?: "findings" | "blocked"; briefed?: boolean } = {}) =>
      renderWake({
        facts: {
          kind: "review-verdict",
          task: review,
          builder: task,
          crewmate: "crewmate 2",
          verdict: extra.verdict ?? "findings",
          excerpt: "verdict: findings F1 racy - auto-fix F2 copy - ask-user",
          cards: [],
          ...(extra.briefed === undefined ? {} : { briefed: extra.briefed }),
        },
      });
    // A builder briefed reviewed holds the fix rules: the findings are
    // relayed verbatim, ask-user ones decided or carded, the reviewer left idle.
    // INF-203 F2: changed proof facts also justify re-review, without a dummy commit.
    expect(verdict({ briefed: true })).toBe(
      "[fm-op] crewmate 2 reported on review task r1 \"Review: Fix the pin\" - the review of task t1 \"Fix the pin\" - with verdict findings: verdict: findings F1 racy - auto-fix F2 copy - ask-user Steer the builder with every auto-fix finding verbatim; its brief says how to fix them. Info findings never block and need no steer. Decide an ask-user finding yourself when the user's own words already settle it; the rest are ONE decision card per round on the builder's task, with the step you would take as its default. Pass review_task_id naming this review. Start the title with Review of the builder's key; name the change in the first line. For each finding, show its number, severity, file and reviewed version above the reviewer's verbatim words. Steer a reviewer only to re-review at a new head, evidence revision or validation state its builder reports (including a captain-granted gap exception or a new effect request) - an idle reviewer needs no stand-by and no status.",
    );
    expect(renderRigorSection("reviewed")).toContain(REVIEW_FIX_RULES);
    expect(verdict({ verdict: "blocked", briefed: true }).endsWith(reviewFindingsNext(true))).toBe(
      true,
    );
    // A builder whose care rose after its brief, or a row an older build
    // queued, never read the rules: the steer carries them.
    expect(verdict({ briefed: false }).endsWith(reviewFindingsNext(false))).toBe(true);
    expect(verdict()).toBe(verdict({ briefed: false }));
    expect(reviewFindingsNext(false)).toContain(
      `Steer the builder with every auto-fix finding verbatim, prefixed with - ${REVIEW_FIX_RULES}.`,
    );
    // A builder's report names its open review and the re-review a new head asks for.
    const report = (open?: { key: string; verdict: "findings" | "blocked"; head?: string }) =>
      renderWake({
        facts: {
          kind: "report",
          task,
          crewmate: "crewmate 1",
          excerpt: "Fixed F1; committed 89abcde.",
          filed: [],
          cards: [],
          ...(open ? { review: open } : {}),
        },
      });
    expect(report({ key: "FI3-9", verdict: "findings", head: "0123456789ab" })).toBe(
      `[fm-op] crewmate 1 reported on task t1 "Fix the pin": Fixed F1; committed 89abcde. Its open review FI3-9 last returned findings at 0123456. ${REVIEW_NEW_HEAD_NEXT}`,
    );
    expect(REVIEW_NEW_HEAD_NEXT).toBe(
      "When this report brings a new head, evidence revision or validation state (including a captain-granted gap exception or a new effect request), steer that reviewer to re-review those exact facts. The app writes what was decided so far, the captain's answers included, into every reviewer turn, so never retype declined findings into the steer. Never steer the reviewer otherwise - an idle reviewer needs no stand-by and no status.",
    );
    expect(report({ key: "FI3-9", verdict: "blocked" })).toContain(
      "Its open review FI3-9 last returned blocked at an unrecorded head.",
    );
    expect(report()).toBe(
      '[fm-op] crewmate 1 reported on task t1 "Fix the pin": Fixed F1; committed 89abcde.',
    );
    // A reviewer's acknowledgment asks for no stand-by steer.
    expect(
      renderWake({
        facts: {
          kind: "review-unstated",
          task: review,
          builder: task,
          crewmate: "crewmate 2",
          excerpt: "Standing by.",
        },
      }),
    ).toBe(
      `[fm-op] crewmate 2 reported on review task r1 "Review: Fix the pin" - the review of task t1 "Fix the pin" - with no verdict line, so no verdict was recorded: Standing by. ${REVIEWER_IDLE_NEXT}`,
    );
    // A pass sends the builder to push, open its PR and drive CI green.
    expect(
      renderWake({
        facts: {
          kind: "review-passed",
          task,
          reviewKey: "FI3-9",
          crewmate: "crewmate 2",
          head: "0123456789ab",
          risk: "low",
          derived: false,
          excerpt: "verdict: pass",
        },
      }),
    ).toBe(
      '[fm-op] the review of task t1 "Fix the pin" passed at 0123456 (risk low); the hold is released and review task FI3-9 is closed. crewmate 2\'s report: verdict: pass Steer the builder to push, open the PR and drive CI green; its PR report is then handled like any other.',
    );
    expect(REVIEW_PASSED_NEXT).toBe(
      "Steer the builder to push, open the PR and drive CI green; its PR report is then handled like any other.",
    );
  });

  /** A Firstmate lane holding one raw payload, as a build wrote it to the column. */
  function laneWith(payload: object) {
    const db = openInMemoryDatabase();
    db.prepare(
      "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(FIRSTMATE_RECIPIENT, JSON.stringify(payload), 1_000, "t1", "h", "crewmate-report");
    return new InboxStore(db).pending(FIRSTMATE_RECIPIENT, 2_000);
  }

  it("drains queued review findings without reviving their retired cap", () => {
    const rows = laneWith({
      v: 1,
      facts: {
        kind: "review-cap",
        task: { id: "t1", title: "Fix" },
        rounds: 3,
        cap: 2,
        report:
          '[fm-op] crewmate 2 reported on review task r1 "Review: Fix": verdict: findings F1 racy',
      },
      ways: [],
    });
    const body = drainWakes(rows)[0]?.body;
    expect(body).toContain("count holds are retired");
    expect(body).toContain(
      '[fm-op] crewmate 2 reported on review task r1 "Review: Fix": verdict: findings F1 racy',
    );
    expect(body).not.toContain("no more re-reviews go out");
  });

  it("serves a known kind whose facts it cannot word as data, so the lane still drains", () => {
    const facts = { kind: "review-verdict", task: { id: "r1", title: "Review" } };
    const rows = [...laneWith({ v: 1, facts }), ...laneWith({ v: 1, text: "[fm-op] next" })];
    expect(drainWakes(rows).map((wake) => wake.body)).toEqual([
      `[fm-op] a wake this version cannot word:\n\`\`\`json\n${JSON.stringify({ facts }, null, 2)}\n\`\`\``,
      "[fm-op] next",
    ]);
  });

  it('words the check watch\'s end for each way it ends (docs/forge.md, "The check watch")', () => {
    const settled = (facts: Omit<Extract<WakeFacts, { kind: "checks-settled" }>, "kind">) =>
      renderWake({ facts: { kind: "checks-settled", ...facts } });
    const checks = [{ name: "lint", state: "failure" }];
    const finished = settled({ outcome: "finished", change: "PR #7", head: "cafe0001", checks });
    expect(finished).toContain("lint (failure)");
    // Captain INF-1555 F12: facts lead to an offer, not a second readiness declaration.
    expect(finished).toContain("offer its merge when ready");
    for (const outcome of ["passed", "failed", "not-green"] as const) {
      const facts = {
        outcome,
        change: "PR #7",
        head: "cafe0001",
        checks,
        cap: { rounds: 3, cap: 3 },
      };
      const body = settled(facts);
      expect(body).toContain(JSON.stringify({ kind: "checks-settled", ...facts }));
      expect(body).toContain("history, not a current readiness verdict");
      expect(body).toContain("counts are retired and place no hold");
      expect(body).not.toContain("stop here");
    }
    // The sign-in problem already says what to do; nothing is added to it.
    expect(
      settled({
        outcome: "unreadable",
        problem: "Not signed in to GitHub (github.com). Report this as a blocker.",
        signIn: true,
      }),
    ).toBe(
      "The app could not read the checks on your pull request, so it stopped watching them: Not signed in to GitHub (github.com). Report this as a blocker.",
    );
  });

  it('words the captain\'s return of a task\'s browser, with what the crewmate said it would do and what an unconfirmed submission asks (docs/task-browser.md, "Taking control", "A final submission")', () => {
    expect(renderWake({ facts: { kind: "browser-returned", site: "localhost:5173" } })).toBe(
      "The captain returned control of this task's browser, on localhost:5173. Your earlier refs are gone: run `infinitary-browser-axi` for a fresh look at the page as it is now, including anything the captain signed in to, and check what changed before you carry on. If you asked the captain to pay or submit something, read what the page says happened and keep only the result, such as a reference. If the page does not confirm it - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain on a card to check in the browser. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again. Returning control gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.",
    );
    expect(
      renderWake({
        facts: {
          kind: "browser-returned",
          site: "aurora.example",
          after: "fill in the passenger details.",
        },
      }),
    ).toContain(
      "You said that next you would: fill in the passenger details. If you asked the captain to pay",
    );
  });

  it('words a saved sign-in the captain let the task use, and what to do when the site turns it away (docs/task-browser.md, "Saved sign-ins")', () => {
    const words = renderWake({
      facts: { kind: "browser-returned", site: "aurora.example", saved: true },
    });
    expect(words).toBe(
      "The captain let this task use the sign-in saved on this computer for aurora.example, and your browser is yours again: its page reloaded with that sign-in. Your earlier refs are gone: run `infinitary-browser-axi` for a fresh look at the page as it is now, and check that it is signed in before you carry on. If the site still asks for a sign-in, it did not take the saved one: ask the captain again on a card, and the captain signs in. A saved sign-in gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.",
    );
  });

  it('words an open-browser choice whose browser was gone, how to ask anew, and never the action (docs/task-browser.md, "Asking for help")', () => {
    const facts = {
      kind: "card-choice" as const,
      to: "crewmate" as const,
      source: "chrome" as const,
      card: { title: "The payment on aurora.example is unknown" },
      choice: { id: "use-saved-sign-in", label: "Use my saved aurora.example sign-in" },
    };
    const quit = renderWake({ facts: { ...facts, browserGone: "quit" } });
    expect(quit).toBe(
      'The captain chose to open your browser from your card "The payment on aurora.example is unknown", but the browser that card named stopped when Infinitary quit, so the captain got no page and nothing the card asked for was done there. Nothing from that browser was kept, and any browser you have now is a newer one. If you still need the captain on the page, open the site again with `infinitary-browser-axi open <url>` and ask again on a new card with browser_handoff. If the card was about something whose outcome is unknown, such as a payment the site never confirmed, it still is: never submit, reload or resend it, and check where the site lists it, such as its bookings, before you ask. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again.',
    );
    expect(quit.startsWith(BROWSER_GONE_OPENING)).toBe(true);
    // A saved sign-in the host offered stays unnamed.
    expect(quit).not.toContain("aurora.example sign-in");
    expect(renderWake({ facts: { ...facts, browserGone: "stopped" } })).toContain(
      "but the browser that card named had stopped, so the captain got no page",
    );
    // The answers a footer click carried still reach it.
    expect(
      renderWake({
        facts: {
          ...facts,
          browserGone: "stopped",
          choice: {
            id: "check",
            label: "Open browser and check",
            answers: [
              { name: "card", values: ["visa"], labels: ["Visa ending 4242"], changed: true },
            ],
          },
        },
      }),
    ).toContain(
      `trying again.\nThe user's answers to the card's questions:\n- card: "Visa ending 4242" (visa), changed`,
    );
  });

  it("words a card choice's answers from the label bound to each pick, else its value (contract 4.22)", () => {
    const answers = [
      {
        name: "read-scope",
        values: ["all-visible"],
        labels: ["Every project your sign-in can see"],
        changed: true,
      },
      { name: "writes", values: ["shipping"], labels: ["Change-shipping tasks"], changed: false },
      {
        name: "keep",
        values: ["FI3-125", "FI3-124"],
        labels: ["Bench check", ""],
        changed: false,
      },
      { name: "notes", values: ['Say "why" first'], changed: true },
      { name: "scope", values: [], changed: false },
      { name: "look", values: ['{"tiltDeg":42}'], changed: true, json: true as const },
    ];
    const lines = [
      "The user's answers to the card's questions:",
      '- read-scope: "Every project your sign-in can see" (all-visible), changed',
      '- writes: "Change-shipping tasks" (shipping), as proposed',
      '- keep: "Bench check" (FI3-125), "FI3-124", as proposed',
      '- notes: "Say \\"why\\" first", changed',
      "- scope: no answer, as proposed",
      '- look: {"tiltDeg":42} (JSON), changed',
    ].join("\n");
    const choice = { id: "lock", label: "Lock the cautious plan", answers };
    expect(
      renderWake({
        facts: { kind: "card-choice", to: "crewmate", card: { title: "Access" }, choice },
      }),
    ).toBe(`Card "Access": the user chose "Lock the cautious plan" (lock).\n${lines}`);
    expect(
      renderWake({
        facts: { kind: "card-choice", to: "firstmate", card: { title: "Access" }, choice },
      }),
    ).toBe(`[user]\nLock the cautious plan\nChoice on card "Access".\n${lines}`);
  });

  it("words what the captain wrote under Something else after any picks, as their own answer (FI3-1002)", () => {
    const choice = {
      id: "send",
      label: "Send answers",
      answers: [
        {
          name: "key_app",
          values: [],
          changed: true,
          written: "Try once after a minute, then tell me",
        },
        {
          name: "launch_list",
          values: ["FI3-962"],
          labels: ["Devices keeps this computer's old address"],
          changed: true,
          written: "also FI3-957",
        },
        { name: "retry_every", values: ["5m"], labels: ["Every 5 minutes"], changed: false },
      ],
    };
    expect(
      renderWake({
        facts: { kind: "card-choice", to: "crewmate", card: { title: "Launch" }, choice },
      }),
    ).toBe(
      [
        'Card "Launch": the user chose "Send answers" (send).',
        "The user's answers to the card's questions:",
        '- key_app: written in: "Try once after a minute, then tell me", changed',
        '- launch_list: "Devices keeps this computer\'s old address" (FI3-962), written in: "also FI3-957", changed',
        '- retry_every: "Every 5 minutes" (5m), as proposed',
      ].join("\n"),
    );
  });

  it("words a card choice with no answers exactly as before", () => {
    expect(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          card: { title: "Access" },
          choice: { id: "lock", label: "Lock" },
        },
      }),
    ).toBe('Card "Access": the user chose "Lock" (lock).');
    expect(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "crewmate",
          source: "frame",
          card: { title: "Access" },
          choice: { id: "lock", label: "Lock" },
        },
      }),
    ).toBe('Card "Access": a script chose "Lock" (lock).');
    expect(
      renderWake({
        facts: {
          kind: "card-choice",
          to: "firstmate",
          source: "frame",
          card: { id: "card-fm-access", title: "Access", taskId: "t1" },
          choice: {
            id: "lock",
            label: "Lock",
            answers: [{ name: "mode", values: ["premium"], changed: true }],
          },
        },
      }),
    ).toContain("The script submitted answers to the card's questions:");
  });

  it("still serves a kind this build does not know: its text, else its facts as data", () => {
    const facts = { kind: "from-a-newer-build", task: { id: "t9" } } as unknown as WakeFacts;
    expect(renderWake({ facts, text: "[fm-op] prose it carried" })).toBe(
      "[fm-op] prose it carried",
    );
    const served = renderWake({ facts });
    expect(served).not.toContain("undefined");
    expect(served.split("\n")[0]).toBe("[fm-op] a wake this version cannot word:");
    expect(served).toContain('"kind": "from-a-newer-build"');
  });
});

describe("the answer-delivery wake", () => {
  it("tells the Firstmate what nothing followed, quoting the captain's words and naming what refused its card", () => {
    const text = renderWake(
      answerMissingWake({
        askId: "a1b2c3d4",
        excerpt: "is PR 58 merged?",
        filedOn: { id: "t58", title: "Check PR 58" },
        refusal: "crewmate-owns",
        ownedBy: "card-t58-1",
      }),
    );
    expect(text).toContain('Their words, verbatim: "is PR 58 merged?"');
    expect(text).toContain('filed on task t58 "Check PR 58"');
    expect(text).toContain("the crewmate's card card-t58-1 owns that work");
    expect(text).toContain("refused this turn");
  });

  it("names the card a reply was under, and goes out once per message", () => {
    const wake = answerMissingWake({
      askId: "a1b2c3d4",
      excerpt: "why?",
      aboutCard: { id: "card-fm-plan", title: "The plan" },
    });
    expect(renderWake(wake)).toContain('a reply under your card "The plan" (card-fm-plan)');
    expect(wake.once).toBe(answerRepairOnce("a1b2c3d4"));
    expect(answerRepairOnce("a1b2c3d4")).not.toBe(answerRepairOnce("ffffffff"));
  });

  it("queues one retry per message, however often it is raised", () => {
    const inbox = new InboxStore(openInMemoryDatabase());
    const wake = answerMissingWake({ askId: "a1b2c3d4", excerpt: "why?" });
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, "agent", "answer-missing")).not.toBeNull();
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, "agent", "answer-missing")).toBeNull();
    // Even after it was served and acknowledged.
    const [row] = inbox.pending(FIRSTMATE_RECIPIENT);
    inbox.ack([row?.id as number]);
    expect(inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, "agent", "answer-missing")).toBeNull();
    // Another message gets its own.
    expect(
      inbox.enqueueWake(
        FIRSTMATE_RECIPIENT,
        answerMissingWake({ askId: "ffffffff", excerpt: "and this?" }),
        "agent",
        "answer-missing",
      ),
    ).not.toBeNull();
  });

  it("serves a parked captain turn the same words whether or not it carries its message id", () => {
    expect(renderWake(captainTurn("hello", false, undefined, "a1b2c3d4"))).toBe(
      renderWake(captainTurn("hello", false)),
    );
  });
});
