# Lessons

A learner studies a subject (chess, fractions) across days through one lesson card at a time.
The app adds no subject or skill type: a teacher crewmate follows the lessons guide, `resources/runbooks/lessons/skills/lessons`, which the enabled Lessons runbook serves as a crew skill (`docs/runbooks.md`).
This Mac user is one learner, so `lessons/` holds one learner.

## Subject, skill and round

- **Subject**: one task, open across days, plus the folder `lessons/<subject>/` in the personal workspace.
  A second subject is a second task and a second folder.
- **Skill**: an entry in the subject's `progress.md`, marked practising, learned or next, with dated evidence.
  How big a skill is, what it needs first and when it counts as learned are teaching judgments in the guide, never host facts.
- **Round**: one version of the lesson card, 8 to 12 items.

## The task

The Lessons runbook asks the first mate to declare `ongoing: true` and `intelligence: high` on spawn or create, including a named-model dispatch.
There is no lesson work kind: an undeclared kind keeps the ordinary classifier path.
R11 reads the declared intelligence below named-model, premium and escalation choices (`docs/routing.md`).
The task is ordinary personal-workspace change work, so a card choice does not close it.
The runbook tells the first mate to relay the lesson skill and learner records in the brief, one task per subject.
The workspace's generic instructions ask the crewmate to open the skill its brief names, and panel checks apply only when it changes a panel.
For ongoing personal work every finished turn is committed, with the report as the message or `ongoing work turn` when there is none, without closing the task or waking the first mate for routine progress.
A commit that fails is the one exception: it wakes the first mate with git's words, as on any personal task (`docs/personal-panels.md`, "Report, commit, close").
A report that asks the first mate for something, or declares the work finished, routes as any other report once its commit lands; the first mate closes a finished subject with `settle_task` `finished`, which keeps the files (INF-1677).
`lessons/` is a record folder: it holds no `panel.tsx` or `server.ts`, so a panel build never loads, stamps, lints, places or copies it (`isPanel`, `src/core/personal/liveWorkspace.ts`).
An active task that builds in place and has a recorded conversation survives a restart; boot recovery returns to the queue only an active task with neither a working copy nor a conversation (`TaskService.releaseUnstartedDispatches`).

## Files

- `lessons/learner.md`: what holds across subjects (how they like to learn, reading level, what to avoid).
  Every teacher reads it before a round.
- `lessons/<subject>/progress.md`: the goal, skill states with dated evidence, words they use, what is next.
- `lessons/parts/`: the tested board, progress, finish and quiz parts, copied from `.claude/skills/lessons/parts/` and pasted inline into each round, because a card cannot load a file.
- `lessons/<subject>/record.json`: typed calendar facts, the learner's goal, dated skill states, the subject task's key and the next practice goal.
- `lesson-<subject>/`: the tested personal panel copied from `.claude/skills/personal-panel/parts/lesson/` after the first finished round, with its record path and title filled in.

## The subject panel

The teacher copies the panel part once and updates only the record alongside `progress.md` after subsequent submitted rounds.
The template belongs to the workspace-owned `personal-panel` skill; the Lessons runbook holds guidance and HTML card parts only.
Moving or copying a runbook installs no panel and changes no panel consent.
A fresh subject has no panel until its first finished round; an unfinished round counts no practice day.
The panel's own server reads and validates the record on startup and once a minute, publishing its snapshot through the existing panel store.
An invalid record says progress could not be read, never zero progress; a missing or empty record docks nothing.
The panel shows the learner's goal, fourteen days of practice, the current and best run, banked rest days, skill states with dates and one lit next-lesson button.
Skills are the achievements: there are no firsts, badge grids, XP, weekly targets or comparisons.
The guide's calendar rule lives in the panel part, not in the host: five unique local practice days earn one rest, capped at two when earned.
An ended missed day spends one banked rest automatically, while a requested inclusive holiday range preserves the run without spending rest.
Neither rest nor a holiday adds to the practice count.
An uncovered miss welcomes the learner back, retains the best run and lets the next practice begin a new run without loss words.
The panel derives these protections from dated facts while the teacher is idle; it never writes the records.
Click or Enter on the next lesson points through `tasks.board` and `point.openTask` to the subject's waiting round or welcome-back card; it starts no work.
Without a ready card it says the teacher is preparing the lesson, or that the lessons are stopped when the task leaves the live board.
The panel keeps its record after Stop these lessons, and a new teacher updates its task key when the subject resumes.
The collapsed header omits zero counts and says the practice run and number of skills learned.
The host's ordinary rail placement and overflow rules apply; the panel has no bespoke placement logic.
The initial panel copy is a build attributed to the teacher task, so its header can carry the host's running dot while that subject task remains active.
Keeping later record writes under `lessons/` avoids rebuilding or reattributing the panel each round.

## The card

Every lesson card declares `holds_place` (`docs/card-authoring.md`, "Declared continuity"): a reply under it keeps it shown, as under every card, a choice closes it at once, and the next round is a new card, which comes forward over another card.
A card the learner answered never comes back with buttons (`docs/card-threads.md`), so the guide gives every card of a subject a new id, the subject and a number that counts up, such as `lessons-chess-2`; the welcome-back card takes the next number too.
The round's own script checks each answer against a key the teacher wrote, so the learner answering starts no model turn.
It shows progress dots and an item count, a drawn board or number line, a feedback line, a hint button with one-step hints, a worked example after two misses and a finish screen with the first-try result and one next practice goal.
The quiz part moves the right answer through every position and never twice in a row; the teacher writes choices of about equal length.
It stages a compact `round` summary with `inf.stage`, which the footer choice carries to the teacher: items, first try, misses and hints.
The footer is `Next round` and `Stop for today`; the first card of a subject asks the learner's goal, in a field named `goal`.
`Stop for today` leaves a welcome-back card on the stack: the goal and skill chips marked learned, practising or next, with `Start today's lesson` and `Stop these lessons`.
It stays until chosen and the task stays open, so a restart brings it back with no nudge or stall card.

## Voice

The Lessons runbook's cards use `holds_place` and a warm voice: short praise for effort and strategy, `!` and the chess pawn.
The tested subject panel also uses short effort praise and exclamation points, but no emoji; other panels keep their calm voice.
The Lessons runbook owns this voice; the core card contract lets a runbook set the author's choices on the cards it describes while fixed shape, consent and effects always hold.
No lint rule reads the voice: it is the author's (`docs/card-authoring.md`, "The shape lint").

## The six ideas

Goal first; learned means it stayed (right again on a later day, never on the first day); mixed review at the start of each sitting; evidence, not coverage; tested parts; fair choices.
They are teaching judgments, so they live in the guide and the parts, never in host code.

## Not here

Adult guardrails, kid card chrome, sound and games.
Nothing is measured about how well a real model follows the guide: `docs/testing.md`'s scripted lesson journey (`tests/e2e/lesson-loop.spec.ts`) proves the app's behavior with scripted teacher words.
