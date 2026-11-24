# Keeping the agent's reach

The principle "Build the agent's reach, never its verdicts" (`docs/principles.md`, 2026-10-19) is kept by three nets, each the cheapest that sees its kind of slip (INF-484, move 8).
Typed, on every push: the hold registry (`docs/delivery-rigor.md`, "The holds") and the limits ledger, both in `pnpm check`.
Measured, on each change that reaches them: the replay gate (`docs/replay-harness.md`) and the override counts.
Judged, every week: an audit an agent runs.
The host only counts; the agent audits.
The nets are rules we wrote too, so they stay few and typed, and an explained move past one is a choice, not a slip.

## The limits ledger

`scripts/limits.ts` holds every named limit in the host's code: a `const` declared at the start of a line in `src/core`, `src/shared`, `src/main` or `src/preload`, outside the tests, the phone check's command deadlines in `scripts/phone-deadlines.ts` and the two lines of the size check on `AGENTS.md` in `scripts/agent-memory.ts`, whose name has a limit word (`MAX`, `MIN`, `CAP`, `LIMIT`, `LIMITS`, `BUDGET`, `CEILING`, `FLOOR`) between its underscores.
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
`scripts/interaction-metrics.ts` reads them as each dispatch's `overrides`, off the same rows in the replay (`scripts/replay/observations.ts`) and in the corpus export (`scripts/dispatch-corpus/fleetTables.ts`).
`hold_overrides` counts the overrides declared, an observational row nobody grades.
The corpus export's manifest counts them per hold kind in `rigor.overrides_by_hold` (`docs/corpus-export.md`), where an override that names two holds counts once under each.
`rigor.overrides` lists the same overrides one by one, oldest first, so the counts per hold kind are its tally:

- `task` and `task_id`: the task's key, null on a task with none, and its id.
- `at`: when its row was written, in ISO 8601 UTC.
- `holds`: the soft holds it named.
- `until` and `head`: `version` with the version it covers, or `task` with no version.
- `route`: `merge-anyway` for the captain's Merge anyway click, recorded in the captain's name, or `relayed-words` for update_task override, recorded by the first mate relaying the captain's words; a row anyone else wrote reads null.
- `merge_click`: the words were the captain's click on a merge, an override the app no longer records and that never stands.
- `replaces`: the time and holds of the override the task's record held when it was written, null when none stood or a take-back came between.
  One override stands on a task at a time, so a widened one counts again under each hold it repeats; `replaces` shows the repeat.

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
   It runs `pnpm export:corpus --out` into its own temporary folder, reads `manifest.json`'s `rigor.overrides_by_hold`, `rigor.overrides` and `rigor.metrics.hold_overrides`, and deletes the export.
   It compares each count with the last audit's report, and reads the window's entries in `rigor.overrides` for which tasks passed each hold, by which route, and which overrides replaced one that named the same hold.
5. **The answer.**
   Its card leads with the verdicts it found in code, each with its file, its line and the move it suggests, then the holds the captain's words passed most with the level each suggests, then the counts beside last week's, and what it could not read.
   It files each verdict in code as a follow-up, after searching the tasks for one already filed, so the first mate decides on it with the report.

## The story end to end

`tests/e2e/agents-reach.spec.ts` runs the three nets together through the hermetic launcher, on the GitHub stand-in and the mock models.
A Careful task whose review still has findings after two re-reviews, with failed checks at the version the reviewer last read, hears the captain's words, records one override of the checks hold, and merges at the reviewed version with no re-review.
Words that name GitHub's required review pass asking first, and GitHub's rule refuses the merge in the fixed limit's words.
A crewmate reserves and reruns a failed job a second time, and the host records both reservations with no allowance to refuse the second: no card goes up and no override is asked.
The weekly audit rule, set to run once, starts one audit task, and the corpus export counts each override per hold.
Every refusal an agent was served names its hold: a soft hold with its way out, a fixed limit as fixed.

## An unsafe data reader

A task that reads words strangers can write, such as its project's issues and pull requests, starts as an unsafe data reader: a read-only answer task whose shape says `unsafe_data_reader` (`src/shared/routingPolicy.ts`).
Only the first mate sets it, on `spawn_crewmate`; the fence is the host's, so it holds whatever those words say, and the crewmate cannot set or clear it.
`spawn_crewmate` refuses one on the personal workspace, whose files are the captain's own, or that is not an answer (`UNSAFE_DATA_READER_PROJECT`, `UNSAFE_DATA_READER_ANSWERS` in `src/core/orchestrator/workShape.ts`); a takeover or a stronger model's retry keeps it.
One with no project runs in an empty folder of its own, `crewmates/<taskId>/reader/` (`crewmateReaderDir`), never a copy of the default workspace, whose files other tasks' work leaves there; its record names no working copy, so its close removes none, and the folder goes with the task's other leftover files.

- Its session is fenced (`SessionSpec.fenced`): no shell, no file change, no web and no browser, on both kinds of model session.
  Pi serves only its read, grep and ls tools (`fencedPiReadTools`): read and ls check every path they open, and grep checks its search root and leaves the files beneath it to ripgrep, which follows no links out of it.
  It leaves out find, which runs its own search program unasked, and stages no runbook or personal skills, which sit outside the working copy.
  Claude serves only Read, Grep and Glob, and a gate before each call refuses a path outside the working copy (`claudeFenceHook`); no skill is staged, since a plugin can bring hooks and servers of its own.
  A path's links are followed before the check, and a `~` path is refused whole (`outsideWorkingCopy`, `src/core/session/fencedReads.ts`).
- None of the app's shell commands reach it, so it has no browser, and it gets no task reads, no knowledge, no programs and no workflow logs or artifacts: those would bring outside words in unfenced, or reach past its project.
- It reaches the captain's integrations through two typed tools, `integrations` and `use_integration` (`READER_INTEGRATIONS_TOOL`, `READER_USE_INTEGRATION_TOOL`), under the same rules as every task (`IntegrationsService.forReader`), with three of its own ("A reader's integrations" in `docs/integrations.md`).
- `github_read` reaches only its own project, through the project's own sign-in, and a reader with no project is refused every read and write there before any sign-in is chosen, never falling back to the github.com sign-in an ordinary task with no project uses; and every answer comes fenced whole under its host's label, `github-data`, `gitlab-data` or `bitbucket-data` (`readerFenceLabel`), the way Google's words are (`docs/integrations.md`, "Data from outside"), with a fresh fence each read.
  Fencing the whole answer, not only the words of authors who cannot write to the project, keeps the host from judging who is trusted.
  Its answer must reach the model whole, since its fence refuses the temporary folder a long answer is saved to: a listing past that length is read again at the largest page that fits (`smallerPage`), and an answer no page fits is refused with words on asking for less.
- Every `github_write` it makes to its own project is kept, run starts included, and the host puts it on one approval card with a ticked row each, beside its kept integration calls ("A reader's writes" in `docs/forge.md`); a write anywhere else, a release file and a validation effect are refused and nothing is kept.
- It writes no file, so its instructions name no evidence, temporary or card body folder: its card bodies go inline.
- Each of its cards carries one line, drawn by the app from its task's shape, saying it reads words anyone can write, so a link or request there may come from a stranger (`Card.unsafeData`).
- It runs only on this computer: another computer's host rebuilds a session with the whole coding set, so the placement keeps it home (`runsOnlyHere`) and a placed session refuses a fenced spec.

Every other crewmate's shell and the merge card's rules are unchanged; this is a fence for one kind of task, not a general sandbox.
The brief names the fence to its crewmate (`UNSAFE_DATA_READER_WORDS`).
What it says reaches the first mate between `reader-data` marks (`src/core/orchestrator/readerData.ts`), since it may carry words anyone can write:

- Its report, its closing words when it makes none, and what it asks with `needs_firstmate` or `waiting_on_captain` are kept marked; its headline in the feed, the task row and the outcome is the host's fixed line saying the reader reported, worded in the app's language as it is saved and carrying none of its words, since a headline is cut short and would split the marks.
- A follow-up it files keeps its goal and why marked in the record and in the brief a builder would start from, so no builder takes them as instructions; its title stays as written on the captain's screens and is marked where an agent reads it as the reader's: the report's wake, the `tasks` query, the first mate's context, every answer to starting it now (a refusal included) and a brief built on it (`servedTaskTitle`).
  Once the follow-up runs, its own crewmate's start, report, idle and delivery wakes name its title as written.
- Its progress notes are kept marked, cut before they are marked; a plan with them is refused, since its labels would go unmarked.
- Its card replies, and its cards' own titles, bodies and button and option labels, stay as written on the captain's screens and are marked where an agent reads them: a card read, the open-work read, the `tasks` query by key with its card, the captain's closing choice and the wake that answers or undoes it, its `decisions` and its `timeline` field (`readerTimeline`), a brief built on its answer, the report's wake with any decision it withdrew, and every card line of the first mate's context (`CardThreads.servedLine`, `CardThreads.servedCardWords`), which ends with one reminder covering them all.
  In the captain's answers on its cards, the reader's words are marked: each question's name, each option label and the value it labels (an option with no words bound to it is labelled by its value), a value the card proposed and the captain left as it was, and a settings snapshot the card carries; what the captain wrote in or typed stays as written (`answersWithAuthorWordsMarked`).
  That split rests on the frame's own report, so a reader's card carries no script, which could set a field or rewrite the answers the frame sends (`CrewmateCards.crewmateCardWrite`).
- A card's saved words are marked the same way on every read: the fence is a keyed digest under a secret the process draws once (`readerSavedAnswer`), so the context, which sends only what changed, leaves an unchanged reader card out, and the by-key read still shows a body its newest card and closing choice share once.
- Its report refuses `recovery_ways`, `work_wait`, `result` and `check_back`, and a reader takes no `result_schema`: each is free text the host would pass on unmarked, so what it would say goes in the report's own words.
