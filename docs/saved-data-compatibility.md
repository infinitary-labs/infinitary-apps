# Saved-data compatibility

Release and alpha installations share `<appData>/infinitary`.
Development runs remain on `infinitary-dev`; nothing migrates between those roots.
Each moves the Firstmate 3000 folder of its flavor, `firstmate-3000` or `firstmate-3000-dev`, into itself once ("The one-time move").
An older app may open saved work only when it supports the persisted formats.
Release names alone are not compatibility evidence.

## Before services start

`createServices` first calls `assertSavedDataCompatible` in `src/core/storage/db.ts`, before overflow initialization, shell probes, account vault warming, database writes, launch/crash counters, agents or derived views.
`openDatabase` also guards its own writable boundary, protecting other callers.

The guard checks `saved-data-format.json` and the database migration history.
Every recorded migration must be an integer in this build's embedded migration list.
Unknown migrations, unreadable history, and databases with tables but no recognized history are refused.
Fresh state and known older/current history remain supported; forward migrations still run normally after the guard.

SQLite can create WAL/SHM sidecars even on a read-only connection.
To avoid changing the protected database or its sidecars, the guard copies the existing database and any WAL into a private temporary directory, reads the history through a read-only connection there, and removes that directory in `finally`.
It does not register view functions, configure WAL, migrate, or rebuild views.
This assumes startup owns the single-instance lock and no other process writes the app's state.
The snapshot includes committed WAL state after an unclean shutdown; checking only the main database file would miss it.

## Non-database formats

The closed marker schema is `{ "schemaVersion": 1, "revision": 1 }`.
Missing means supported legacy state.
Invalid, unreadable, extra-key or unknown revision metadata refuses startup rather than guessing.
After a successful first database initialization, the app records the current boundary atomically.
The marker is never rewritten on a refusal.

**Before writing any future incompatible non-database format**, increase `PERSISTED_FORMAT_REVISION` in `savedDataCompatibility.ts`, define exactly which older revisions are supported/migrated, and extend compatibility tests.
Compatible additions do not require an increase.
Database format changes continue to require an embedded migration.
Do not use app-version comparisons to substitute for either boundary.
The installer-owned channel marker is a different file and contract (`update-channel.json`, `docs/alpha.md` "Update channels").

## Folders that moved or are moving

`dataFolderRefusal` in `src/core/storage/dataFolderRefusal.ts` runs in the Electron host before the shell starts, and refuses the folder with its own standalone window (`showDataRefusal`, `src/main/savedDataRefusal.ts`).
A folder that carries `retired-profile.json` moved to Infinitary and is refused for good; the marker's presence is the whole rule, and nothing reads its contents.
A folder whose move lock is held is refused until the move finishes.
The move lock is `<folder>.move-lock`, a sibling of the data folder in the application-data directory (`src/core/storage/moveLock.ts`), so a move can rename the folder it guards.
A lock that names a process which no longer exists is stale and does not block.
So is a lock written before this computer last started: its process ended with that start, whoever has its number now (`predatesBoot`, `src/core/helper/lock.ts`, the same rule `running.lock` follows).
Any other lock that cannot be read holds.
The one-time move below writes both the marker and the lock.

## The one-time move

An app whose spelling has older spellings before it moves an older spelling's folder of its own flavor into its own once, before anything opens either (`src/core/folderMove/move.ts`; the Infinitary rename, FI3-1780 step 3).
Infinitary's folders are `infinitary` and `infinitary-dev` (`USER_DATA_FOLDERS` in `src/shared/userDataFolders.ts`); release and development move apart, each into its own.
This build is Infinitary (`OWN_IDENTITY` in `src/shared/codeNames.ts`, the rename's step 10), so the move is on: it wakes when this build finds Firstmate 3000's folder of its flavor holding saved work.
Firstmate 3000's own folders have no older spelling, so a Firstmate 3000 build's move never wakes.
It moves any older folder this build can read, so nobody has to pass through a particular Firstmate 3000 version first.

`dueMove` (`src/core/folderMove/due.ts`, which loads nothing of the move itself) decides before Electron reads userData, with cheap reads only: a move is due when the app's folder carries an unfinished move, a checked staged copy waits beside it, or an older folder holds saved work and is not retired.
An isolated (`INFINITARY_USER_DATA_DIR`) or switched folder never moves.
While a move is due, Chromium runs on a throwaway profile, `<folder>.hand-over`, so the app's folder is not opened by this process at all; the next ordinary launch removes that profile.

The move runs in this order, and writes its record, `folder-move.json`, before each step that depends on it:

1. It checks, changing nothing: the older app is not open (Chromium's `SingletonLock` in the older folder names no live process on this computer), its background work does not hold `work/running.lock`, and `assertSavedDataCompatible` reads the older folder.
   When the app's own folder holds saved work too, it asks which work to open instead (below).
2. It takes the move locks beside both folders, so the older app and a second launch both wait.
3. It counts the older folder and checks the disk has room: the bytes it copies, plus a margin of a twentieth (at least 256 MB), or the margin alone on APFS, where the copy clones its files.
4. It copies the older folder into `<folder>.moving-<process>`, a private folder beside the app's own, keeping permissions, times and links as links; a Mac clones each file with `cp -c`, elsewhere Node's copy asks for a reflink.
   Each attempt builds in a folder of its own, because a Mac's copier outlives an app that was stopped hard and keeps writing where it was told.
   Chromium's locks and caches, `worktree-trash` and `task-channel` stay behind (`LEFT_BEHIND`, `src/core/folderMove/tree.ts`), and so do sockets and pipes.
   In `work/`, what a live run, its service manager or a controller may still write while the copy is made stays behind too: Electron's own `chromium/`, `service.log`, `work.log`, the route and its lock, `running.lock`, the display's key, `worktree-trash` and `task-channel` (`WORK_LEFT_BEHIND`); the next run makes each again.
5. It checks the copy file by file: the same names, kinds, sizes, permissions and link targets, and every file's SHA-256.
6. It rewrites the app's own paths in the copy, only where a whole value is a path into the older folder, by either name of it (as the app named it, and as the disk resolves it): the projects' and tasks' folders, a Pi crewmate's session file and the settings' JSON in the database, `work/installed.json` and `work/left.json`, links whose target is absolute, and git's links between working copies and repositories in the folder.
   A task held on another computer keeps its row as it is, for its session file names that computer's file.
   Its project folder names this Mac's, and the row is left naming it in the older folder, so this Mac reads such a task's branch in its project's folder, never in the one its row names (`docs/helper.md`, "Reading its branch here").
   Prose keeps the paths it was written with, and Claude's transcript copies stay byte for byte.
   Opening the copied database replays its committed write-ahead log, so work the older app had not folded in comes over; the move then folds it in and checks every table keeps its rows and SQLite's own check passes.
7. It writes the record `verified`, writes `retired-profile.json` into the older folder, and renames the staged copy into place in one rename.
   A folder already there with no saved work - an installer's channel marker and nothing else - hands its marker over first, so the newer install's marker is kept.
8. After that commit it changes git's links in repositories kept outside both folders, keeping each file's earlier text in the record, copies Claude's session folders under the new working folders' names (`~/.claude/projects/<encoded folder>`, beside the old ones, never changing them), and writes the record `done`.
   The working folders are read from the new folder, two levels down from it and from its `work/`: the home's `worktrees/<task>`, and the `work/worktrees/<task>` a computer that runs work keeps (`src/core/folderMove/claudeSessions.ts`).

The older folder stays as it was, with only the marker added: it is the recovery copy, and nothing deletes it.
A move stopped before its copy was checked - a restart included - leaves nothing changed, and the next launch takes that staged copy away and starts again; one stopped after resumes from the last state its record names, and never copies again.
A full disk, the older app still open, its background work still running, another launch already moving, or saved work newer than this build reads stops the move with nothing changed.

When both folders hold saved work, the hand-over asks which to open and never merges them.
Bringing the older work moves the app's own folder aside first, to `<folder>-set-aside-<time>` beside it, and names that folder in the record.
Keeping the app's own work records `kept-own` in its folder, so the question is not asked again, and leaves the older folder as it is.

The hand-over window (`src/main/handOver.ts`, its page in `src/main/handOverPage.ts`) is a standalone page like the refusal windows: no preload and no script of its own, its buttons a form whose navigation the window reads and stops.
It shows the move as it goes, the question, or why the move stopped with Try again; once the work is in it says so, turns on start at login where the older app had it, and starts the app again on its own folder.
A development run opens `infinitary-dev` and first moves `firstmate-3000-dev` into it, so the move is rehearsed on a throwaway home whose `CFFIXED_USER_HOME` and `HOME` are scratch folders; the work mode makes its own move the same way.
It may stand in Firstmate 3000's folders instead with `INFINITARY_FOLDER_SPELLING=fm` (`folderSpellingFor`, `src/main/userDataDir.ts`), which opens `firstmate-3000-dev` and moves nothing, to make an older profile to move.
A packaged app ignores it, and a development run's hand-over leaves the computer's login items alone.

A computer that only runs work opens no window, so its work run makes the same move of the whole folder before it starts, and hands its background to the new app's label in the new folder (`docs/helper.md`, "Under the other name").
A window's saved work in that folder moves with it, as the window's own move would take the work; while the older app's window has the folder open, the work runs from the older folder and tries again at its next start.

The system keeps start at login per app, so the new app cannot read the older one's.
Firstmate 3000 records it in `start-at-login.json` each time it opens and each time the person changes it (`src/core/storage/startAtLoginRecord.ts`), and the move hands that record to the new app; on Linux the older app's autostart entry goes, since it would start the same program again.

## Visible refusal

`UnsupportedSavedDataError` carries the typed `unsupported-saved-data` code.
The Electron host catches only this refusal and displays a standalone offline window explaining that a newer version opened the saved work, and recommending a compatible alpha or compatible stable.
It has no preload, IPC bridge, agents, account services or normal application shell.
Closing it does not restore, delete or migrate anything.
Other startup failures retain their existing handling.

The guard does not prevent Electron from maintaining its own browser cache or single-instance files.
It prevents application-owned protected work, sign-ins, launch counters and database/derived-view changes on refusal.

## The knowledge collection

Knowledge (`docs/knowledge.md`) runs in every build and owns `knowledge/knowledge.db` with its own schema history.
Its first read inspects a private snapshot; a newer or unreadable collection stays unchanged, and no new agent work runs without its standing directions.
Knowledge schema 4 adds current directions and their future edit history, not a notes archive.
Main database schema 81 refuses earlier notes-writing builds.
Before agents start, the service carries active preferences with their identifiers, wording, scope, origin and dates, then removes the old tables.
A quit after the destination commit but before source removal retries only identical rows; a conflict stops startup.
All builds purge Knowledge after writers stop; no retired notes source can restore its contents.

## Activation boundary

Saved work is protected from stable 0.1.25 onward (`docs/alpha.md`, "Activating the channels").

## Verification

- `savedDataCompatibility.test.ts`: fresh/current/older migration history, future history, invalid and incompatible format markers, refusal preserving all seeded files, and WAL-only future migrations.
- `core.test.ts`: the real startup entry refuses before account/service state is initialized.
- `saved-data-refusal.spec.ts`: isolated Electron journeys for future database and incompatible non-database format; each sees the explanation with no normal bridge and verifies protected files unchanged after quit.
  Screenshots go to the run's own results folder.
- `older-profile.spec.ts`: a profile an older release saved opens in this build and works ("Profiles saved by an older release", below).
- `src/core/folderMove/move.test.ts`: the one-time move on real git and SQLite - a whole move whose newest rows are only in the write-ahead log, with Claude's sessions of the home's and the work's working copies, both names of a folder, both folders holding work, an interrupted copy, a copy that does not match, resuming after the check and after the commit, a full disk, the older app open, another move and newer saved work.

## Profiles saved by an older release

A change can keep what an older release saved readable while reading it differently, with no format revision: a new custom check profile makes every saved check an older release's (`docs/custom-api.md`, "Protocol and storage profile").
`tests/e2e/olderProfile.ts` keeps how earlier releases saved each such thing, and its `asSavedByOlderRelease` rewrites a profile set up on this build into that form while the app is stopped.
`older-profile.spec.ts` then opens the profile again, the upgrade a person makes, and checks the result they need.
For a profile whose only connection is a custom API, the first-launch gate names that connection right after the upgrade and asks for its one fresh check, never for a subscription.
That check, from the gate, brings back Firstmate's answers, the offered models and the crew slots chosen before the upgrade, without a restart.
A change that makes something an earlier release saved read differently adds the earlier form to `olderProfile.ts`, and a journey to `older-profile.spec.ts` when the change reaches a part of the app no journey there opens.

## Custom HTTP approval compatibility

Custom connections retain the persisted `unencryptedLocalApproved` boolean and `local-no-key` credential discriminator.
These legacy names now cover approved HTTP in every network mode, and explicit no-key in local or organization mode.
No serialized shape changes: old local approvals retain their meaning; new public/private HTTP addresses and private no-key connections are rejected by older policy rather than reinterpreted as encrypted or authorized differently.
The format revision therefore stays at 1.
Fresh preparation still requires HTTP approval for the exact reviewed destination in every mode.

Extra request headers (FI3-974) add an optional `headers` list to `custom-auth.json`; a connection saved before reads it as empty and keeps its proofs.
An older app drops the list when it reads the file, and its proofs no longer match the connection's models, so it sends nothing until the person checks again.
A public connection whose headers stand in for its key is refused by older policy.
The format revision stays at 1.

## Card pictures with a demo recording

A card picture may carry an optional `demo` (docs/card-authoring.md, "Demo recordings"): the recording its poster stands for - its id, kind, size, length, byte size and SHA-256.
It is saved wherever pictures are, as JSON inside `cards.pictures_json` and a card's `offer` observations, so no migration adds it, and the recording itself is a file beside the pictures in the task's `cards/` folder.
Cards saved before it read the same.
An older build reads a picture list with `demo` as unreadable, because its schema is strict: it shows neither that card on the stack nor as a past card, and nothing is rewritten or deleted, so the card is there again in a build that knows the field.
The same holds for a `demo` whose `kind` is `gif`, the single-play fallback, in a build that knew only `mp4`; its recording is a `.gif` file beside the pictures.
The format revision therefore stays at 1.

## Card answers with written words

A card answer may carry an optional `written` string (FI3-1002): the words written under a question's Something else row.
It is saved wherever answers are, as JSON inside `cards.answers_json`, the `card_resolved` event and a card's `action` and `message_ref` observations, so no migration adds it.
Answers saved before it read the same.
An older build reads an answer set that has `written` as no answers at all, because its schema is strict: a past card shows no picks and a reply its whole saved text, and nothing is rewritten or misread as an option.
The format revision therefore stays at 1.

## Brief receipts by reference

A `briefed` receipt stores each long report its brief copied as a short stand-in, such as `[report event 9540 of task 68d38170, kept on the record by reference]`, with the reference in the event's `data.reports` (FI3-390).
It is saved in the existing `task_events` columns, so no migration adds it.
Receipts saved before it carry no references and read the same.
An older build reads such a receipt's text as stored: the `tasks` query shows the stand-ins, each naming the report event a by-key read of that task lists, and nothing is rewritten or lost.
The format revision therefore stays at 1.

## Keys saved under the Tasks panel's old commands

The Tasks panel's commands were the catalog's `tasks.find`, `tasks.board`, `tasks.board-find`, `tasks.board-dropped` and `tasks.board-move`; since the panel is a folder they are `panel:now/find`, `panel:now/board` and the rest (`docs/keyboard.md`, "The Tasks panel's commands").
A key a person saved under an old id, in the `keyboard` settings row or a view's look, is read as the panel command's (`RETIRED_COMMANDS` in `src/shared/keymap.ts`), unless the panel command has a saved key of its own, which wins.
The row is never rewritten on read: the next change a person makes saves the map under the new ids, and the old ones go with it.
An older build reads keys saved under the new ids as keys of commands it does not know: listed, running nothing, kept until Reset all keys.
The format revision therefore stays at 1.

## Self-reported merge-card risk

Risk assessments keep only the crewmate's seven declared levels and reasons.
The assessment reader discards unknown historical fields, so saved cards with the former measurements retain their declaration and chart without showing measurements.
A previous build already supports declaration-only assessments, so no database migration or persisted-format revision is needed.

## Card revision links

Migration 72 adds nullable `card_messages.revision_json`, written only by CardStore for host revision rows.
It keeps typed source and predecessor offers, the frozen ordered destinations and whether the author closed out; legacy rows stay null.
Current-card destinations are a read-time projection, never a rewrite of the saved list.
An older build refuses the newer migration at the existing startup boundary.
Verified pictures additionally keep an optional SHA-256 in their saved metadata for content matching; older pictures without it retain their existing copy-name normalization.

## Retired keep-open card actions

Migration 73 drops each action whose saved `keepsOpen` is true from open cards, never only the flag, and resets their `streaming` status to `ready`.
Closed cards, revisions, steer events and recorded clicks remain unchanged.
Every outstanding `card-explain` inbox envelope becomes `{v: 1, text}` with the old rendered words frozen, including its value and answers.
In-flight and escalated rows are outstanding too: their delivery state is unchanged and a later delivery still reads the frozen prose.
`keep_open_backfill` keeps the original changed columns for each card or inbox row, keyed by source and row id, with its migration time.
To undo before any later writes, restore each card's `actions_json` and `status` and each inbox row's `payload` from that table, drop the table and remove migration 73's history row.
An older build refuses the upgraded profile until that database migration is undone.
The published `keepsOpen` field and `streaming` status stay accepted for wire compatibility but are never produced; the plugin manifest's `body.streaming` stays accepted and unread.
New action observations retain their required `keepsOpen` field as false, so historical observations remain readable.
`retireKeepOpen.test.ts` covers the upgrade, exact words, unchanged closed cards, undo rows and restart idempotence; `card-sent-settings.spec.ts` opens ready and streaming older cards and sends their settings by reply.

## What each device is

The home keeps what each device said it is in its hello - its system and chip - in `devices/systems.json`, a file of its own beside the device list (`docs/devices.md`, "The saved list").
The list itself keeps its shape, so an older build reads it as before and never reads the new file.
A `systems.json` this build cannot read is left as it is, and every device reads as a computer until it can.
The format revision therefore stays at 1.
