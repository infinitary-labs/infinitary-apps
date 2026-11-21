import { reviewerOverrideWords } from "@shared/holds";
import { describe, expect, it } from "vitest";
import {
  AFTER_MERGE_DELIVERY_RULE,
  ANSWER_MARK_WORDS,
  ANSWER_REPLY_WORDS,
  amendBriefGoal,
  assertDeliverableConstraints,
  basisSectionParts,
  briefText,
  deliverableFor,
  FLEET_STARTED_ANSWER_WORDS,
  LOOK_DEEPER_LABEL,
  NO_WORDS_FOR_THIS_TASK,
  parseSpawnIntent,
  QUICK_ANSWER_FIRST_WORDS,
  QUICK_ANSWER_GENERAL_KNOWLEDGE_WORDS,
  QUICK_ANSWER_LINE_WORDS,
  QUICK_ANSWER_MARK,
  QUICK_ANSWER_REACH_WORDS,
  QUICK_ANSWER_REPLY_WORDS,
  QUICK_ANSWER_STRAIGHT_DEEPER_WORDS,
  REVIEW_FIX_RULES,
  renderAnswerShapeSection,
  renderBasisSection,
  renderEscalationBrief,
  renderFollowupBrief,
  renderIntentBrief,
  renderOperationShapeSection,
  renderPicturesSection,
  renderReviewBrief,
  renderRigorSection,
  withoutDeliveryLine,
  withoutOriginReadLine,
} from "./intentBrief";

describe("parseSpawnIntent", () => {
  it("normalizes a full intent", () => {
    expect(
      parseSpawnIntent({
        goal: "  The meter works  ",
        user_words: " fix the meter ",
        constraints: [
          { kind: "tests-required" },
          { kind: "minimal-diff", text: "renderer only" },
          { kind: "free", text: "keep the public API stable" },
        ],
        delivery_note: " single commit ",
      }),
    ).toEqual({
      goal: "The meter works",
      userWords: "fix the meter",
      constraints: [
        { kind: "tests-required" },
        { kind: "minimal-diff", text: "renderer only" },
        { kind: "free", text: "keep the public API stable" },
      ],
      deliveryNote: "single commit",
    });
  });

  it("fails loud on missing goal, textless free, unknown kind", () => {
    expect(() => parseSpawnIntent({ goal: " ", user_words: "x" })).toThrow(/goal is required/);
    expect(() =>
      parseSpawnIntent({ goal: "g", user_words: "x", constraints: [{ kind: "free" }] }),
    ).toThrow(/needs its text/);
    expect(() =>
      parseSpawnIntent({ goal: "g", user_words: "x", constraints: [{ kind: "yolo" }] }),
    ).toThrow(/Unknown constraint kind/);
  });
});

describe("renderIntentBrief", () => {
  it("renders the fixed template: verbatim user words outrank the goal, constraints and delivery (INF-1366)", () => {
    const brief = renderIntentBrief(
      {
        goal: "The meter works",
        userWords: "fix the meter",
        constraints: [
          // Retired at contract 4.6; a row stored before then still renders.
          { kind: "plan-first" },
          { kind: "no-new-deps" },
          { kind: "free", text: "keep the public API stable" },
        ],
        deliveryNote: "stack on top of PR 41",
      },
      "direct-pr",
    );
    const lines = brief.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "The user's words, verbatim - these outrank every elaboration below, including your own:",
      "fix the meter",
      "",
      "Goal: The meter works",
      "",
    ]);
    expect(brief).toContain(
      "The user's words, verbatim - these outrank every elaboration below, including your own:\nfix the meter",
    );
    expect(brief).toContain("- plan first: present your plan as a decision card");
    expect(brief).toContain("- no new dependencies");
    expect(brief).toContain("- keep the public API stable");
    expect(brief).toContain(
      "Delivery: direct-pr - finished work is pushed and opened as a pull request where the project lives (git push, then show_merge_card, or open_change where show_merge_card is not served).",
    );
    expect(brief).toContain("Delivery note: stack on top of PR 41");
    // The user's words come before every constraint elaboration.
    expect(brief.indexOf("fix the meter")).toBeLessThan(brief.indexOf("Constraints:"));
  });

  it("amends the host goal without touching a goal line in verbatim words (INF-1369)", () => {
    const intent = {
      goal: "Original scope",
      userWords: "Goal: Original scope\nKeep my words as written.",
      constraints: [{ kind: "free" as const, text: "leave phone checks as they are" }],
    };
    const before = renderIntentBrief(intent, "direct-pr");
    expect(amendBriefGoal(before, intent.goal, "Corrected scope", intent.userWords)).toBe(
      renderIntentBrief({ ...intent, goal: "Corrected scope" }, "direct-pr"),
    );
    expect(
      amendBriefGoal("Not a host brief", intent.goal, "Corrected scope", intent.userWords),
    ).toBe("Not a host brief");
  });

  it("carries the personal-ui kind and refuses an unknown one", () => {
    expect(parseSpawnIntent({ goal: "g", user_words: "w", kind: "personal-ui" })).toEqual({
      goal: "g",
      userWords: "w",
      kind: "personal-ui",
    });
    expect(parseSpawnIntent({ goal: "g", user_words: "w" })).not.toHaveProperty("kind");
    expect(() => parseSpawnIntent({ goal: "g", user_words: "w", kind: "widget" })).toThrow(
      /Unknown intent kind "widget"/,
    );
  });

  it("renders a personal-workspace brief with no delivery line and the workspace facts", () => {
    const brief = renderIntentBrief(
      {
        goal: "A Tokyo clock panel exists",
        userWords: "make me a tokyo clock",
        kind: "personal-ui",
      },
      undefined,
      {
        workspaceDir: "/data/fleet/personal",
        surfaces: [{ id: "open-prs", title: "Open PRs", placement: { x: "right" } }],
      },
    );
    // The personal workspace is a workspace KIND, not a posture: there is
    // no Delivery line to write, and the in-place sentence leads the facts.
    expect(brief).not.toContain("Delivery:");
    expect(brief).toContain(
      "You build in place: this task carries no delivery posture and no rigor tier, because nothing here ships through a gate.",
    );
    expect(brief).toContain("Workspace: /data/fleet/personal - your working directory.");
    expect(brief).toContain("Do not commit; the host commits at the end of each of your turns");
    // A build ends the ordinary way (INF-1677): a note showing it, then the report.
    expect(brief).toContain("Your completion is a factual note showing what you built");
    // The session lists the workspace's skills itself (FI3-789): the brief
    // names the two to start from and never lists them a second time.
    expect(brief).toContain(
      "Your session carries the workspace's AGENTS.md and lists its skills under .claude/skills/.",
    );
    expect(brief).toContain("Open personal-panel before you write or change a panel");
    expect(brief).not.toContain("infinitary-design");
    expect(brief).not.toContain("github-prs");
    // Every report follows a look at the version on the captain's own rail
    // (INF-607): the checks name place_panel before the report.
    expect(brief).toContain(
      "Before reporting a panel change, lint_panel checks it, place_panel puts it on the captain's rail, and capture_panel photographs it there.",
    );
    expect(brief).toContain('Surfaces now: open-prs "Open PRs" (right rail).');
    // Without the facts nothing of the workspace is said; without surfaces
    // it says so.
    expect(renderIntentBrief({ goal: "g", userWords: "w" }, undefined)).not.toContain("Workspace:");
    expect(
      renderIntentBrief({ goal: "g", userWords: "w" }, undefined, {
        workspaceDir: "/w",
        surfaces: [],
      }),
    ).toContain("Surfaces now: none yet.");
    // An ordinary posture carries its Delivery line and no workspace facts.
    const project = renderIntentBrief({ goal: "g", userWords: "w" }, "local-only");
    expect(project).toContain(
      "Delivery: local-only - work merges on a local branch and never leaves the machine.",
    );
    expect(project).not.toContain("Workspace:");
    const followup = renderFollowupBrief(
      { goal: "g", why: "y", filedBy: "crewmate 1", originTitle: "Clock", originKey: "PE-1" },
      undefined,
      { workspaceDir: "/w", surfaces: [] },
    );
    expect(followup).toContain("Workspace: /w");
    expect(followup).toContain("Read the origin's report and card with the tasks query (PE-1)");
    expect(renderIntentBrief({ goal: "continue", userWords: "build it" }, "direct-pr")).toContain(
      AFTER_MERGE_DELIVERY_RULE,
    );
    expect(followup).not.toContain("Delivery:");
  });

  it("briefs an escalation with the attempt it replaces (S4)", () => {
    const brief = renderEscalationBrief(
      { goal: "The meter test really passes", userWords: "that is not a fix, try again" },
      "direct-pr",
      {
        attempt: 2,
        previousKey: "FM3K-12",
        tier: "premium",
        previousModel: "gpt-6-astra",
        previousOutcome: "I disabled the assertion; the test passes now.",
        previousWork: "refs/infinitary/kept/ab12cd34",
      },
    );
    // The ordinary template is intact underneath - the captain's words are
    // still the verbatim, outranking section - and the escalation section
    // says which attempt they were about rather than repeating them.
    expect(brief).toContain("The user's words, verbatim");
    expect(brief).toContain("that is not a fix, try again");
    expect(brief).toContain("attempt 2 at the premium tier");
    expect(brief).toContain("The previous attempt (FM3K-12, on gpt-6-astra) reported:");
    expect(brief).toContain("I disabled the assertion");
    expect(brief).toContain("its work is saved in the repository at refs/infinitary/kept/ab12cd34");
  });

  it("points an escalation of a step with no words of the captain's at its goal, never at words above (INF-1939)", () => {
    const brief = renderEscalationBrief(
      { goal: "The meter test really passes", userWords: "" },
      "direct-pr",
      {
        attempt: 2,
        previousKey: "FM3K-12",
        tier: "premium",
      },
    );
    expect(brief.startsWith(NO_WORDS_FOR_THIS_TASK)).toBe(true);
    expect(brief).not.toContain("the words above");
    expect(brief).not.toContain("from the user's words");
    expect(brief).toContain("Work the goal again.");
  });

  it("says plainly when the replaced attempt left no report and no branch (S4)", () => {
    const brief = renderEscalationBrief({ goal: "g", userWords: "w" }, "local-only", {
      attempt: 1,
      previousKey: "FM3K-9",
      tier: "high",
    });
    expect(brief).toContain("The previous attempt (FM3K-9) finished without a report.");
    expect(brief).not.toContain("Its branch");
  });

  it("omits empty sections and renders the local-only posture", () => {
    const brief = renderIntentBrief(
      { goal: "A summary exists", userWords: "summarize" },
      "local-only",
    );
    expect(brief).not.toContain("Constraints:");
    expect(brief).not.toContain("Delivery note:");
    expect(brief).toContain(
      "Delivery: local-only - work merges on a local branch and never leaves the machine.",
    );
  });
});

describe("renderRigorSection (INF-1876: the care is a name)", () => {
  it("names the care in one line and leaves what it asks to the care guidance", () => {
    const quick = renderRigorSection("quick");
    const standard = renderRigorSection("standard");
    const reviewed = renderRigorSection("reviewed");
    for (const line of [quick, standard, reviewed]) {
      expect(line.startsWith("Rigor: ")).toBe(true);
      expect(line).not.toContain("\n");
      expect(line).toContain("what it asks is in the rigor guidance served with your instructions");
      // No procedure, no reviewer and no fix rules: the care runbook holds them.
      expect(line).not.toContain("reviewer");
      expect(line).not.toContain(REVIEW_FIX_RULES);
    }
    expect(quick).toBe(
      "Rigor: Quick (quick) - what it asks is in the rigor guidance served with your instructions.",
    );
    expect(standard).toBe(
      "Rigor: Default (standard) - what it asks is in the rigor guidance served with your instructions.",
    );
    expect(reviewed).toBe(
      "Rigor: Careful (reviewed) - what it asks is in the rigor guidance served with your instructions.",
    );
  });
});

describe("renderReviewBrief (delivery rigor phase 2, review-before-PR)", () => {
  const facts = {
    builderTitle: "Fix the flaky meter test",
    branch: "fm/task-abc12345",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    changedFiles: ["src/meter.ts", "tests/meter.test.ts"],
    builderReport:
      "Intent: the meter test passes ten runs in a row. What changed: the test awaits the queue flush. Verified: pnpm test on the final commit. Risk: low. Not done: nothing.",
  };

  // INF-1216: the reviewer's brief carries the captain's standing words, so access they cover is not a finding.
  it("carries the captain's standing override, and none when no override stands", () => {
    const override = {
      words: "keep going until the checks pass",
      holds: ["checks" as const],
      until: "task" as const,
    };
    const brief = renderReviewBrief(
      { goal: "ignored", userWords: "make the meter test stop flaking" },
      "direct-pr",
      { ...facts, override },
    );
    expect(brief).toContain(reviewerOverrideWords(override));
    expect(
      renderReviewBrief({ goal: "ignored", userWords: "make it stop" }, "direct-pr", facts),
    ).not.toContain("standing override");
  });

  it("names the builder's evidence folder when the host knows it", () => {
    const brief = renderReviewBrief(
      { goal: "ignored", userWords: "make the meter test stop flaking" },
      "direct-pr",
      { ...facts, evidenceDir: "/app/crewmates/abc12345/evidence" },
    );
    expect(brief).toContain("The builder's evidence folder: /app/crewmates/abc12345/evidence");
  });

  it("renders the fixed review instruction around the captain's verbatim words and the builder's report", () => {
    const brief = renderReviewBrief(
      { goal: "ignored: the host names the goal", userWords: "make the meter test stop flaking" },
      "direct-pr",
      facts,
    );
    // INF-1366: the review goal is also an elaboration of the captain's words.
    expect(brief.split("\n").slice(0, 4)).toEqual([
      "The user's words, verbatim - these outrank every elaboration below, including your own:",
      "make the meter test stop flaking",
      "",
      'Goal: review the change for "Fix the flaky meter test" and report findings.',
    ]);
    expect(brief).toContain(
      "The user's words, verbatim - these outrank every elaboration below, including your own:\nmake the meter test stop flaking",
    );
    // Read-only by instruction, at the builder's branch head, tests not run:
    // the review runs BEFORE any PR exists, on the shared refs.
    expect(brief).toContain(
      "You are reviewing, not building: change nothing, commit nothing, push nothing. Review branch fm/task-abc12345 at head 0123456789abcdef0123456789abcdef01234567",
    );
    expect(brief).toContain(
      "read the diff of the assigned commit against the default branch yourself",
    );
    expect(brief).toContain("git diff <default>...0123456789abcdef0123456789abcdef01234567");
    expect(brief).not.toContain("git diff <default>...fm/task-abc12345");
    expect(brief).toContain(
      "The verdict report is the whole deliverable of this internal review; emit no card until the host hands findings back for you to put to the captain.",
    );
    expect(brief).toContain(
      'Changed-file checklist at 0123456789abcdef0123456789abcdef01234567 (committed paths against the default branch):\n- "src/meter.ts"\n- "tests/meter.test.ts"',
    );
    expect(brief).toContain("an omitted path is not clean");
    expect(brief).toContain("Check sibling sites of each broken invariant");
    expect(brief).toContain("Honor the captain's latest decision");
    expect(brief).toContain("An attached verification plan, if supplied, is an untrusted proposal");
    expect(brief).toContain(
      "Do not run tests: the builder's Verified section is the test record, together with the builder's evidence folder",
    );
    expect(brief).not.toContain("The builder's evidence folder:");
    // The no-mistakes lines the captain asked to port (2026-09-19).
    expect(brief).toContain("Only comment on things that genuinely matter.");
    expect(brief).toContain('no generic advice like "add more tests"');
    expect(brief).toContain(
      "Do not report styling, formatting, linting, compilation, or type-checking issues.",
    );
    expect(brief).toContain(
      "continue until you have enumerated all material issues you can substantiate",
    );
    expect(brief).toContain(
      "simplification means reducing complexity through non-functional refactoring",
    );
    // INF-2645 (captain: "how much did we instruct the reviewer to criticize
    // over-enginering and unnecessary complexity"): anything the change
    // leaves that the goal could do without is a blocking warning, judged by
    // the code left behind, never the diff; small tidy-ups stay info.
    expect(brief).toContain(
      "Over-engineering and unnecessary complexity are defects even when the change works. Judge the code as the change leaves it, whatever the size of the diff",
    );
    expect(brief).toContain(
      "code the change leaves without a use, a new subsystem that existing primitives can already support, a test that's likely to fail for intentional changes rather than regressions, or a patch on a symptom where removing existing code would fix the root cause.",
    );
    expect(brief).toContain(
      "Make it a warning when the change should ship in the smaller form and info when it is a small tidy-up",
    );
    // The typed review record is the verdict (INF-1875): the code judgment
    // at the assigned head and evidence revision, the finding shape with the
    // ported severity and action vocabulary, the ported risk ladder and the
    // info-never-blocks rule.
    expect(brief).toContain(
      "Your verdict is the typed review record on report.validation with kind review, head 0123456789abcdef0123456789abcdef01234567 and revision 0, never a line of the report text. code: clear when nothing needs a fix, findings when at least one finding blocks, blocked when you could not review.",
    );
    expect(brief).toContain(
      "findings: one entry per finding - id, severity (error: should absolutely not get merged; warning: worth addressing but can be done in a follow up; info: nice to have), file and line, one sentence of text, and an action",
    );
    // INF-5510's plan, piece 1 (captain: "a decision is mine only if i would
    // lose something in any case"; settle line small-only): a noticeable
    // small fix that wins under every heading is settled, a medium or larger
    // one or a real tradeoff asks, and a heading is a product-level quality.
    expect(brief).toContain(
      "auto-fix: a non-user-visible issue (correctness, error handling, security, performance, mechanical code quality) safely fixable without discussing the author's intent; a noticeable finding whose fix is small and wins or ties under every heading against what the code does now",
    );
    expect(brief).toContain(
      "ask-user: a finding where every way gives something up under some heading; one whose only winning fix is medium or larger",
    );
    expect(brief).toContain(
      "A heading names a quality of the whole product the captain wants more of, in one or two words that would fit a question about an unrelated change (security would; approval guarantee would not)",
    );
    expect(brief).toContain(
      "An auto-fix or no-op finding a person would notice is settled without asking: its text begins Settled without asking",
    );
    expect(brief).toContain("high: should not be merged without explicit human approval");
    // INF-3716 (captain: the reason should come from whoever gave that
    // recommendation): the reviewer sizes every way forward and recommends one
    // with its reason, or says it recommends none.
    expect(brief).toContain(
      "An ask-user finding's text may run past one sentence: it says what the code does now, lists every way forward with a rough size in your own words (what the code does now is sized as no further change), gives each way's level under each heading where the ways differ, and names the way you recommend with one reason and what it gives up, or says you recommend none; an approval names only its yes and its no.",
    );
    expect(brief).toContain(
      "An error, a warning or an ask-user finding blocks; info findings never block, so they ride a clear review",
    );
    expect(brief).not.toContain("verdict: pass|findings|blocked");
    // INF-125 convergence, carried by the app since INF-993: the decided
    // history, and no verdict without a new proof pair.
    expect(brief).toContain(
      "Every turn of yours carries what was decided so far on this change, when anything was, written by the app from the record: honor it, and do not re-report a finding the captain declined unless the current code genuinely introduces a new, materially different problem.",
    );
    expect(brief).toContain(
      "A message with no changed head, evidence revision or validation state needs no verdict: never restate one.",
    );
    expect(brief).toContain(`The builder's report:\n${facts.builderReport}`);
    expect(brief).toContain(
      "Delivery: direct-pr - finished work is pushed and opened as a pull request where the project lives (git push, then show_merge_card, or open_change where show_merge_card is not served).",
    );
    // The host's goal, not the Firstmate's.
    expect(brief).not.toContain("ignored: the host names the goal");
  });

  it("keeps an open pull request from replacing the assigned commit (INF-288)", () => {
    const brief = renderReviewBrief(
      { goal: "g", userWords: "review this carefully" },
      "direct-pr",
      { ...facts, prUrl: "https://github.com/o/r/pull/55" },
    );
    expect(brief).toContain(
      "Review branch fm/task-abc12345 at head 0123456789abcdef0123456789abcdef01234567",
    );
    expect(brief).toContain("git diff <default>...0123456789abcdef0123456789abcdef01234567");
    expect(brief).toContain(
      "A pull request is already open at https://github.com/o/r/pull/55; review the assigned commit, not that pull request's recorded head.",
    );
    expect(brief).not.toContain("Review PR https://github.com/o/r/pull/55");
  });

  it("does not treat a missing assigned commit as a clean checklist (INF-288)", () => {
    const brief = renderReviewBrief(
      { goal: "g", userWords: "review this carefully" },
      "direct-pr",
      { ...facts, prUrl: "https://github.com/o/r/pull/55", changedFiles: null },
    );
    expect(brief).toContain(
      "The assigned commit 0123456789abcdef0123456789abcdef01234567 is not in this working copy.",
    );
    expect(brief).toContain("do not claim a clean review");
    expect(brief).not.toContain("that PR's diff");
    expect(brief).not.toContain('- "src/meter.ts"');
  });

  it("asks a review after an earlier pass for the difference since that pass only (INF-401)", () => {
    // The captain's direction: after an unavoidable update, the re-review
    // checks only the update's difference, not the whole change again.
    const intent = { goal: "g", userWords: "make the meter test stop flaking" };
    const passed = "fedcba9876543210fedcba9876543210fedcba98";
    const brief = renderReviewBrief(intent, "direct-pr", { ...facts, passedHead: passed });
    expect(brief).toContain(`Review branch fm/task-abc12345 at head ${facts.headSha}`);
    expect(brief).toContain(
      `An earlier review already passed this change at ${passed}, and the branch has moved since. Review only the difference between that passed version and the assigned commit`,
    );
    expect(brief).toContain("not the whole change again");
    expect(brief).toContain(`git range-diff <default>..${passed} <default>..${facts.headSha}`);
    expect(brief).toContain(
      `a path whose change reads the same as at ${passed} was reviewed there and needs no second look`,
    );
    expect(brief).toContain("an omitted path is not clean");
    expect(brief).toContain(
      `Changed-file checklist at ${facts.headSha} (committed paths against the default branch; compare each with ${passed}):\n- "src/meter.ts"\n- "tests/meter.test.ts"`,
    );
    expect(brief).toContain("Do a full pass over the difference before reporting");
    expect(brief).not.toContain("recompute the complete checklist");
    expect(brief).not.toContain("Do a full review pass");

    const whole = renderReviewBrief(intent, "direct-pr", facts);
    expect(whole).not.toContain("An earlier review already passed");
    expect(whole).toContain("Do a full review pass before reporting");
    // A pass at the assigned commit itself leaves nothing to scope.
    expect(renderReviewBrief(intent, "direct-pr", { ...facts, passedHead: facts.headSha })).toBe(
      whole,
    );
  });

  it("is byte-stable: the same facts render the same brief", () => {
    const intent = { goal: "g", userWords: "review this carefully" };
    expect(renderReviewBrief(intent, "direct-pr", facts)).toBe(
      renderReviewBrief(intent, "direct-pr", facts),
    );
  });

  it("fails loud with no captain words: there is nothing to review against", () => {
    expect(() => renderReviewBrief({ goal: "g", userWords: "   " }, "direct-pr", facts)).toThrow(
      /A review brief needs the user's words/,
    );
  });
});

describe("the deliverable axis (Task B, captain F1 A)", () => {
  const intent = (constraints?: { kind: string; text?: string }[]) =>
    parseSpawnIntent({
      goal: "explain why the cluster is idle",
      user_words: "why is nothing running?",
      ...(constraints ? { constraints } : {}),
    });

  /**
   * INF-990 friction 7: INF-945 was a build with no read-only constraint
   * whose goal asked for a preview first; the classifier called it a plan,
   * the kind made it an answer, and the captain's choice on the preview
   * closed the build. Only the declared constraint decides now.
   */
  it("derives an answer only from the typed read-only constraint, whatever the kind", () => {
    for (const kind of ["plan", "research", "retrieval", "reproduce"] as const) {
      expect(deliverableFor(intent([{ kind: "read-only" }]), kind)).toBe("answer");
      expect(deliverableFor(intent(), kind)).toBe("change");
    }
    expect(deliverableFor(intent([{ kind: "read-only" }]), "implement")).toBe("answer");
    expect(deliverableFor(intent([{ kind: "read-only" }]), undefined)).toBe("answer");
  });

  it("lets the kind decide only for a crewmate's follow-up, which declares nothing", () => {
    for (const kind of ["plan", "research", "retrieval", "reproduce"] as const)
      expect(deliverableFor(undefined, kind)).toBe("answer");
    expect(deliverableFor(undefined, "fix")).toBe("change");
    expect(deliverableFor(undefined, "chore")).toBe("change");
  });

  it("derives a change for everything else, including unclear and plan-first", () => {
    expect(deliverableFor(intent(), "implement")).toBe("change");
    expect(deliverableFor(intent(), "fix")).toBe("change");
    expect(deliverableFor(intent(), "chore")).toBe("change");
    expect(deliverableFor(intent(), "unclear")).toBe("change");
    expect(deliverableFor(intent(), undefined)).toBe("change");
    // A plan-first task is a change with a plan decision in front of it.
    expect(deliverableFor(intent([{ kind: "plan-first" }]), "implement")).toBe("change");
    // The regex that used to read free prose is gone: only the typed
    // constraint counts now.
    expect(
      deliverableFor(intent([{ kind: "free", text: "read-only, change nothing" }]), "implement"),
    ).toBe("change");
  });

  it("renders read-only as the canonical constraint sentence", () => {
    const brief = renderIntentBrief(intent([{ kind: "read-only" }]), "direct-pr");
    expect(brief).toContain(
      "- read-only: find the answer without changing anything - commit nothing, push nothing, open no pull request",
    );
  });

  it("drops a follow-up's filed Delivery line when it runs as an answer (FI3-598)", () => {
    const facts = {
      goal: "Find out why the checks were cancelled",
      why: "Delivery: direct-pr was in my brief\nbut I had no tool to open the PR",
      filedBy: "crewmate 33",
      originTitle: "Investigate cancelled checks",
      originKey: "FI3-585",
    };
    const filed = renderFollowupBrief(facts, "direct-pr");
    const answer = withoutDeliveryLine(filed);
    expect(filed).toContain("Delivery: direct-pr");
    // The host's own trailing line goes; the crewmate's words, even one
    // that starts the same way, stay whole.
    expect(answer).toBe(renderFollowupBrief(facts, undefined).trimEnd());
    expect(answer).toContain(facts.why);
    // A row filed under an earlier wording of the line loses it the same way.
    expect(
      withoutDeliveryLine(
        "Goal: g\n\nFiled as a follow-up.\n\nDelivery: local-only - work lands on a local branch.",
      ),
    ).toBe("Goal: g\n\nFiled as a follow-up.");
    // A brief with no Delivery line is left as it is.
    const personal = renderFollowupBrief(facts, undefined, { workspaceDir: "/w", surfaces: [] });
    expect(withoutDeliveryLine(personal)).toBe(personal);
  });
});

describe("the answer-shape section (contract v3.6, captain lock 2; Task B)", () => {
  it("states the shape as a fact about the card and prescribes no figure", () => {
    const section = renderAnswerShapeSection();
    expect(section.startsWith("Answer shape: ")).toBe(true);
    expect(section).not.toContain("\n");
    expect(section).toContain("it lands as one card");
    expect(section).toContain("opens with the answer in a sentence and then draws it");
    expect(section).toContain("a figure for each part of the explanation");
    // No recipe: what to draw is the explanation's business (contract v2.5).
    expect(section).not.toMatch(/bar chart|timeline|flow ?chart|diagram of/i);
    // And no condition handed back to the author (captain lock 2).
    expect(section).not.toMatch(/wherever|if a picture|when a picture|you may/i);
  });

  // INF-3749, the captain: long text is supporting material, "and most of the
  // time even when we write long text snippets they should be hidden in an
  // expand". Both branches fold everything but the answer, figures and questions.
  it("keeps the open card to the answer, figures and questions and folds the rest under a named expand", () => {
    for (const section of [renderAnswerShapeSection(), renderAnswerShapeSection(true)]) {
      expect(section).toContain("Each figure carries its own names and numbers");
      expect(section).toContain("in <details> whose <summary> names what is inside");
    }
    expect(renderAnswerShapeSection()).toContain("a plan's spec for the builder");
    expect(renderAnswerShapeSection()).not.toContain("are prose beside the figure they qualify");
  });

  // The answer brief marks a saved note for explicit Done, never corner
  // closure. Other acknowledged work uses the typed finished report;
  // an internal step's answer goes to its report instead of a card.
  it("tells a captain-asked answer to mark its answer card answering, with finished as the fallback (INF-1732)", () => {
    expect(renderAnswerShapeSection()).toContain(ANSWER_MARK_WORDS);
    expect(ANSWER_MARK_WORDS).toContain("report with finished true");
    expect(renderAnswerShapeSection(true)).not.toContain(ANSWER_MARK_WORDS);
  });

  it("tells an answer task it ships nothing and its worktree is scratch", () => {
    const section = renderAnswerShapeSection();
    expect(section).toContain(
      "Rigor: none - this task ships nothing; the card is the deliverable.",
    );
    expect(section).toContain("Your worktree is a laboratory");
    expect(section).toContain("commit nothing, push nothing, and open no pull request");
    expect(section).toContain("The card and your report are the only things that survive");
    expect(section).toContain("When your findings warrant a concrete next move");
    expect(section).toContain("one recommended default");
    expect(section).toContain("pure fact, which stays a note");
    // INF-4583 (INF-4573 direction A, part 3): a reply is the captain still
    // working on their problem, for every answer the captain asked for.
    expect(section).toContain(ANSWER_REPLY_WORDS);
    expect(renderAnswerShapeSection(false, "research")).toContain(ANSWER_REPLY_WORDS);
    expect(renderAnswerShapeSection(false, "retrieval")).toContain(ANSWER_REPLY_WORDS);
    expect(section).toContain("Your report stays the short factual account");
    // The report is the answer the task keeps: re-recorded in full when the
    // captain's replies change it, so work built on it starts from it.
    expect(section).toContain("report it again in full - the final agreed version");
  });
});

// INF-1430 piece 1, rewritten by INF-4344 (the captain's direction C of
// INF-4341): a quick answer answers the question first from what the app can
// already read, ends a short answer with its Quick answer line and Look
// deeper, and goes straight to research when its sources hold no answer.
describe("a quick answer's instructions", () => {
  const QUICK_WORDS = [
    QUICK_ANSWER_REACH_WORDS,
    QUICK_ANSWER_FIRST_WORDS,
    QUICK_ANSWER_LINE_WORDS,
    QUICK_ANSWER_STRAIGHT_DEEPER_WORDS,
    QUICK_ANSWER_REPLY_WORDS,
    QUICK_ANSWER_GENERAL_KNOWLEDGE_WORDS,
  ];

  it("tells a retrieval crewmate to answer first, mark a short answer and go deeper when it cannot", () => {
    const section = renderAnswerShapeSection(false, "retrieval");
    for (const words of QUICK_WORDS) expect(section).toContain(words);
    // The order the plan settled: reach, answer, stop with its line, no card.
    const at = QUICK_WORDS.map((words) => section.indexOf(words));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(QUICK_ANSWER_LINE_WORDS).toContain(`begins "${QUICK_ANSWER_MARK}."`);
    expect(QUICK_ANSWER_LINE_WORDS).toContain(`makes ${LOOK_DEEPER_LABEL} its default action`);
    // The captain's "No" to one web page: the web stays past the reach.
    expect(QUICK_ANSWER_REACH_WORDS).toContain("never the web");
  });

  // INF-4583, building INF-4573's direction A: the audited quick crewmate met
  // eight replies with one more line from the records each; a reply past the
  // sources now goes to the first mate, with the captain's yes to one marked
  // sentence from general knowledge in the meantime.
  it("tells a retrieval crewmate to hand off a reply its sources cannot solve", () => {
    const section = renderAnswerShapeSection(false, "retrieval");
    expect(section).toContain(QUICK_ANSWER_REPLY_WORDS);
    for (const asks of ["how to do something", "what is usual", "an action"]) {
      expect(QUICK_ANSWER_REPLY_WORDS).toContain(asks);
    }
    expect(QUICK_ANSWER_REPLY_WORDS).toContain("report with needs_firstmate the captain's words");
    // A where-is-it reply gets the file itself, not a path on another computer.
    expect(QUICK_ANSWER_REPLY_WORDS).toContain("with any file it asks for in the card's files");
    expect(QUICK_ANSWER_REPLY_WORDS).toContain(
      "Never answer such a reply by restating the records.",
    );
    // The general-knowledge sentence follows the hand-off and never replaces it.
    expect(section.indexOf(QUICK_ANSWER_GENERAL_KNOWLEDGE_WORDS)).toBeGreaterThan(
      section.indexOf(QUICK_ANSWER_REPLY_WORDS),
    );
    expect(QUICK_ANSWER_GENERAL_KNOWLEDGE_WORDS).toContain('begins "Not checked here:"');
    expect(QUICK_ANSWER_GENERAL_KNOWLEDGE_WORDS).toContain("never replaces the hand-off");
  });

  it("leaves research, and a retrieval step handed to the next step, without it", () => {
    for (const section of [
      renderAnswerShapeSection(false, "research"),
      renderAnswerShapeSection(false),
      renderAnswerShapeSection(true, "retrieval"),
    ]) {
      expect(section).not.toContain(LOOK_DEEPER_LABEL);
      for (const words of QUICK_WORDS) expect(section).not.toContain(words);
    }
  });
});

describe("the answer shape of a step the Firstmate declared (docs/sequences.md)", () => {
  // INF-4574 change 2: a step the crew started itself, the first mate's or
  // one the app filed at a merge, gets the crew-started words for an answer.
  it("hands the answer on in the report, with a card only for the captain's part", () => {
    const step = renderAnswerShapeSection(true);
    expect(step).toContain(
      "a step whose answer the first mate, and the next step when there is one, builds on",
    );
    expect(step).toContain("Your report is that answer and is handed to the next step verbatim");
    expect(step).toContain(FLEET_STARTED_ANSWER_WORDS);
    expect(step).toContain("Rigor: none - this task ships nothing.");
    expect(step).not.toContain("it lands as one card");
    // Its next move goes in the report, so the reply sentence is not its own.
    expect(step).not.toContain(ANSWER_REPLY_WORDS);
    // The captain's own ask - anything not declared a step - keeps the card.
    for (const asked of [renderAnswerShapeSection(false), renderAnswerShapeSection()]) {
      expect(asked).toContain("it lands as one card");
      expect(asked).not.toContain("handed to the next step");
    }
  });

  // INF-1226: INF-1220's consent card closed its task answered before it
  // signed anything, so both shapes say which card closes the task.
  it("tells both shapes that a card they go on from declares continues and does not close them", () => {
    for (const shape of [renderAnswerShapeSection(true), renderAnswerShapeSection(false)]) {
      expect(shape).toContain(
        "a consent before you use something sensitive, declares continues on each revision",
      );
      expect(shape).toContain("any other card of yours closes this task as answered");
    }
    // A step's choice on a card it does not go on from closes it, so the
    // step is no longer told every choice comes to it.
    expect(renderAnswerShapeSection(true)).not.toContain("replies and choice come to you");
  });
});

describe("the retired plan-first constraint (contract 4.6)", () => {
  it("reads a recorded plan-first spawn as the same words in a free constraint", () => {
    const intent = parseSpawnIntent({
      goal: "the meter works",
      user_words: "fix the meter",
      constraints: [{ kind: "plan-first" }, { kind: "plan-first", text: "two options" }],
    });
    expect(intent.constraints).toEqual([
      { kind: "free", text: expect.stringMatching(/^plan first: present your plan/) },
      { kind: "free", text: expect.stringMatching(/wait for the choice .* \(two options\)$/) },
    ]);
    // A plan is its own step now: nothing about the brief turns it into one.
    expect(deliverableFor(intent, "implement")).toBe("change");
    expect(renderIntentBrief(intent, "direct-pr")).toContain("- plan first: present your plan");
  });
});

describe("the basis section (Task B, captain F3 A)", () => {
  const facts = {
    key: "FM3K-12",
    title: "Why the cluster is idle",
    userWords: "why is nothing running?",
    outcome: "The scheduler never claims a row without a repo.",
    card: "<p>The claim query filters on repo_id.</p>",
  };

  it("is byte-stable and carries the captain's words, the report and the card", () => {
    const section = renderBasisSection(facts);
    expect(section).toBe(renderBasisSection(facts));
    expect(section).toContain('grounded in FM3K-12 "Why the cluster is idle"');
    expect(section).toContain("why is nothing running?");
    expect(section).toContain("The scheduler never claims a row without a repo.");
    expect(section).toContain("<p>The claim query filters on repo_id.</p>");
    expect(section).toContain("Build on it rather than re-deriving it");
  });

  it("names the files of the card's pictures so the builder can open them", () => {
    const section = renderBasisSection({
      ...facts,
      pictures: ["/data/crewmates/t1/cards/t1-ab.png"],
    });
    expect(section).toContain("open them to see the design the captain saw");
    expect(section).toContain("- /data/crewmates/t1/cards/t1-ab.png");
    expect(renderBasisSection(facts)).not.toContain("open them to see");
  });

  it("names the files of the card's demo recordings so the builder can play them", () => {
    const section = renderBasisSection({
      ...facts,
      recordings: ["/data/crewmates/t1/cards/t1-cd.mp4"],
    });
    expect(section).toContain("play them to see what the captain saw");
    expect(section).toContain("- /data/crewmates/t1/cards/t1-cd.mp4");
    expect(renderBasisSection(facts)).not.toContain("play them to see");
  });

  it("names the card's file instead of pasting it, keeping the choice, answers and thread as words", () => {
    const { card: _inline, ...rest } = facts;
    const file = "/data/crewmates/b1/source-cards/FM3K-12.html";
    const section = renderBasisSection({
      ...rest,
      cardFile: file,
      pictures: ["/data/crewmates/t1/cards/t1-ab.png"],
      thread: [{ who: "captain", text: "B, but keep the gear icon" }],
      choice: "Build it",
      answers: ['- look: {"tiltDeg":57}, changed'],
    });
    expect(section).toContain(
      `Its card, as the captain read it, is saved whole - any script and style included - in this file on this machine; open it to read the card:\n- ${file}`,
    );
    expect(section).not.toContain("<p>");
    expect(section).toContain("- /data/crewmates/t1/cards/t1-ab.png");
    expect(section).toContain("- captain: B, but keep the gear icon");
    expect(section).toContain('The captain closed it by choosing "Build it".');
    expect(section).toContain('- look: {"tiltDeg":57}, changed');
    // A file wins over an inline copy; a file alone is enough to build on.
    expect(renderBasisSection({ ...facts, cardFile: file })).toBe(
      renderBasisSection({ ...rest, cardFile: file }),
    );
    expect(
      renderBasisSection({ key: "FM3K-9", title: "Groundwork", cardFile: file }),
    ).not.toContain("Read it with the tasks query");
  });

  it("carries the complete card including an amendment beyond the former limit", () => {
    const card = `${"x".repeat(16 * 1024 + 10)}Replacement-only size motion.`;
    const section = renderBasisSection({ ...facts, card });
    expect(section).toContain(card);
    expect(section).not.toContain("cut here");
  });

  it("points at the record when the basis carried no text of its own", () => {
    expect(renderBasisSection({ key: "FM3K-9", title: "Groundwork" })).toContain(
      "Read it with the tasks query, key FM3K-9.",
    );
  });

  it("names the branch while the working copy lives, else the kept work, and quotes the thread", () => {
    const plain = renderBasisSection(facts);
    const withBranch = renderBasisSection({ ...facts, branch: "fm/task-ab12" });
    expect(withBranch).toContain(
      "Its work is on branch fm/task-ab12 in this repository (worktrees share refs: git log fm/task-ab12); start from it when the task builds on it.",
    );
    // The branch wins over a kept ref: a live working copy is the newer truth.
    expect(
      renderBasisSection({
        ...facts,
        branch: "fm/task-ab12",
        keptRef: "refs/infinitary/kept/ab12",
      }),
    ).toBe(withBranch);
    const kept = renderBasisSection({ ...facts, keptRef: "refs/infinitary/kept/ab12" });
    expect(kept).toContain(
      "its work is saved in the repository at refs/infinitary/kept/ab12 (git log refs/infinitary/kept/ab12)",
    );
    const threaded = renderBasisSection({
      ...facts,
      thread: [
        { who: "captain", text: "B, but keep the gear icon" },
        { who: "crewmate", text: "Revised: B keeps the gear icon." },
      ],
    });
    expect(threaded).toContain(
      "What was said under its card, newest last:\n- captain: B, but keep the gear icon\n- crewmate: Revised: B keeps the gear icon.",
    );
    // None of the three: the section is exactly what it was.
    for (const section of [plain, renderBasisSection({ ...facts, thread: [] })]) {
      expect(section).not.toContain("Its work is on branch");
      expect(section).not.toContain("its work is saved");
      expect(section).not.toContain("What was said under its card");
    }
    expect(renderBasisSection({ ...facts, thread: [] })).toBe(plain);
    // The captain's choice on the card, when the basis closed on one.
    expect(renderBasisSection({ ...facts, choice: "Group into sections" })).toContain(
      'The captain closed it by choosing "Group into sections".',
    );
    expect(plain).not.toContain("closed it by choosing");
    // The answers the captain gave the questions on its card (contract 4.22).
    expect(
      renderBasisSection({
        ...facts,
        choice: "Lock the plan",
        answers: ['- read-scope: "Every project your sign-in can see" (all-visible), changed'],
      }),
    ).toContain(
      'The captain closed it by choosing "Lock the plan".\n\nThe captain\'s latest submitted settings/answers (supersede earlier values):\n- read-scope: "Every project your sign-in can see" (all-visible), changed',
    );
    expect(plain).not.toContain("answers to the questions");
    // Its report is presented as the final answer it recorded.
    expect(plain).toContain(
      "Its report - the final answer it recorded:\nThe scheduler never claims",
    );
  });

  it("keeps all thread amendments verbatim regardless of count or size", () => {
    const thread = Array.from({ length: 20 }, (_, index) => ({
      who: "captain",
      text: `message ${index}\n  with a break`,
    }));
    thread.unshift({
      who: "captain",
      text: `Original amendment: ${"a".repeat(4500)}. End of amendment.`,
    });
    const section = renderBasisSection({ ...facts, thread });
    for (const message of thread) expect(section).toContain(`- captain: ${message.text}`);
  });

  it("carries the latest report once, as the answer, and the ones before it as history", () => {
    const reports = [
      { event_id: 11, text: "Full specification: stable external pager." },
      { event_id: 12, text: facts.outcome },
    ];
    const section = renderBasisSection({ ...facts, reports });
    expect(section.split(facts.outcome).length - 1).toBe(1);
    expect(section).toContain(`Its report - the final answer it recorded:\n${facts.outcome}`);
    expect(section).toContain(
      "Its earlier reports in chronological order (history, not additional approval):\nReport event 11:\nFull specification: stable external pager.",
    );
    // A lone report is the answer and nothing else.
    expect(renderBasisSection({ ...facts, reports: reports.slice(1) })).toBe(
      renderBasisSection(facts),
    );
  });

  it("marks each report it copies as that task's event, serving the same text", () => {
    const reports = [
      { event_id: 11, text: "Full specification: stable external pager." },
      { event_id: 12, text: facts.outcome },
    ];
    const parts = basisSectionParts({ ...facts, taskId: "ans9", reports });
    expect(parts.filter((part) => typeof part !== "string")).toEqual([
      { taskId: "ans9", eventId: 12, text: facts.outcome },
      { taskId: "ans9", eventId: 11, text: "Full specification: stable external pager." },
    ]);
    expect(briefText(parts)).toBe(renderBasisSection({ ...facts, reports }));
  });
});

describe("withoutOriginReadLine", () => {
  const filed = renderFollowupBrief(
    {
      goal: "g",
      why: "I quoted it: Read the origin's report and card with the tasks query (PE-1) before continuing.\nNothing else.",
      filedBy: "crewmate 1",
      originTitle: "Clock",
      originKey: "PE-1",
    },
    "direct-pr",
  );

  it("drops the filing's own line and keeps the crewmate's words whole", () => {
    const once = withoutOriginReadLine(filed, "PE-1");
    expect(once.split("Read the origin's report").length - 1).toBe(1);
    expect(once).toContain("I quoted it: Read the origin's report and card with the tasks query");
    expect(once).toContain("Nothing else.\n\nDelivery: direct-pr");
  });

  it("leaves a brief filed from another origin as it is", () => {
    expect(withoutOriginReadLine(filed, "PE-2")).toBe(filed);
  });
});

describe("renderPicturesSection", () => {
  it("is empty for a task that came with no pictures", () => {
    expect(renderPicturesSection({ riding: [], more: [], missing: 0 })).toBe("");
  });

  it("names the copies by path and says which did not fit in one turn", () => {
    const shot = (n: number) => ({ name: `shot-${n}.png`, path: `/app/attachments/m/${n}.png` });
    expect(
      renderPicturesSection({
        riding: [shot(1), shot(2), shot(3), shot(4)],
        more: [shot(5)],
        missing: 0,
      }),
    ).toBe(
      [
        "Pictures: the captain attached 5 pictures to the messages this task came from.",
        "The first 4 pictures ride with this brief; 1 more did not fit in one turn.",
        "The app keeps its own copy of each, which you can open by its path:",
        "- shot-1.png: /app/attachments/m/1.png",
        "- shot-2.png: /app/attachments/m/2.png",
        "- shot-3.png: /app/attachments/m/3.png",
        "- shot-4.png: /app/attachments/m/4.png",
        "- shot-5.png: /app/attachments/m/5.png",
      ].join("\n"),
    );
  });

  it("names no path where the crewmate runs on another computer", () => {
    expect(renderPicturesSection({ riding: [{ name: "only.png" }], more: [], missing: 0 })).toBe(
      [
        "Pictures: the captain attached 1 picture to the messages this task came from.",
        "It rides with this brief.",
        "- only.png",
      ].join("\n"),
    );
  });

  it("counts copies that are gone, says so when none is left, and asks for them (INF-2422)", () => {
    expect(renderPicturesSection({ riding: [], more: [], missing: 2 })).toBe(
      [
        "Pictures: the captain attached 2 pictures to the messages this task came from.",
        "2 pictures could not be found among the app's copies.",
        "Where your work depends on a picture you cannot see, say so plainly and ask the captain on a card to send it again, rather than answering without it.",
      ].join("\n"),
    );
    // Every copy found: nothing to ask for.
    expect(
      renderPicturesSection({
        riding: [{ name: "only.png", path: "/h/only.png" }],
        more: [],
        missing: 0,
      }),
    ).not.toContain("send it again");
  });
});

// INF-1430, approved piece 2: effects, not commits or answer cards.
describe("operations deliverable", () => {
  const intent = parseSpawnIntent({
    goal: "Start the chosen service and verify its health",
    user_words: "start it",
    constraints: [{ kind: "operation" }],
  });
  it("derives an operation independently of a classifier kind", () => {
    for (const kind of ["unclear", "fix", "chore", "research", "implement"] as const)
      expect(deliverableFor(intent, kind)).toBe("operation");
    expect(renderOperationShapeSection()).toContain("effect is the deliverable");
    expect(renderOperationShapeSection()).toContain("stop and report if code must change");
    expect(renderOperationShapeSection()).toContain("Keychain and signing access");
  });
  it("refuses conflicting declarations, including read-only folder work", () => {
    expect(() =>
      parseSpawnIntent({
        goal: "Start it",
        user_words: "start it",
        constraints: [{ kind: "operation" }, { kind: "read-only" }],
      }),
    ).toThrow("cannot be read-only");
    const answer = parseSpawnIntent({
      goal: "Read it",
      user_words: "read it",
      constraints: [{ kind: "read-only" }],
    });
    expect(() => assertDeliverableConstraints(answer, true)).toThrow("cannot be read-only");
  });
});
