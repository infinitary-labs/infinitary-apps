# Programs

A program is a task whose steps a script decides: the first mate writes plain JavaScript, and the host runs it, filing each part as a child task and handing the script each part's checked result.

## Intended use

Compose loops, parallel fan-outs, retries and typed answers when a script can decide the steps, as one task the host runs.
The shapes the first mate is served are the workflow, the loop, the audit, deep research and the migration; "use a workflow", a loop toward a stop condition, an audit, deep research and a migration of each item are each one `create_task program`, when-ready with no parent.
A program is the agent's reach, not a sequence runner: the host learns no workflow's name, runs what the first mate wrote, and checks only typed facts.

## When to use it, and when not

Use a program when the next step follows mechanically from earlier results: a fixed loop, a fan-out with `Promise.all`, a chain of parts that each continue the last one's commits.
When the steps need judgment between them, or the captain's choice between them, instructions alone suffice: a parent with child steps the first mate starts on each wake ([tasks.md](tasks.md), [sequences](../docs/sequences.md)).
When one piece of work suffices, spawn one task; a program with one part adds nothing.
Do not build a feature-specific runner, step table or scheduler for a repeated shape: write the shape in the served guide's `programs` section and let the first mate file it as a program.
Do not ask a program to classify or judge in code: `ask()` is a typed model read ([decision-questions.md](decision-questions.md)), and a part is a crewmate.
Task relation semantics (parent, `blocks`, basis, `branch_from`, typed results) are owned by [tasks.md](tasks.md); a program only uses them.

## Owner and entry points

`ProgramRunner` ([`../src/core/program/programRunner.ts`](../src/core/program/programRunner.ts)) runs each program and answers its host-function messages through a `ProgramHost`, which the crew's `CrewPrograms`, in the same file, supplies; the crew supervisor composes both.
Filing checks: `programRefusal` and `callDigest` in [`../src/core/program/programScript.ts`](../src/core/program/programScript.ts), and `programShape` in [`../src/core/program/programRunner.ts`](../src/core/program/programRunner.ts).
`ask()`: `askJson` and `parseAnswer` in [`../src/core/program/programAsk.ts`](../src/core/program/programAsk.ts), over `DecisionModels.answerJson`.
The process: [`../src/core/program/programProcess.ts`](../src/core/program/programProcess.ts) (an Electron utility process from [`../src/main/host/programProcess.ts`](../src/main/host/programProcess.ts) in the app, a plain fork in tests), with messages in [`../src/core/program/programProtocol.ts`](../src/core/program/programProtocol.ts).
The fact on the task: `shape.program` (`{script, args?, bound}`) in [`../src/shared/routingPolicy.ts`](../src/shared/routingPolicy.ts); the rule's one home is the served guide's preamble in [`../src/core/personal/sequencesSkill.ts`](../src/core/personal/sequencesSkill.ts).

## Operations and lifecycle

The dialect, in Infinitary's own names (a Claude workflow script is not promised to run unchanged):

- `task(prompt, {label, schema, from, after, intelligence})` files one part and resolves to its checked result, its report text, or `null` when the part was dropped.
- `intelligence` chooses a slot per part; omission keeps ordinary routing, and premium needs the captain's `premium_ask` on the program.
- `from` names the earlier part whose last commit the part starts at (its `branch_from`); `after` names parts it builds on, each a `blocks` link.
- `ask(prompt, schema)` is one tool-less typed read; `log(text)` and `phase(name)` write the program's timeline; `args` is the JSON it was filed with.

A program is open on the graph like any task and starts by its start policy; the ready sweep runs it (`dispatchQueuedTask`), and running a program that already runs does nothing.
It counts as started when the runner first runs it (`TaskService.starts.markProgramStarted`), never by `startedAt`.
A part is a child task filed when-ready as an internal step, local-only, with no pull request or merge card; its report that carries the awaited answer closes it done with no wake (report-sort row 2b, `program-part`).
The task record is the journal: each part's `program_part` (call number, digest, label), each ask's answer and each log line's number.
After a quit the script replays from the top, and a call whose digest matches an unconsumed recorded one takes the recorded answer instead of running again.
The script's realm has no require, files, network or timers, and `Date.now()`, argument-less `new Date()` and `Math.random()` throw, so a replay makes the same calls.
When the script returns, unawaited parts are dropped and the returned value, checked against the program's own `result_schema` when declared, is its result; the program closes done.
Its branch is only the part its script names in the returned `branch`; the host never picks one, and a shipping task names that part in `branch_from`.

## Authority

Filing a program is consent like a spawn: the captain's ask that led to it is its consent, and no card is put up per run.
`bound` is the captain's consent to the total number of `task()` calls; the first mate proposes it, and asks the captain on a card first when it is large, which is the first mate's judgment.
A call past the bound is held under the `program-bound` soft hold ([`../src/shared/holds.ts`](../src/shared/holds.ts)); only `update_task program_bound` on a turn carrying the captain's words raises it.
Parts open at once follow this computer's processors (`PROGRAM_PARTS_CAP`), a physical limit, not a verdict.
The realm bounds the script but is not a security boundary, since its author is the app's own agent.

## Compositions

- Parts are ordinary child tasks, so the record, follow-ups, holds and settle rules apply to them unchanged ([tasks.md](tasks.md)).
- Activity folds a program and its parts into one progress row, and the task board folds them into the program tile; Find still reaches a part, and each part keeps its full record.
- `ask()` reuses the decision models' one-question session ([decision-questions.md](decision-questions.md)).
- A part's result shape and branch hand-off reuse `result_schema` and `branch_from`.
- The `program-part`, `program-bound` and `program-ended` wakes ride the durable inbox ([report sort](../docs/report-sort.md), [inbox](../docs/inbox.md)).

## Failure and recovery

Filing refuses as tool text with nothing filed: a script that does not compile as an async function body or imports code, non-JSON `args`, a `bound` under 1, no project, the personal workspace, its own `branch_from`, or an app with no program process.
A `task()` call naming an unknown label, or a part that cannot be filed, throws into the script's await.
`ask()` asks once more with why when the answer does not parse or fit, then answers `null`.
A thrown error, a result that does not fit, or a `branch` naming no part that finished done closes the program dropped as failed, with the reason; the first mate hears the end once (`program-ended`).
A quit reruns the program at the next start and replays its journal; compaction never folds the journal.
`update_task drop` stops the process, drops started parts with their work saved, and drops the program.

## Uses

- Loop toward a goal: one part per round, each `from` the last round, until a round reports `done` (served shape; replay fixture `oct22-program`).
- Audit: finders in parallel, then a verifier per finding.
- Deep research: a part per question in parallel, then one writer `after` them all.
- Migrate: a part per item, each `from` the previous item.

## Checks

- [`../src/core/program/programScript.test.ts`](../src/core/program/programScript.test.ts): refusals and the digest.
- [`../src/core/program/programRunner.test.ts`](../src/core/program/programRunner.test.ts): answers, the realm's missing clock, replay after a quit, the bound and its raise.
- [`../src/core/program/programAsk.test.ts`](../src/core/program/programAsk.test.ts): parsing and the retry.
- [`../src/core/orchestrator/reportSort.test.ts`](../src/core/orchestrator/reportSort.test.ts) (row 2b) and [`../src/core/orchestrator/crewPrograms.test.ts`](../src/core/orchestrator/crewPrograms.test.ts).
- [`../tests/e2e/program-run.spec.ts`](../tests/e2e/program-run.spec.ts) and [`../tests/firstmate-fixed-context.test.ts`](../tests/firstmate-fixed-context.test.ts) (the served guide's size).

## Where the detail lives

Programs (a script the host runs as a task, its dialect, the runner, its parts, the journal and replay, its bounds) `docs/programs.md`.
Sections of [programs](../docs/programs.md): "Filing a program", "The dialect", "The shapes the first mate is served", "The runner", "Parts", "The journal and replay", "Bounds", "The end", "Tests".
[Sequences](../docs/sequences.md), "The decision", for where programs stop and guidance begins.
