# Programs

A program is a task whose steps a script decides: the first mate writes plain JavaScript, and the host runs it, filing each part as a child task and handing the script each part's checked result (INF-799 piece 2).
It is the agent's reach, not a sequence runner: sequences stay guidance (`docs/sequences.md`), and a program is one more way the first mate may carry out the steps a script can decide - a loop, a fan-out, retries.
The host learns no workflow's name; it runs what the first mate wrote and checks only typed facts.

## Filing a program

`create_task` takes `program`, `{script, args?, bound}`, as a fact of the task's shape (`shape.program`, `src/shared/routingPolicy.ts`).
The rule for it has one home, the Programs runbook (`resources/runbooks/programs/guide.md`); the parameter is served bare to keep the first mate's fixed context inside its boundary.
The host refuses, as tool text with nothing filed (`programRefusal`, `src/core/program/programScript.ts`, and `programShape`, `src/core/program/programRunner.ts`):

- a script that is not a non-empty string, that does not compile as the body of an async function, or that imports code;
- `args` that are not JSON;
- a `bound` that is not a whole number of at least 1;
- a program with no project, on the personal workspace, or with its own `branch_from` (it has no working copy; its parts do);
- an app with no program process.

Filing is consent like a spawn: the captain's ask that led to the program is its consent, and no card is put up per run.
A program task stays open, on the graph like any task, and starts when its start policy says (when-ready, or the captain's start for one on request).

## The dialect

The script's host functions use Infinitary's own names; a Claude workflow script is not promised to run unchanged.

- `task(prompt, {label, schema, from, after, intelligence})` files one part and resolves to its answer: its checked result when `schema` declared a result shape, its report text when not, or `null` when the part was dropped.
  `label` names the part (default `part N`); `from` names an earlier part whose last commit its working copy starts at, and `null` or no `from` starts at the default branch, so a chain's first call may pass its empty `previous`; `after` names earlier parts whose results it builds on, each a `blocks` link.
  `from` and `after` may name a call that is still waiting for a free slot or the bound; the link is made when that call's part is filed, and a call naming one that was refused is refused too.
  `intelligence` optionally requests `low`, `medium`, `high` or `premium` for this part (INF-974); an invalid value refuses the call before filing anything.
  Omission preserves kind-based routing, and the choice is part of the replay digest; calls from older scripts without it retain their digest.
  Premium needs `premium_ask` on the program, from the captain's words; the part carries that consent and keeps the existing premium availability wait.
  A label no earlier call used is refused, and the script's await throws, as does a call whose part cannot be filed.
- `ask(prompt, schema)` is one tool-less typed read through the decision models' one-question session (`DecisionModels.answerJson`, `src/core/program/programAsk.ts`): the answer is JSON the host checks against the schema, asked once more with why when it does not parse or fit, then `null`.
- `log(text)` and `phase(name)` write a line on the program's own timeline; a phase also sets its plan dots.
- `args` is the JSON the program was filed with.
- Parallel parts are ordinary JavaScript: `Promise.all` over `task()` calls.

The script returns the program's result, and its `branch`, a part's label, names the program's branch (see "The end").

## The shapes the first mate is served

The Programs runbook (`resources/runbooks/programs/guide.md`) is the one home of the dialect's rule and of five shapes written in it (INF-799 piece 3).
It names the asks that are programs - "use a workflow", a loop, iteration or "keep at it" until a stop condition, an audit, deep research (never a research step) and a migration of each item or one at a time - and says each is one `create_task program` in the project, when-ready with no parent, never a spawn even when one crewmate could try.
The script's globals are named there too, since a script that reads `bound` or another name `args` does not carry fails when it runs.
The first mate adapts a shape to the ask; the host learns no shape's name and reads nothing of the script beyond what "Filing a program" refuses.

- Workflow: a high planner resolves ambiguity, a medium builder follows the plan, and a high checker challenges the result; each continues the previous branch, and the checker is the returned branch.
- The loop: one part a round up to `args.rounds`, awaited, each `from` the last round's label so it continues that round's commits, its schema `done` and `stuck` flags and what it `learned`; each round's prompt carries the last round's learned note, and earlier rounds' reports stay on their parts for a round to look up, until a round reports done; the first round requests high to choose an approach, later rounds request medium because earlier work narrowed the task, and the round after one that reports `stuck` requests high to reconsider it; it returns the last round as its `branch`.
- Audit: high finders in parallel, one per area or angle, to discover subtle defects, then a medium verifier per finding to check one located claim, with one high recheck when that verifier cannot settle it; it is named apart from the crew's own adversarial review of a change.
- Deep research: medium researchers per question in parallel gather and cite sources for one narrow question, then one high writer `after` them all reconciles conflicting evidence.
- Migrate: a medium part per item applies an established recipe, each `from` the previous item's label, returning the last as its `branch`.

These levels are recommendations the first mate adapts and writes into each `task()` call, never rules the host applies by playbook name.

The guide is served in the first mate's fixed context, whose size is bounded (`tests/firstmate-fixed-context.test.ts`), so each shape is one line; a longer shape is paid for by trimming a repeat elsewhere, recorded in that test's ledger, or by saying a rule in fewer words.

## The runner

Each running program has one process of its own (`src/core/program/programProcess.ts`): an Electron utility process in the app (`src/main/host/programProcess.ts`), a plain fork in tests.
The script runs in a fresh `node:vm` realm whose only names beyond the language are the host functions and `args`: no require, files, network or timers.
`Date.now()`, `new Date()` with no arguments and `Math.random()` throw, so a replay with the same answers makes the same calls.
The realm bounds the script; it is not a security boundary, since its author is the app's own agent.
Each host function the script names is one message to the core's runner (`src/core/program/programRunner.ts`, `programProtocol.ts`), answered with a value or with an error its await throws.

The sweep that starts queued tasks runs a ready program (`dispatchQueuedTask`), and running one that already runs does nothing, so a program a quit stopped runs again at the next start.
A program counts as started when its runner first runs it, an event on its timeline (`TaskService.starts.markProgramStarted`, read by `programStarted`), never `startedAt`, which says a crewmate started and draws the Crewmate tab; it stays open while its script runs, so an on-request program the captain's Start ran is run again by the same sweep after a quit.
It stays running until its end is recorded, so a part's close during that end never starts a second runner.

## Parts

A part is a child task of the program, filed when-ready as an internal step that delivers its branch and its result: `delivery_ask` local-only, never a pull request or a completion card.
It carries the captain's words and constraints the program was filed with, the script's prompt as its goal, `schema` as its result shape and `from` as its `branch_from`, and its brief says how a part ships (`renderProgramPartSection`, `src/core/orchestrator/intentBrief.ts`).
Its record names the call that filed it (`shape.program_part`: the call's number, digest, label and optional intelligence).
`tierFor` reads the selected level before kind-based rules, but after a captain-named model, premium ask or escalation.
The router still owns model selection, saved pins, availability fallback and served-level reasoning; a script requests a slot, not a guaranteed model.
The ledger records a non-premium script choice as R11; the existing closed set of user-facing model-reason lines does not render that new rule, rather than attributing it to the kind.

A part's report that carries the answer its program waits for sorts as row 2b, `program-part` (`docs/report-sort.md`): no wake, and the host closes the part done, answered, its working copy retired with its work saved on its kept ref.
A part that hands its turn to the captain or to the first mate sorts as any other report.
A part's report that names a `check_back` is progress, not its answer, even beside a result: its own work still runs, so the program reads nothing and the part stays open (INF-2037); a part with a result shape may send it without a result.
A part dropped by anyone answers `null`.

## Activity and the task board

Activity shows a program and its direct parts as one row, keyed to the program, with the done count, total parts and stopped count when any part stopped.
The newest feed-worthy event sets the row's time, and grouping happens before the recent-feed limit so a busy program does not push unrelated work out.
The task board shows one program tile in the program's own lane, with the number of finished parts out of the total.
Find still reaches individual parts by key or title, and each part keeps its full timeline.
Ordinary parent/child tasks keep their existing feed lines and board tiles.
These are read-only presentations: no task, event, report or relationship is removed.

## The journal and replay

The task record is the journal: each part's `program_part`, each ask's answer on a note of the program's timeline (`programAsk`), and the number of each log and phase line (`programLine`).
After a quit the script replays from the top, and a call whose digest (`callDigest`: its host function and every argument, with only the label the script wrote, never the default) equals an unconsumed recorded one takes that call's answer instead of running again; only the lines past those the record holds are written again.
A part that reported its answer before the quit is closed on replay: its result when it declared a result shape, its report when not and it handed its turn to nobody.
Timeline compaction never folds the journal: each ask's answer and the program's start carry `journal: true` in their data, which compaction leaves alone (`TaskEventStore`), and its parts' reports are exempt by kind.
Log and phase lines fold like any other line, so a long or looping script keeps its timeline under the cap; a replay reads the highest line number the record holds (`programLine.n`, or the highest a `compacted` row keeps in `programLines`), not a count, so a folded line is never written again.

## Bounds

Parts open at once follow this Mac's processors (`PROGRAM_PARTS_CAP`, a physical limit); a call past it waits until one of the program's open parts closes.
The total is the captain's consent: before the program starts, the first mate proposes `bound`, its upper bound on the script's `task()` calls, and when that number is large it asks the captain on a card first - how large is the first mate's judgment, never the host's.
A call past the bound is held and nothing is filed: the `program-bound` soft hold (`src/shared/holds.ts`, `docs/delivery-rigor.md` "The holds").
The program's timeline says it is held, and the first mate hears it once per bound value (the `program-bound` wake), to ask the captain on a card.
On the captain's words it raises the bound with `update_task program_bound`, which the host takes only on a turn that carries the captain's words, and the held call is filed; or it drops the program.

## The end

When the script returns, the parts it never waited for are dropped - only its parts: a task the first mate filed under the program that is not one of its parts keeps running - and the returned value is the program's typed result - checked against the program's own `result_schema` when it declared one - recorded as its report; the program closes done.
Its branch is only the part its script names by label in the returned object's `branch`, such as `return { branch: "cap", ... }`: a shipping task names that part in `branch_from` to start at its saved work.
A script that returns no `branch`, or an empty one (`null` or `""`), leaves nothing to ship and keeps its result, and the `program-ended` wake says so; the host never picks a part for it.
A thrown error, a result that does not fit, or a non-empty `branch` naming no part that finished done closes the program dropped as failed, with the reason.
Either way the first mate hears it once (the `program-ended` wake, naming the result and the branch).

Dropping a program with `update_task drop` stops its process, drops its started parts with their work saved, and drops the program; a drop the host refuses leaves the program running.

## Tests

`src/core/program/programScript.test.ts` (what is refused, the digest), `programRunner.test.ts` (through the forked process: answers, the realm's missing clock, replay after a quit, the bound and its raise, `from: null`), `programAsk.test.ts` (parse and the retry), `src/core/orchestrator/reportSort.test.ts` (row 2b), and `crewPrograms.test.ts` (a program files its parts, reads their results, finishes and wakes the first mate; the bound wake).
`tests/e2e/program-run.spec.ts` runs a program in the launched app: the first mate files it in a project, its three parts run as child tasks, and it closes done with the script's result.
The replay fixture `oct22-program` (`tests/fixtures/replay/README.md`) holds the first mate answering a loop ask with the loop shape, and `tests/replay-captain-session.test.ts` replays it as one program task the runner starts; the replay runs no script (`docs/replay-harness.md`).
