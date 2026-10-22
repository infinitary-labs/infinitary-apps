# Keeping the agent's reach

The principle "Build the agent's reach, never its verdicts" (`docs/principles.md`, 2026-10-19) is kept by three nets, each the cheapest that sees its kind of slip (INF-484, move 8).
Typed, on every push: the hold registry (`docs/delivery-rigor.md`, "The holds") and the limits ledger, both in `pnpm check`.
Measured, on each change that reaches them: the replay gate (`docs/replay-harness.md`) and the override counts.
Judged, every week: an audit an agent runs.
The host only counts; the agent audits.
The nets are rules we wrote too, so they stay few and typed, and an explained move past one is a choice, not a slip.

## The limits ledger

`scripts/limits.ts` holds every named limit in the host's code: a `const` declared at the start of a line in `src/core`, `src/shared`, `src/main` or `src/preload`, outside the tests, whose name has a limit word (`MAX`, `MIN`, `CAP`, `LIMIT`, `LIMITS`, `BUDGET`, `CEILING`, `FLOOR`) between its underscores.
Each is in one of two lists, with its way out: what an agent or a person does when work meets it, as the code works today.

- `LIMITS` holds a limit that rests on a fact the app holds (`record`, which includes a product rule the captain chose and a document records), a fact outside the app (`outside fact`: a platform, a protocol, a file format, a provider), the person's consent (`consent`), or a physical limit of the process or the machine (`physical limit`: memory, disk, a message's size, the context window, screen room, a wait on something that may never answer).
- `BASELINE` holds a limit that rests on a number the app made up: a verdict still in code.

The words are the hold registry's (`src/shared/holds.ts`).
What a limit rests on is a judgment its author and its reviewer make by the four questions, never the check.
The physical test: if the machine had unlimited memory, disk, context and screen and every peer always answered, would the limit still exist?
If it would, and no fact or consent needs it, the number is made up.
A way out may honestly say `none yet`; the weekly audit reads those first.

`pnpm check` runs `node scripts/limits.ts`, which fails on a named limit in neither list, an entry the code no longer declares, a limit in both lists, and an entry with no way out.
`node scripts/limits.ts --counts` counts the limits by what each rests on, and `--list` prints each with where it is and its way out.
`tests/limits.test.ts` holds the check's refusals.

**The baseline only shrinks.**
A limit leaves it when its judgment goes to the agent, or when its author shows that it rests on a fact; the check then refuses the stale entry, so the removal is in the same change.
A new made-up number is a move its pull request explains, as a moved replay number is, and the weekly audit names every entry added since the last one.

The ledger cannot see a bound with no limit word in its name, such as a literal in a condition, a retry count or a task's demand on a computer.
The weekly audit reads the week's changes for those.

## The override counts

The captain's words pass a soft hold through one recorded override (`docs/delivery-rigor.md`, "The holds").
Each declaration is a `note` row on the task's timeline that carries the override; a take-back is a row that carries none.
`scripts/interaction-metrics.ts` reads them as each dispatch's `overrides`, off the same rows in the replay (`scripts/replay/engine.ts`) and in the corpus export (`scripts/extract-dispatch-corpus.ts`).
`hold_overrides` counts the overrides declared, an observational row nobody grades.
The corpus export's manifest counts them per hold kind in `rigor.overrides_by_hold` (`docs/corpus-export.md`), where an override that names two holds counts once under each.
A hold the captain's words pass often is the signal that it rests on a verdict: it should drop a level, or its judgment should go to the agent.

## The weekly audit

An Automation rule (`docs/automation.md`) asks the first mate every week to start a task in the Infinitary project that runs this audit.
The host knows nothing of it: the rule is the captain's, a saved prompt like any other, and this section is the procedure its crewmate follows.
The first mate saves the rule as a draft, and the captain turns it on in Settings → Automation, where the captain can change any part of it:

- Name: Weekly reach audit.
- Schedule: every Monday at 9:00 AM, America/Los_Angeles (the captain chose every week on INF-484).
- Project: Infinitary.
- Prompt: "Start a task in Infinitary that runs the weekly reach audit in docs/agents-reach.md ("The weekly audit") for the week up to {{scheduled time}}.
  It answers on a card and changes no code."

The audit is an answer: its crewmate ships nothing, and its card is the deliverable.
It runs five steps.

1. **The window.**
   It starts where the last audit task ended (the tasks query finds it by title) or seven days back when there is none, and ends now.
2. **What the window added.**
   It reads the main line's changes in the window: entries added to or changed in `HOLDS`, named limits added to either list of `scripts/limits.ts`, served sentences added to the prompts, their contract revisions and the tool descriptions, and bounds no list names - a number in a condition, a retry count, a timer, a list of cases.
3. **The four questions.**
   It asks each, in order: is it a typed fact the host holds, consent for an effect, a physical limit, or otherwise a verdict the agent should make?
   For a limit or hold that stays, it checks that the agent can read it, that its refusal names the fact it rests on, and that a way out is typed beside it.
4. **The counts.**
   It runs `node scripts/limits.ts --counts` for the baseline's size and names each baseline entry the window added with its pull request's reason.
   It runs `pnpm export:corpus --out` into its own temporary folder, reads `manifest.json`'s `rigor.overrides_by_hold` and `rigor.metrics.hold_overrides`, and deletes the export.
   It compares each count with the last audit's report.
5. **The answer.**
   Its card leads with the verdicts it found in code, each with its file, its line and the move it suggests, then the holds the captain's words passed most with the level each suggests, then the counts beside last week's, and what it could not read.
   It files each verdict in code as a follow-up, after searching the tasks for one already filed, so the first mate decides on it with the report.

## The story end to end

`tests/e2e/agents-reach.spec.ts` runs the three nets together through the hermetic launcher, on the GitHub stand-in and the mock models.
A reviewed task at its review cap with failed checks hears the captain's words, records one override, and merges at the reviewed version with no re-review.
Words that name GitHub's required review pass asking first, and GitHub's rule refuses the merge in the fixed limit's words.
A crewmate refused its second rerun reports, and the captain's choice reopens the rerun limit for one more.
The weekly audit rule, set to run once, starts one audit task, and the corpus export counts each override per hold.
Every refusal an agent was served names its hold: a soft hold with its way out, a fixed limit as fixed.
