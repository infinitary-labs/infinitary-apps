# Task retention: compaction, export, and the session footprint

Task-system phase P5 (design record `fm-homes/mini-default/data/fm3000-task-system-design-s1/report.md`, sections 5, 9.1 and 12).
The record is durable: a task row, its timeline and its session JSONL are never deleted by success (captain decision D2, amending D-13), and the D-13 purge in Settings is the one control that deletes the record.
Words from outside are the one exception inside a kept session: a note takes their place after their days, or when the captain deletes them ("Words from outside").
This document is what keeps that durable record honest at scale: what is bounded, what leaves the box on request, which of a closed task's files go on their own, and what is measured but not pruned.

## What is bounded

- **The board push** (`inf:tasks`) is the live set - open, active, closed within seven days, plus the parents of shown rows - never history.
  Above the measured trigger (500 rows on the board, or a snapshot over 256 KB of JSON; `BOARD_DELTA_TRIGGER` in `src/shared/tasks.ts`) the core pushes `inf:tasks:delta` instead: the difference between the board it just brought up to date and the one it last pushed, on the same `seq`.
  The delta is a diff of two snapshots (`diffTaskBoards`), never a replay of the writer's bookkeeping, so a derived change with no write of its own (a blocker closing, a card leaving the stack) crosses like any other, and `applyTaskBoardDelta(prev, diff(prev, next))` equals `next` by construction (`src/shared/tasks.test.ts`, 200 seeded pairs; `taskProtocol.test.ts` over the real writer).
  A row the change did not reach is the same object on both boards (`docs/task-record.md`, the row cache), and the diff knows it by identity without serializing it, so the diff too costs the rows rebuilt and not the board.
  A client whose board does not carry the delta's `baseSeq` has missed a push and resyncs from `inf:tasks:board`; the read executor does exactly that (`deltaFromPush` in `src/shared/reads.ts`).
  The first push, and the first push after rows vanish (a purge, a failed spawn's discard), are snapshots: a delta needs a base.
  Dev and e2e can lower the row trigger with `INFINITARY_TASK_DELTA_ROWS`; a packaged build always measures against the design's.
- **Ordinary timeline history** targets `TIMELINE_CAP` (500) events.
  The write that pushes a timeline past the target folds its oldest ordinary events into one `compacted` event toward `TIMELINE_KEEP` (400) rows, inside the same transaction.
  Provenance and specification-receipt events (`decided`, `steered`, `interrupted`, `report`, `card_resolved`, `briefed`) are exempt and retain their full payloads, so an evidence-heavy timeline may exceed the target (`docs/provenance-capture.md`).
  A `briefed` receipt keeps the reports it copied as references to those `report` events, which are exempt too, so it still reads back whole (`docs/task-record.md`).
  Compaction does nothing when folding would not reduce the row count.
  The partial `task_events_compaction` index omits provenance and replay journals, so trimming seeks ordinary candidates without re-reading retained payloads; events another task reads remain exempt through `task_event_concerns`.
  The index and readers share their eligibility predicate, and reopening saved data installs the optional index without changing its format.
  Count and boundary reads reuse completed statements through the per-database `prepared` owner rather than compiling fresh row constructors on every write; each execution still reads the current rows.
  A fold that meets an earlier `compacted` row absorbs its counts, so the head of ordinary history says how much it stands for: `data` carries `folded`, `firstAt`, `lastAt` and a per-kind count.
  Counts are folded, never content summarized (design section 2.4 rejected beads' "memory decay").
  The `compacted` row is stamped at the fold boundary and takes whole milliseconds of compactable history with it, so it sorts before everything it replaced.
  Feed lines are unaffected: `feed = 0`, and the events that were folded had already been shown.
- **Observe's list** (`docs/dev-observe.md`) parses a closed task's kept session once per `(path, mtime, size)` and stats it on every later poll, so the two-second list cost is bounded by live work, not by the number of sessions ever kept.

## Export (JSONL)

`pnpm export:tasks --out tasks.jsonl` writes the record - projects, tasks, timeline events, links, captain asks - as one JSONL file: a header line (`format: infinitary-tasks/1`, counts; an export with Firstmate 3000's `fm3000-tasks/1` still imports) and one line per row in the stores' own field vocabulary, keys in one canonical order (`src/core/tasks/taskExport.ts`).
Nothing derived rides along (no flags, views or feed lines) and nothing from outside the record does either: session JSONL stays where it is, knowledge (`docs/knowledge.md`) is not exported, and worktree and session paths are exported as the machine-local strings they are.
Timeline event ids are storage-local and left out.

`pnpm export:tasks --import tasks.jsonl --user-data <dir>` reloads an export through the one writer (`TaskService.importRecords`): one transaction, every row verbatim, refused before anything is written when a task id or key is already taken, a project key belongs to another id, or a row references a task that is neither in the file nor in the database.
A project that already exists (Scratch, always) keeps its row; its sequence rises to what the imported rows used and its birth becomes the earlier of the two.
The board resets, so a client takes a fresh snapshot.
Run an import with the app closed.
The round trip - export, reload into an empty userData, export again to the same lines - is the acceptance test (`taskExport.test.ts`, `tests/export-tasks.test.ts`).

No product surface: like the corpus export and the miss deriver, this is a dev command over the app's own data.
The export is tables only, so it is not behind the Observe gate; it never touches transcripts.

Card evidence (`card_observations`, `docs/card-evidence.md`) is card-owned, not a timeline event: compaction never folds it and a task's close deletes none of it.
The Settings purge removes it with the task's cards, and with the task-less cards its decision and operation rows linked.
A pack written by `pnpm export:corpus --human-supervision` is a separate local copy that no purge reaches.

## A closed task's leftover files

Each task has a folder of its own, `crewmates/<taskId>/` (`src/core/paths.ts`).
The app keeps six parts of it for itself: `sessions/` (D2), `cards/` (the host's copies of every picture and recording a card showed, made when the card went up), `card-bodies/`, `source-cards/`, `placed/` and `captures/` (`APP_KEPT_PARTS` in `src/core/tasks/taskLeftovers.ts`).
Everything else there is the crewmate's: its evidence folder and whatever scratch it left beside it, such as project copies, scripts and logs.
A temporary folder the app provisioned is not part of that week: it goes when the task closes, as the next section says.

A week after a task closes (done or dropped), the app removes those leftover files (the captain's FI3-1199 answer).
A closed task's files stay while a live task builds on it (its `basis`), was filed from it (`discovered-from`) or waits on it (`blocks`), directly or through any number of earlier tasks, including closed intermediates.
An open task that has not started protects the entire upstream chain too, so a successor can read every earlier task's evidence where it is instead of copying accumulated histories forward.
Once no live task reaches it, the week counts from the task's own close; the hold does not restart the clock.
Open and active tasks are never touched, and neither is anything outside the folder: the record, cards, answers, attachments, the kept ref and knowledge stay.

`ClosedTaskFiles` runs one pass at start-up, once an hour on the shared ticker, each time a task closes, and when a work computer comes back into reach.
A close can free the tasks it held, and the hourly pass lets a continuously running app cross the week without another close.
Each pass derives upstream holds and cleanup candidates from one task snapshot, resolving basis ids and case-insensitive keys from that snapshot rather than composing each referenced task again.
A pass moves each leftover part, in one rename apiece, into one folder under `worktree-trash/`, writes one quiet timeline note saying what went and how many bytes (`removedFiles` and `bytes` in its data), and deletes that folder in the background below the UI (`WorkspaceService.deleteInBackground`).
A delete a quit cut short finishes in the next start's trash sweep, and a part a quit left unmoved goes in the next pass.
A link is moved or removed as a link and never followed, and a task folder that is itself a link is left alone.
For a task on another computer, the home checks the same close age and live-task links, closes its conversation there, and asks `inf:session:clean-files` to remove the leftovers in `work/tasks/<task>/` through `PlacedTasks`.
The computer keeps the same app-owned parts plus `state.json`, `orders.jsonl`, `outbox.jsonl` and the fallback `work/` folder; working copies remain their own writer's responsibility.
The cleanup order refuses an open conversation, moves leftovers to that computer's trash without following links, deletes them, and remembers its answer under the order id for that close.
Only an acknowledged answer clears the task for this run, and the home records the removed names and bytes in a quiet timeline note.
An out-of-reach computer or failed cleanup retries at the next pass or contact; a computer older than protocol 4.2 needs updating before it answers the cleanup order.
The crewmate's instructions explain the week and the live-chain protection, and tell successors to read earlier evidence in place and name its task and original path rather than copying evidence folders (`crewmateEvidenceNote`).
An unreadable file or one on another computer is a gap to report, not a reason to duplicate the history.
The existing card and validation-proof file rules still require copying an individual file into the successor's own allowed folder when it actually publishes that file; this does not authorize copying whole evidence folders.
What a later reader needs belongs in the report or on a card; instructions also ask for one copy of each download and no kept database copies.
Bulk downloads, unpacked copies, throwaway environments and test-run output go in the temporary folder when the crewmate chooses the destination (`crewmateTempNote`).

## A task's temporary folder

Each task the app starts a crewmate for gets `crewmates/<taskId>/temp/`, beside `evidence/`, on the computer the task runs on (`crewmateTempDir`, `placedTaskFolders`).
The app creates that folder and writes an ownership marker beside it, `.infinitary-temp` (a folder Firstmate 3000 provisioned keeps its `.fm3000-temp`, which still counts), before the crewmate is told the path.
A folder named `temp` that already holds files, and has no marker, is not adopted: it stays on the week-long leftover policy above.
The marker is not inside the folder, so emptying the folder does not drop the contract.

The folder is for bulk working material whose destination the crewmate chooses: downloads and unpacked copies, throwaway test environments, and bulk output from test runs.
The app does not point every process's temporary directory there, and it does not change a project's own test conventions.
Selected proof still goes in evidence.
Deliverables go in the project, the chosen output location, the report, or a verified card copy.

Files another task hands this one arrive in its `handover/` folder inside it (`docs/helper.md`, "Handed files"), and the files this task hands on are kept in `crewmates/<taskId>/handover-out/` on this computer, removed first when the task closes.
The folder stays while the task is working, idle, paused, or waiting for review or a merge.
A failure that leaves the task resumable does not remove it.
When the task is done or dropped, including a merge, a discard, an answered task, or a cancellation or failure that closes the record, removal starts after the task's writers have stopped.
There is no seven-day wait, and a live task built on this one does not hold the folder: anything a successor needs has to be in evidence before the close.
A cancellation or a terminal failure can remove the folder without a last chance to copy files out; the instructions say so.

Removal renames the folder into `worktree-trash/` and deletes it in the background, the same way leftover files go.
A link is not followed.
If the task folder cannot be verified, the temporary folder is itself a link, a volume is still mounted, or the rename fails, the folder stays, the timeline says why, and a later pass tries again.
The app never force-detaches a volume.
The week-long leftover pass also leaves a provisioned folder that still holds a volume, so it does not fall through to a recursive delete.
Both passes walk and delete through `src/core/plainFs.ts`, so an app's `.asar` file, such as one under `node_modules/electron`, is the file it is: Electron's own file reads show it as a folder on a device of its own, which reads as a mounted volume and stops an in-process delete.
A successful removal notes the byte count; a pending removal does not claim the space is free.

On another computer the home asks `inf:session:clean-temp` only after that computer's conversation is closed, and only when it speaks protocol 7.1 or later.
An acknowledged removal or an absent folder clears the task.
A pending answer is asked again; the computer does not treat a pending answer as finished.
An out-of-reach computer, or one that needs an update, is not reported as cleaned, and the next contact or hourly pass tries again.

`TaskTempFiles` runs a pass at start-up, once an hour, each time a task closes, and when a work computer comes back into reach.
The Settings purge still removes the whole folder with the record.
The same purge removes the first mate's own transcripts: `firstmate/sessions/`, `firstmate/claude/` (the Claude seat's copies and sidecars) and a retired `supervision/sessions/` directory if one remains.
The Claude client's own copies under `~/.claude/projects/` stay; the client sweeps those after 30 days (`docs/claude-client.md`).
`src/core/tasks/closedTaskFiles.test.ts` holds the rule over a scratch userData.

## The session footprint (measured, not pruned)

Session JSONL is the one unbounded store, by choice.
The captain's words (D2): "the sessions are very valuable. i think later we would explore some scrubbing / pruning process that reduces the storage need, but we shouldn't remove the entire session JSONL altogether."
The measurement below deletes and rewrites nothing.

### The measurement

`pnpm measure:sessions [--user-data <dir>] [--out footprint.json] [--older-than-days N]` (`scripts/measure-session-footprint.ts`) walks every session file the app keeps - `crewmates/<taskId>/sessions/`, `firstmate/sessions/`, `firstmate/claude/`, `supervision/sessions/` - joins each crewmate directory to its task row (status, close time; the database is opened read-only, so it runs beside a live app), and attributes every byte of every line to one class.
The first mate total combines its Pi sessions with its app-owned Claude transcript copies and `.served.jsonl` sidecars; Claude's own original files are outside this walk.
The classifier reads both writers' lines: Pi's message and compaction entries, and the Claude client's `user`, `assistant` and `attachment` lines with its queued prompts.
It reads a `queued_command` attachment as a steer and an `isMeta` user line as the client's own, the way `src/core/storage/sessionReader.ts` does.
A served sidecar is the app's own bookkeeping and counts as `framing`.

The byte classes are:

| Class | What it is | In a scrub |
|---|---|---|
| `userText` | the brief, steers, `[fm-op]` wakes, the captain's words, and the Claude client's copies of a queued prompt | kept |
| `assistantText` | reports, answers, narration | kept |
| `toolCalls` | tool names and arguments, and the Claude client's copy of the arguments it sent (`wireToolInputs`) | kept (they say what was done) |
| `thinking` | assistant thinking blocks, their signatures included (a Claude model's thinking arrives sealed in the signature) | candidate |
| `toolResults` | file reads, command output, search hits | candidate |
| `toolResultCopies` | the Claude client's own copy of each tool result (`toolUseResult`), written beside the one the model read: output, file contents, pictures | candidate |
| `images` | base64 image data, in user turns and tool results | candidate |
| `attachments` | what the Claude client attached to a turn besides the conversation: its prompt and tool snapshots, reminders, listings, file snippets and its own `isMeta` lines | kept |
| `compaction` | summaries Pi or the Claude client wrote when it compacted context | kept |
| `framing` | session/model entries, ids, timestamps, token usage, JSON structure | kept |

The captain's own accepted pictures are kept apart from this table: each has a message-owned copy under `<userData>/attachments/` (`docs/composer.md`, "Files"), referenced by its inbox row, its thread and the ask row of the tasks it came with, with no automatic expiry and no pruning here.

The report totals by session kind, by task status, and names the candidate set: closed crewmate sessions older than the window (30 days by default), their bytes, and the split between what a pass would drop and what it must keep.
Counts and bytes only - the tool never prints transcript content.
Fixture-tested (`tests/measure-session-footprint.test.ts`) in Pi's format and the Claude client's, including a session the client recorded; a MacBook-exported userData runs identically.

Sessions are never pruned automatically.
The one automatic rewrite is words from outside (next section), which replaces passages and deletes no file.
A scrub of closed crewmate sessions, if the captain asks for one, rewrites tool results and the Claude client's copies of them, images and thinking in place and never deletes a session file.

## Words from outside

What an integration hands an agent from a kind that fences its words, Gmail and Calendar today (`google-data`, [Integrations](integrations.md#data-from-outside)), stays in saved conversations only for the days that kind declares (`IntegrationBinding.kept`).
Google keeps 30, the same as the Claude client's own sweep (`GOOGLE_DATA_KEPT`, the captain's INF-952 answer).
Once they pass, a note, `[Gmail and Calendar content deleted]`, takes the place of each passage, and the conversation stays (the captain's INF-952 answer: "Yes, replace the passage and keep the conversation").
Delete Gmail and Calendar content, in Settings → Integrations' Data section, does the same at once for everything read so far (`inf:retention:delete-outside`), and the captain can ask the first mate for it (`delete-outside`).
Its answer says how many conversations changed, how many are cleaned once their work pauses, and how many on each computer that runs work follow once it is back in reach or Infinitary there is updated (`elsewhere`).

A file from outside saved into a task's hand-over folder, such as a Gmail attachment (`save_attachment`, [Integrations](integrations.md#google)), goes on the same clock: `OutsideReads` keeps its kept name, kind and time per task, and the pass that replaces that task's words removes each due file, or the delete removes it at once.
On a computer that runs work the pass names the due files in `inf:session:delete-outside`'s `files`, and that computer removes them first, whatever its conversation is doing.
The task's close removes the folder sooner.
Words a crewmate read inside such a file are not fenced, so no pass finds them; Google's notice says so.

`SavedOutsideData` (`src/core/integrations/savedOutsideData.ts`) owns both.
A passage is one fenced span with the reminder lines before and after it that name its fence; a span a shell cut short goes from its opening mark to the end of that text, or from its start to its closing mark (`src/core/storage/outsideDataScrub.ts`).
Each span is dated by the moment in its own opening mark, so an older answer goes and a newer one beside it stays.
An answer saved before the fence existed carries no marks: a delete finds it by the call that fetched it, the first mate's `use_integration` or a crewmate's `infinitary-integrations-axi call` naming that integration, and replaces the whole answer.
A kept conversation is rewritten line by line, keeping every other line byte for byte, through a temporary file and one rename.
A line the client is still writing is left as it is.

It reaches, on this computer:

- a crewmate's saved conversation: `crewmates/<taskId>/sessions/`, and the Claude client's transcript with the outputs it saved beside it under `~/.claude/projects/`;
- the first mate's: `firstmate/sessions/`, `firstmate/claude/`, a retired `supervision/sessions/`, and the Claude client's own files for its sessions;
- a rule's runs, their prompts and event summaries (`ScheduleStore.rewriteRuns`), and the first mate's messages that no turn was handed yet (`InboxStore.rewritePending`).

The app's copy of a Claude transcript is rewritten the same way as the client's, so it stays a byte prefix of the original and keeps being copied.
A reader that follows a file by its offset starts over when the file was replaced (`SessionFollower`, `SessionRecordStore`).

A crewmate's conversation on a computer that runs work is replaced there, by that computer (`inf:session:delete-outside`, `PlacedSessions.deleteOutside`; [Helper](helper.md#words-from-outside)).
That computer reads its record under `tasks/<taskId>/sessions/` and its own Claude client's files for it, only between turns and with nothing of its client's own running, and answers `waiting` otherwise.
A conversation open there is let go of before its files are written and opened again from them, so none of the words stays in its memory either.
This Mac then copies each file that computer changed whole into its own copy of the record, written beside it and renamed into place once whole, and with them any file of its copy that still holds due words, so a pass a drop cut short is finished on the next.
The answers this Mac kept for that conversation's callbacks (`crewmates/<taskId>/placed/calls.jsonl`) are replaced here first, whatever that computer can do.
A computer out of reach or on another contract major is asked again on a later sweep.
A computer no longer on the list has nothing more to copy, so this Mac's copy is replaced here, as a task of its own is.

It does not reach what an agent wrote in its own words, such as a report, a card, a note or a file it made; those stay until the task is deleted.
Nor does it reach copies outside the saved conversations: what the AI provider received, a backup, or an export.

Where the words went is a ledger, `userData/integrations/outside-reads.json` (`OutsideReads`, 0600): for each conversation, the hours in which it received fenced words, and the time of the last delete.
`IntegrationsService` writes an hour there whenever it fences an answer or a rule's event summary for a reader.
A sweep on the shared ticker, once a minute, reads only the conversations holding an hour that is now due, and only the files written since then, so it never walks every saved session.
A conversation in a turn is never rewritten under its writer.
The pass lets go of it between turns, so its next turn opens it from its files, and one that is working is noted to be read whole on a later sweep.
A computer that runs work reads every file of a conversation at each visit, since its clock is its own, and a task that no longer exists is dropped from the ledger.
`src/core/storage/outsideDataScrub.test.ts` holds the replacement over lines as Pi and the Claude client save them, `src/core/integrations/savedOutsideData.test.ts` holds the pass over a scratch userData with the Google stand-in, and `src/core/placed/placedOutside.test.ts` holds it over a crewmate on a computer that runs work, across the real connection.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Scale, polish and retention (task-system P5, the final phase; `docs/task-retention.md`, architecture §19): the board push switches to `inf:tasks:delta` above the measured trigger (`BOARD_DELTA_TRIGGER` in `src/shared/tasks.ts`: 500 rows or 256 KB; `INFINITARY_TASK_DELTA_ROWS` lowers it in dev/e2e only) - the delta is a DIFF of the snapshot just rebuilt against the one last pushed (`diffTaskBoards`), so `applyTaskBoardDelta(prev, delta)` equals the fresh read by construction and a derived-flag change travels like a written one; the read executor folds it (`deltaFromPush`) and re-reads on a gap; the first push, and the first after rows vanish, is a snapshot.
  `PROTOCOL_VERSION` 1.3.0; `tasks.onBoardDelta` is a sub-key, no new top-level `window.infinitary` key, no new tool.
  Ordinary timeline events fold past `TIMELINE_CAP` (500) toward `TIMELINE_KEEP` (400) into one `compacted` head that absorbs an earlier fold's counts (counts only, never content; inside the write that crossed the target); R2 provenance events are exempt, so evidence-heavy timelines may exceed the target.
  `task_changed` carries `kind`, `closedReason` and `from` (the status the emitter last saw): the character celebrates a landed/merged transition and is confused by a failed one, keyed on `from !== status` so a later write on a closed row never re-fires (`store.ts`; `task_landed` still flows for the feed and Observe).
  The JSONL export (`pnpm export:tasks`, `src/core/tasks/taskExport.ts`) is the five record tables verbatim, keys in schema order, event ids omitted; `TaskService.importRecords` reloads it through the one writer and refuses before writing on any collision - round-trip tested.
  `pnpm measure:sessions` (`scripts/measure-session-footprint.ts`) sizes every session file by byte class, read-only; sessions are durable (D2) and NOTHING prunes them - the scrubbing pass is a proposal in `docs/task-retention.md` awaiting a captain call.
  Observe lists every closed task's kept session at one parse per `(path, mtime, size)`.

## Saved change stories

Prepared change-story assets stay beside retained card media, outside its scratch folder and working copy, while their revision is the newest or the last published one (the unresolved opening occupies the latter slot until its outcome is known).
TaskService keeps only those two immutable revisions (one when they coincide), reusable upload receipts and the last complete publication in the task's delivery record (`docs/forge.md`, "Saved change stories").
Completion cards get independent copies under fresh names in `cards/`, with both their body URLs and picture/recording metadata pointing to those copies.
Discarding older revisions removes their unreferenced story copies, never shown-card copies, source files or hosted attachments.
Refused preparations discard their unretained staging copies, including early validation and busy-operation refusals, without removing files the active operation still needs.
Closing a task, retiring its working copy, and purging local records never delete hosted attachments.
