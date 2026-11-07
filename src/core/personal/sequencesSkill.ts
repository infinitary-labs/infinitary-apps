import { createHash } from "node:crypto";
import { readFileSync, type Stats, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACE_SKILLS_DIR } from "./workspaceSkills";

/**
 * How the captain wants work of each kind approached (docs/sequences.md):
 * a document in the personal workspace, `.claude/skills/sequences/SKILL.md`
 * under `userData/fleet/personal/`, that the Firstmate is served after its
 * byte-stable prompt. The host never parses it: the Firstmate reads it and
 * opens an ask of more than one step as a parent task with child steps, with
 * the task tools it already has.
 *
 * App-managed guidance refreshed from this packaged seed on workspace setup
 * and app updates. Local edits are overwritten; a future customization flow
 * is explicitly deferred.
 */
export const SEQUENCES_SKILL_RELATIVE_PATH = join(WORKSPACE_SKILLS_DIR, "sequences", "SKILL.md");

export const SEQUENCES_SKILL_HEADER = `---
name: sequences
description: How the captain wants work of each kind approached. The first mate reads it when it opens a new ask; this app-managed file is refreshed on updates.
---

`;

/**
 * The packaged plan-step lines, whitespace-normalized the way a relayed
 * constraint is. A line is its whole bullet: the first line and every
 * indented line under it. Attaching one is a closed fact: the text equals a
 * line this seed defines, not a reading of the captain's words.
 */
export function packagedPlanStepLines(seed = SEQUENCES_SEED): string[] {
  return [...seed.matchAll(/^- (plan:.*(?:\n[ \t].*)*)/gm)].flatMap((match) => {
    const text = match[1]?.replace(/\s+/g, " ").trim();
    return text ? [text] : [];
  });
}

/** Whether the spawn attached a packaged plan step, word for word. */
export function planStepAttached(
  constraints: readonly { kind: string; text?: string }[] | undefined,
): boolean {
  const lines = new Set(packagedPlanStepLines());
  return (constraints ?? []).some(
    (constraint) =>
      constraint.kind === "free" &&
      constraint.text !== undefined &&
      lines.has(constraint.text.replace(/\s+/g, " ").trim()),
  );
}

/**
 * The plan step's whole instruction, the one packaged plan line: the feature
 * sequence points at it rather than repeating it, and says to relay it whole, so
 * a relayed line is never a pointer to text the planner was not given
 * (packagedPlanStepLines).
 */
const PLAN_STEP = `a read-only step. Research the code and the field, then propose two or three
  directions as one card when it is ambiguous, with the one you would take as the default.
  When I ask for a prototype, a mock-up or to try something, it is this plan with a playable
  preview as the card: the thing itself, adjustable, its settings staged for the build.
  Its questions come in rounds: every question I can answer now, numbered, each with the
  answer you would give; a question that depends on another's answer waits for the next
  revision; when my words could mean two things, ask which, with an example of each. The
  plan is agreed when no question is left and nothing is assumed without saying so - list
  what you assumed.
  The recorded spec says what done looks like in a way the next step can check, what it
  leaves alone, and what is out of scope.
  Before the plan is final, record whether the build is one change or separate pieces, with
  one reason. Split only for distinct outcomes worth merging apart, each safe to stop at once
  its prerequisites are in and with its own checks, and a benefit you can name (smaller
  review, isolated risk, parallel work, my control at a gate); never split a change from its
  checks, by file or layer, or a bounded piece smaller. Each piece gets a real title, outcome,
  checks and the pieces it truly needs; list order is not a dependency.`;

/** The built-in text: the document's body as seeded, and the fallback when the file is unusable. */
export const SEQUENCES_SEED = `# Sequences

An ask that takes one step is that step alone, without a parent; a programs ask is a program.
Open an ask that takes more than one step as a parent task, left on
request, and its steps as child tasks: spawn the step that runs now under it, and file the
next step on request pending approval; approved pieces follow feature/pieces. Each step is one kind (plan, retrieval, research,
reproduce, implement, fix); start each later step when its turn comes.
Validate inside implement/fix at project rigor, never as its own step.
An effect, not code, is an operation: declare operation. Code chores remain changes.
Each step you add yourself is an internal step: say so when you create it
(internal_step), and once the next step has started, close it as answered. An answer I ask
for myself is never an internal step - a plan, a reproduction, some research, or a step's
result I asked to see ("show me the repro first"): it shows its answer as a card, it is
mine to close, and the next step starts on my choice there. The parent completes when its
last step merges.
Authorized steps that need nothing from each other run at once; one that builds on another
waits for it and names it as its basis.
A step whose answer the next needs as data gets result_schema (JSON Schema, object root);
one continuing another's code names it in branch_from (update_task: {} or "" clears either).
Skip the plan only when you can name
one place the change touches, no rule, state transition, or meaning changes, and the
result is checkable by looking. Declare why in shape.skipped_plan_because.
Plan first for a symptom without a reproduction, a wording or look that needs choosing,
trust, what a click or setting means, motion, or several screens. In doubt plan. A plan
is a crewmate task, never your own card. A step's line from this
document reaches its crewmate word for word: put it in the step's constraints when you
spawn or create it.

Ask me only what nothing else can settle. A question whose answer is a fact - what the code
does, what happens when it runs, how it looks - is the step's to answer by reading or by
trying it; a question of preference or product is mine. When a fact would take a while to
find, ask me the rest now rather than waiting on it. When an ask rests on a wrong premise or
is not worth doing, say so plainly in the card, with the better direction as the default. In
a change step's report, Risk names the one fact the change is safe because of and how far
you proved it: pointed at it, reasoned it through, or ran it.

## ideation - deciding what to do
- plan: ${PLAN_STEP}
- When an idea is too big to plan in one step, the parent's goal is the destination - what
  reaching it looks like - and each decision that can be stated now is its own plan step,
  one at a time, the next starting on my choice; the card lists what is not yet clear enough
  to ask, and what I rule out of scope stays out.

## feature - building something new, or an unclear ask
- The plan is the ideation plan line, relayed whole; wait for my choice.
- implement: on request until I accept, then Queued. Ground it on the plan (basis) - its
  recorded spec and my choice - from the plan's branch if it has one; on Save and defer it
  waits on request until I press Start or ask. The simplest change that meets the accepted
  plan.
- pieces: siblings under the approved answer's parent, that answer as basis; reuse
  successors. Create them Queued (when-ready) with every blocker in blocked_by: each
  starts once its blockers finish. Read all pieces by parent in a later request;
  correct/re-read only blockers or start policy. Backlog waits for my word; never bypass
  it with start_now.
  Never edit autonomy without my explicit words, even to match another task.
  One successor per change.

## bugfix - something is broken
- reproduce: a read-only step. Reproduce it as reported, in a clean setup, and put the
  failing check in the report. Open your report with "reproduced: yes" or "reproduced: no".
  Keep what you established apart from what you inferred; a guess in my report is one
  candidate, not the answer.
- fix: on request. On "reproduced: yes" start it grounded on the reproduction (basis), then
  close the reproduce step as answered; on "reproduced: no" ask me first. The smallest
  root-cause fix; it adds the failing check and makes it pass.
  Trace the cause with evidence from the running code, never from a guess; a guard that
  silences the failure is not a fix. The failing check is a test when one is cheap
  and honest, else the closest real check, and the report shows it failing before and
  passing after, on the surface the bug was reported on. When a second attempt fails the
  same check, write down what both attempts assumed and question it before a third.

## refactor - changing structure, not behaviour
- implement: one step. First prove the coverage of what the refactor touches and add the
  guardrails missing until it passes; then refactor under them.
  A guardrail fails when behaviour changes; a type check or lint is not one. Move every
  caller and delete the old path in the same change - no compatibility layer. Prefer
  deleting to adding; a result no simpler to read than before does not ship.

## explainer - understanding something
- retrieval: a fact, or how or why, from what the app reads now: code, its history, task
  record, docs, the fleet's computers, checks, GitHub runs. Past runs compared, a
  reproduction, a measurement or the web makes it research.
- research: investigation beyond that boundary.
For either: read-only; the goal names every source the answer needs, another computer
included. One drawn card with citations, revised on my questions. Separate fact from
inference; my premise is not fact. "Not established" names missing or conflicting
evidence, not permission to broaden. My Look deeper starts research built on it, naming
the missing source.

## programs
"Use a workflow", "loop/iterate/keep at it until <stop condition>", "audit", "deep
research" (not a research step), "migrate each / one at a time": create_task program
{script, args, bound}, never spawn; when-ready, no parent. integer bound caps task() calls;
ask by card if large. JS globals: task, ask, log, phase, args (= program.args).
task(prompt, {label, schema, from, after, intelligence}) returns result/null; from:
prior label; after: awaited labels; ask(prompt, schema); return {branch: label} ships it.
intelligence: low/medium/high/premium; omitted: default routing; premium needs
captain premium_ask on program. Medium for narrowed work; high for open or final work.
- workflow: high plan, medium build, high check; from previous; return check branch.
- loop: up to args.rounds, await each, from previous label, schema {done, stuck, learned},
  prompt args.goal + last learned; high first and after stuck, else medium; stop on done;
  return last branch.
- audit: Promise.all high finders per area, medium verify per finding; one high recheck if unsettled.
- deep research: Promise.all medium per question, high writer after all.
- migrate: medium per item, from previous; return last branch.

## personal projects and panels
A game or anything else to play or use on its own belongs in its own project.
Something to glance at beside your work on the app's rails is a panel.
- project: in an existing project, ordinary work there, no setup card. A new game, toy,
  page or small app: its own project via app_change project-setup; only Add project
  adds it. Serious: the ask names a framework, engine or build step, hosting or a store, a
  sign-in or database, a team or customer, or a release or launch; propose autonomy false,
  rigor standard, a plan first, and follow the chosen stack. Otherwise casual (for fun or
  yourself, small, nothing to ship): propose local-only, autonomy true, rigor quick, work
  naming the project and why it is assumed casual; build plain HTML, CSS and JavaScript
  whose index.html opens with no install or server, not a panel. Plan skipping
  is the rule above. Play-test and photograph a casual web project in your task
  browser via a local server; when done, emit a note beside the merge card
  with that picture, browser_button Open and browser_page index.html; never wait on it.
- panel: personal_ui true.

`;

/** A document past this size is not served: the built-in text is, with one feed line. */
export const SEQUENCES_MAX_BYTES = 16 * 1024;

/**
 * Refresh the packaged seed whenever the file is missing or differs. The
 * workspace seeder commits app-authored updates (./workspace.ts).
 */
export async function seedSequencesSkill(workspaceDir: string): Promise<boolean> {
  const path = join(workspaceDir, SEQUENCES_SKILL_RELATIVE_PATH);
  const content = `${SEQUENCES_SKILL_HEADER}${SEQUENCES_SEED}`;
  try {
    const existing = readFileSync(path, "utf8");
    if (existing === content) return false;
  } catch {
    // Missing or unreadable: restore the packaged content.
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return true;
}

/** The document without its front matter: what the Firstmate is served. */
export function sequencesBody(markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return body.trim();
}

/** Why the file could not be served; the built-in text is served instead. */
export type SequencesFallback = "unreadable" | "empty" | "oversized";

/** What the Firstmate is served, and its provenance stamp. */
export type ServedSequences = {
  text: string;
  /** sha256 of `text`: the `instructions_sha` the session records. */
  sha: string;
  /** Present when the file exists but could not be served. */
  fallback?: SequencesFallback;
};

export function sequencesSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const SEED_SERVED: ServedSequences = {
  text: SEQUENCES_SEED.trim(),
  sha: sequencesSha(SEQUENCES_SEED.trim()),
};

/**
 * Reads the document at an idle boundary: one `stat` per turn, and a read
 * only when the file's size or modification time moved. Synchronous on
 * purpose - a stat and at most 16 KB, right before a prompt, so nothing can
 * slip in between the read and the turn it serves. An absent file (or
 * no workspace at all) serves the built-in text quietly - the seeder writes
 * it on its next pass; a file that exists and cannot be served (unreadable,
 * empty, over `SEQUENCES_MAX_BYTES`) serves the built-in text with its
 * reason, so the caller can say so once.
 */
export class SequencesSource {
  private stamp: string | undefined;
  private served: ServedSequences = SEED_SERVED;

  constructor(private readonly workspaceDir: string | undefined) {}

  current(): ServedSequences {
    if (!this.workspaceDir) return SEED_SERVED;
    const path = join(this.workspaceDir, SEQUENCES_SKILL_RELATIVE_PATH);
    let info: Stats;
    try {
      info = statSync(path);
    } catch (caught) {
      this.stamp = undefined;
      const absent = (caught as NodeJS.ErrnoException).code === "ENOENT";
      this.served = absent ? SEED_SERVED : { ...SEED_SERVED, fallback: "unreadable" };
      return this.served;
    }
    const stamp = `${info.size}:${info.mtimeMs}`;
    if (stamp === this.stamp) return this.served;
    this.stamp = stamp;
    this.served = this.read(path, info.size);
    return this.served;
  }

  private read(path: string, size: number): ServedSequences {
    if (size > SEQUENCES_MAX_BYTES) return { ...SEED_SERVED, fallback: "oversized" };
    let markdown: string;
    try {
      markdown = readFileSync(path, "utf8");
    } catch {
      return { ...SEED_SERVED, fallback: "unreadable" };
    }
    const text = sequencesBody(markdown);
    if (!text) return { ...SEED_SERVED, fallback: "empty" };
    return { text, sha: sequencesSha(text) };
  }
}
