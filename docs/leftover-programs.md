# Programs a task leaves running

A crewmate sometimes starts something that outlives the command that started it: a virtual machine started with `qemu -daemonize`, a `tart run` sent to the background, a booted simulator, a container or a server.
The system or one of its services adopts such a program, so ending the crewmate's session and its shell commands at the close does not end it.
When a task closes, the app runs the stops its crewmate registered, then ends the programs that still hold the task's working copy or temporary folder, and writes one line on the task's timeline (the captain's approved plan on INF-3447, direction A).

## Registering a stop

`infinitary-stops-axi` is in every crewmate's shell that has a task channel (`docs/axi-commands.md`, "The stops command").
`add --label "<what it stops>" '<command that stops it>'` registers a stop, `drop <id>` drops one the crewmate ran itself, and the bare command lists them.
A stop keeps its label, its command, and the folder the shell was in when it was registered, where it runs.
The stops live in `stops.json` in the task's own folder on the computer that runs the task (`crewmates/<task>/` here, the task's folder under the work folder on a computer that runs work), readable only by the user, so they survive a restart (`src/core/tasks/taskStops.ts`).
A stop deletes what the task created, such as a machine or a simulator it made, and only stops what it borrowed (the captain's answer on INF-3447).

## At the close

Every record close goes through `TaskClosing.closeAndPurge`, which begins the sweep as the record closes, after the crewmate's session and shell commands have ended (`LeftoverPrograms`, `src/core/tasks/leftoverPrograms.ts`): a finished, discarded, cancelled or failed task, a stronger-model retry's earlier attempt, and a task dropped before it started alike.
The working copy's retirement and the temporary folder's removal (`TaskTempFiles`) wait for the sweep, so nothing that holds a folder is moved away under it.

1. Each registered stop runs once, newest first, in its own process group with the host's environment, for at most a minute; the file is emptied first, so a close asked again runs none.
2. The app lists the programs that hold a file open under the working copy or the temporary folder, or work in one of them: through `lsof` on a Mac and `/proc` on Linux (`src/core/placed/folderHolders.ts`).
   Only the names under those folders are kept from what the system lists.
   A reading cut short at its time limit counts as unreadable, never as a list with no holders.
3. A holder is left alone when it is the app, one of its ancestors or anything the app started (a live task's shell commands among them), when it runs in a heavy-run group another live task declared (`docs/heavy-runs.md`), or when it was already running before the task started.
4. Each other holder gets an end request, then a kill after five seconds; its birth is read before each signal, so a number the system gave a new program is never signalled.
5. One timeline line names each stop and program and how it went; its data carries the typed report (`leftoversReportSchema`, `src/shared/leftoverPrograms.ts`) under `leftoverPrograms`.
   A stop that failed or did not finish, or a program that survived, makes the line news, and `leftoversKept` reads them back for later work.

A close with no stops and no holders writes nothing.
Windows has no holder reading, so only the registered stops run there.

## A task carried on by another

A task closed as carried on by a successor (`carriedOnClose`), or as the earlier attempt of a stronger-model retry, hands its stops to that task, after the successor's own, and runs none of them: what it registered belongs to the work that goes on (`openSuccessor`).
Its working copy and temporary folder still go, so the programs holding them are ended as at any other close, here and on a computer that runs work (the captain's answer on the review of INF-3447's piece 1).
A successor that is already closed would never run them, so they run at this close instead; one that closes later, even before it started, runs them at its own close.
The line says how many stops went to which task.
A successor already on another computer cannot run them there, so they run at this close instead.
Stops kept in a task's folder here run at its close here whatever computer it ran on, so stops handed to a successor before it started on a computer that runs work, or registered before a task moved off this computer, still run.

## On a computer that runs work

A computer that lists the `task-stops` contract change gives its crewmates the command (the placed spec's `stops`) and keeps their stops in each task's folder there.
Its close order, `inf:session:close`, runs the same sweep there once the conversation, its shell commands and its task channel have closed, and before the home retires the working copy or removes the temporary folder, which both follow that order.
The home names the task that carries the work on when it runs on that same computer (`carriedTo`) and when the task started (`startedAt`), and the order's answer carries the report (`leftovers`), which the home writes on the task's timeline once (`PlacedSessions.closeThere`).
Every close order the home sends goes through that one sender: the close of a closed task, the close before a task's working copy there is retired after it moved off that computer (`PlacedCopies.retireMoved`), and the close of a leftover a computer holds for a task the home no longer records there (`PlacedCopies.retireLeftover`).
The same holders are left alone there: the computer's own run and what it started, a group another task still open there declared, and a program running before the task started.
A leftover close after the task's record was purged carries no start time, so there every program holding the task's folders is ended.
A computer without the change gets neither, and its tasks keep today's close.

## What it leaves alone

The programs of open tasks and their heavy-run bookings (`docs/heavy-runs.md`), programs that hold no closed task's folder and were never registered, programs already running before the task started, and tasks closed before this shipped.
It never sweeps by age and never reaches other programs on the computer.
A program holding the task's working copy or temporary folder is ended at close whoever started it, including a terminal or editor a person opened there after the task started (the captain's answer on the review of INF-3447's piece 1).
