# Common workflows

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
spawn or create it. Declare each task's kind on spawn or create; the classifier sorts only what you leave unsorted.

Ask me only what nothing else can settle. A question whose answer is a fact - what the code
does, what happens when it runs, how it looks - is the step's to answer by reading or by
trying it; a question of preference or product is mine. When a fact would take a while to
find, ask me the rest now rather than waiting on it. When an ask rests on a wrong premise or
is not worth doing, say so plainly in the card, with the better direction as the default. In
a change step's report, Risk names the one fact the change is safe because of and how far
you proved it: pointed at it, reasoned it through, or ran it.

## ideation - deciding what to do
- plan: a read-only step. Research the code and the field, then propose two or three
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
  checks and the pieces it truly needs; list order is not a dependency.
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
  successors. File Queued (when-ready) with every blocker in blocked_by.
  Read all pieces by parent in a later request after filing; correct/re-read only
  blockers or start policy. Backlog waits for my word; never bypass it with start_now.
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
