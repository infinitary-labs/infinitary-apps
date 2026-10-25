import { reviewerOverrideWords } from "@shared/holds";
import { describe, expect, it } from "vitest";
import {
  basisSectionParts,
  briefText,
  deliverableFor,
  parseSpawnIntent,
  REVIEW_FIX_RULES,
  renderAnswerShapeSection,
  renderBasisSection,
  renderEscalationBrief,
  renderFollowupBrief,
  renderIntentBrief,
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

  it("fails loud on missing goal, missing user words, textless free, unknown kind", () => {
    expect(() => parseSpawnIntent({ goal: " ", user_words: "x" })).toThrow(/goal is required/);
    expect(() => parseSpawnIntent({ goal: "g", user_words: " " })).toThrow(
      /user_words is required/,
    );
    expect(() =>
      parseSpawnIntent({ goal: "g", user_words: "x", constraints: [{ kind: "free" }] }),
    ).toThrow(/needs its text/);
    expect(() =>
      parseSpawnIntent({ goal: "g", user_words: "x", constraints: [{ kind: "yolo" }] }),
    ).toThrow(/Unknown constraint kind/);
  });
});

describe("renderIntentBrief", () => {
  it("renders the fixed template: goal, verbatim user words, constraints, delivery", () => {
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
    expect(lines[0]).toBe("Goal: The meter works");
    expect(brief).toContain(
      "The user's words, verbatim - these outrank every elaboration below, including your own:\nfix the meter",
    );
    expect(brief).toContain("- plan first: present your plan as a decision card");
    expect(brief).toContain("- no new dependencies");
    expect(brief).toContain("- keep the public API stable");
    expect(brief).toContain(
      "Delivery: direct-pr - finished work is pushed and opened as a pull request where the project lives (git push, then open_change).",
    );
    expect(brief).toContain("Delivery note: stack on top of PR 41");
    // The user's words come before every constraint elaboration.
    expect(brief.indexOf("fix the meter")).toBeLessThan(brief.indexOf("Constraints:"));
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
    expect(brief).toContain("never a completion card");
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
      "Before every report, lint_panel checks your files, place_panel puts your version on the captain's rail and says whether their window drew it, and capture_panel photographs it there.",
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
      "file it as Continue: …",
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

describe("renderRigorSection (delivery rigor phase 2)", () => {
  it("names each tier in one line, and only the reviewed line withholds the completion card", () => {
    const quick = renderRigorSection("quick");
    const standard = renderRigorSection("standard");
    const reviewed = renderRigorSection("reviewed");
    for (const line of [quick, standard, reviewed]) {
      expect(line.startsWith("Rigor: ")).toBe(true);
      expect(line).not.toContain("\n");
    }
    expect(quick).toBe(
      "Rigor: quick - the repository's own gate and green CI; the five headings are welcome, nothing more is required.",
    );
    expect(standard).toBe(
      "Rigor: standard - the fixed pre-PR procedure, the five headings on the report, three CI rounds then a blocker report.",
    );
    // The reviewed line orders the sequence: review BEFORE the pull
    // request (captain ruling, 2026-09-19), no card until Firstmate says
    // so.
    expect(reviewed).toContain("the review comes BEFORE the pull request");
    expect(reviewed).toContain("do not push, open a PR, or emit a completion card yet");
    expect(reviewed).toContain("An independent reviewer reads your branch");
    expect(reviewed).toContain(
      "After the review passes, push, open the PR, drive CI green, and the first mate tells you when to emit the completion card.",
    );
    // INF-148: a passed review holds across a pure update onto newer main.
    expect(reviewed).toContain(
      "A passed review holds when a later version is the same change; any edit asks a fresh review.",
    );
    // How to fix a relayed finding is the builder's own rule (FI3-566 cut
    // C), so the Firstmate relays findings verbatim without restating it.
    expect(reviewed).toContain(
      "the first mate relays its findings as steers and your fixes land as local commits. To fix them, double-check each finding is legitimate before changing code, identify all sibling sites of the broken invariant, repair the whole defect class with one small correction rather than new machinery, retrace normal callers, never resolve a finding by reverting the author's intentional change, never implement a finding the captain declined or undo a fix the captain chose merely to satisfy an earlier goal, and verify each is resolved. After the review passes",
    );
    expect(quick).not.toContain("reviewer");
    expect(standard).not.toContain("reviewer");
    expect(quick).not.toContain(REVIEW_FIX_RULES);
    expect(standard).not.toContain(REVIEW_FIX_RULES);
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
      holds: ["rerun" as const],
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
    expect(
      brief.startsWith(
        'Goal: review the change for "Fix the flaky meter test" and report findings.',
      ),
    ).toBe(true);
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
      "The verdict report is the whole deliverable of this internal review; emit no outcome card.",
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
    // The finding shape with the ported severity and action vocabulary.
    expect(brief).toContain(
      "Report one finding per line: id, severity (error: should absolutely not get merged; warning: worth addressing but can be done in a follow up; info: nice to have), file and line, one sentence, and an action",
    );
    expect(brief).toContain(
      "ask-user for anything about functional requirements or product behavior, or that challenges a deliberate choice, even if it looks wrong, and when in doubt",
    );
    // The two lines the host parses, the info-never-blocks rule, and the
    // ported risk ladder.
    expect(brief).toContain(
      "Open your report with exactly one line, verdict: pass|findings|blocked, and close with one line, risk: low|medium|high",
    );
    expect(brief).toContain("high: should not be merged without explicit human approval");
    expect(brief).toContain(
      "Info findings never block: a review whose findings are all info/no-op is read as a pass.",
    );
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
      "Delivery: direct-pr - finished work is pushed and opened as a pull request where the project lives (git push, then open_change).",
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
    expect(deliverableFor(undefined, "teach")).toBe("change");
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
    expect(section).toContain("Your report stays the short factual account");
    // The report is the answer the task keeps: re-recorded in full when the
    // captain's replies change it, so work built on it starts from it.
    expect(section).toContain("report it again in full - the final agreed version");
  });
});

describe("the answer shape of a step the Firstmate declared (docs/sequences.md)", () => {
  it("hands the answer on in the report, with a card only for the captain's decision", () => {
    const step = renderAnswerShapeSection(true);
    expect(step).toContain("a step whose answer the next step builds on");
    expect(step).toContain("Your report is that answer and is handed to the next step verbatim");
    expect(step).toContain(
      "Show a card, as any crewmate does, when the captain must decide or see something",
    );
    expect(step).toContain("Rigor: none - this task ships nothing.");
    expect(step).not.toContain("it lands as one card");
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

  it("counts copies that are gone, and says so when none is left", () => {
    expect(renderPicturesSection({ riding: [], more: [], missing: 2 })).toBe(
      [
        "Pictures: the captain attached 2 pictures to the messages this task came from.",
        "2 pictures could not be found among the app's copies.",
      ].join("\n"),
    );
  });
});
