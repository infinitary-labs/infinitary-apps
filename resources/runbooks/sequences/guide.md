# Common workflows

An ask that takes one step is that step alone, without a parent; a programs ask goes to
one crewmate (Programs).
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
mine to close, and the next step starts on my choice there. A parent holds its steps and
is never the step that builds: when its goal names something to deliver, a child task
delivers it. The parent completes when its last step merges, so before you close its last
open part, compare its goal and its plan's pieces with its parts, and file what is missing.
Authorized steps with no dependency on each other run in parallel; a step that builds on
another waits for it and names it as its basis.
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

Bring me only the questions no other source can answer. When the answer is a fact - what
the code does, what happens when it runs, how it looks - the step finds it by reading or by
trying it; preference and product questions are mine. If a fact will take time to establish,
put the remaining questions to me now instead of holding them back. If an ask stands on a
mistaken premise or is not worth the effort, say that directly in the card and make the
better direction the default. In a change step's report, Risk names the single fact that
makes the change safe and how far you proved it: pointed at it, reasoned it through, or ran
it.

## ideation - choosing what to build
- plan: a read-only step. Research the code and the field, then propose the plan you
  would build as one card. Its questions are the decisions only I can make: ones where I
  give something up whichever answer I choose. Each option says what a person gets with it
  that the other answers do not give, and what it costs. An answer that gets a person
  nothing your plan does not already give is not an option; when that leaves one answer,
  state it as a fact, and say in one folded line why you ruled the other out. A decision
  the code, my words or the project's rules settle is yours: make it and say so.
  When I ask for a prototype, a mock-up or to try something, it is this plan with a playable
  preview as the card: the thing itself, adjustable, its settings staged for the build.
  Ask in rounds: number every question I can answer now and put your own answer beside
  each; hold a question that hangs on another's answer for the next revision; where my words
  allow two readings, ask which one, with an example of each. We agree on the plan once no
  question is open and every assumption is stated - list the ones you made.
  The recorded spec gives the next step a checkable picture of done, names what stays
  untouched, and names what is out of scope.
  Before the plan is final, record whether the build is one change or separate pieces, with
  one reason. Split only when each piece is an outcome of its own worth merging separately,
  a safe place to stop once its prerequisites are in, with its own checks and a benefit you
  can name (smaller review, isolated risk, parallel work, my control at a gate); never
  separate a change from its checks, never cut along files or layers, and never cut a
  bounded piece into smaller ones. Each piece gets a real title, outcome,
  checks and the pieces it truly needs; list order is not a dependency. Mark a piece to start
  when the piece before it is approved to merge only when it needs that piece's code and that
  piece is settled once I approve it.
- An idea too large for one plan step gets a parent whose goal describes the end state, as
  it will look once reached. Every decision that can already be put into words becomes its
  own plan step, taken one after another, each starting on my choice in the one before; the
  card names what is still too vague to ask, and whatever I rule out of scope stays out.

## feature - new work, or an ask that is not yet clear
- The plan is the ideation plan line, relayed whole; wait for my choice.
- implement: on request until I accept, then Queued. Ground it on the plan (basis) - its
  recorded spec and my choice - from the plan's branch if it has one; on Save and defer it
  waits on request until I press Start or ask. The simplest change that meets the accepted
  plan.
- pieces: siblings under the approved answer's parent, that answer as basis; reuse
  successors. File every piece the plan names on approval, the last one included, each in
  the project the plan names. Create them Queued (when-ready) with every blocker in
  blocked_by: each starts once its blockers finish. For a piece the plan marks to start at
  approval, name that blocker in start_at_approval too: on batched pull requests it starts on the
  approved version and merges behind it; elsewhere it waits for the merge. A piece whose steps come later (a plan
  for each part first) is filed on request now, blocked by the steps that exist; add each
  new step to its blockers as you file it. Read all pieces by parent in a later request;
  correct/re-read only blockers or start policy. Backlog waits for my word; never bypass
  it with start_now.
  Never edit autonomy without my explicit words, even to match another task.
  One successor per change.

## bugfix - repairing what is broken
- reproduce: a read-only step. Reproduce it as reported, in a clean setup, and put the
  failing check in the report. Open your report with "reproduced: yes" or "reproduced: no".
  Separate what you established from what you inferred; a guess in my report is
  one candidate, not the answer.
- fix: on request. On "reproduced: yes" start it grounded on the reproduction (basis), then
  close the reproduce step as answered; on "reproduced: no" ask me first. The smallest
  root-cause fix; it adds the failing check and makes it pass.
  Find the cause from what the running code shows, not from a hunch; hiding the failure
  behind a guard does not fix it. Use a test as the failing check when one is cheap and
  honest, otherwise the nearest real check, and show it in the report failing before the
  change and passing after, on the surface where the bug was reported. If a second attempt
  fails the same check, write down what both attempts assumed and question it before trying
  a third time.

## refactor - reshaping code without changing behaviour
- implement: one step. Before changing any structure, prove that checks cover what the
  refactor touches, adding the missing guardrails until they do; then refactor with them in
  place. A guardrail is a check that fails when behaviour changes; type checks and lint do
  not count. Update every caller and remove the old path in the same change, leaving no
  compatibility layer. Removing code beats adding it; a result that is not simpler to read
  than before does not ship.

## explainer - answering a question
- retrieval: a fact, or how or why, from what the app reads now: code, its history, task
  record, docs, the fleet's computers, checks, GitHub runs. Past runs compared, a
  reproduction, a measurement or the web makes it research.
- research: investigation beyond that boundary.
For either: read-only; the goal names every source the answer needs, another computer
included. One drawn card with citations whose first sentence answers my question as
asked, revised on my questions. Separate fact from inference; my premise is not fact.
"Not established" follows the answer, naming missing or conflicting evidence, never
replacing it or permission to broaden. My Look deeper starts research built on it,
naming the missing source; so does a retrieval report that its sources hold no
meaningful answer, at once, with no card for me, closing the retrieval as answered.
A reply a retrieval hands back starts the work my words need, built on its answer, at
once, as if I had asked. Add no limit narrower than the kind's own unless I asked.
