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

1. Each registered stop runs once, newest first, in its own process group with the host's environment, for at most a minute; the file is emptied first, so a close asked again runs none, and a stop that failed or did not finish is kept (see "What a close leaves").
   The task's keeps follow the stops: a merged or answered close leaves each job running, and any other close runs each keep's remove once, as a stop runs (see "A job the captain asked to keep").
2. The app lists the programs that hold a file open under the working copy or the temporary folder, or work in one of them: through `lsof` on a Mac, `/proc` on Linux, and on Windows each program's working folder and program file as the system lists them (`src/core/placed/folderHolders.ts`).
   Only the names under those folders are kept from what the system lists.
   A reading cut short at its time limit counts as unreadable, never as a list with no holders.
3. A holder is left alone when it is the app, one of its ancestors or anything the app started (a live task's shell commands among them), when it runs in a heavy-run group another live task declared (`docs/heavy-runs.md`), or when it was already running before the task started.
4. Each other holder gets an end request, then a kill after five seconds; its birth is read before each signal, so a number the system gave a new program is never signalled.
   While the process table cannot be read, its birth is unconfirmed, so it gets no signal and counts as surviving (`endHolder`).
5. One timeline line names each stop and program and how it went; its data carries the typed report (`leftoversReportSchema`, `src/shared/leftoverPrograms.ts`) under `leftoverPrograms`.
   A stop that failed or did not finish, or a program that survived, makes the line news, and `leftoversKept` reads them back for later work.
   New reports also retain their computer (`leftoversComputerId`, null for this computer) and whether they left an unresolved outcome (`leftoversUnresolved`), so memory pressure can seek those reports without reading the closed history.

## What a close leaves

A close keeps what it could not finish in `leftovers.json` in the task's own folder on the computer that ran it, readable only by the user (`src/core/tasks/leftBehind.ts`): each stop that failed or did not finish, with its command and folder, and each program that survived, with its number, name and start time as the system listed it.
The report on the timeline carries each program's start time too (`started`), never a command.
The file is one of the parts retention keeps (`docs/task-retention.md`), and goes only with the task's folder.
Beside the task folders, `.left-behind/` holds one empty marker per task that keeps a file, so the list reads only those tasks, never every folder the computer holds; a marker whose file is gone is removed when the list next reads it.

Each computer lists what its finished tasks left (`LeftBehindHere.list`): the kept stops, by label; the kept programs still running with the same number and start time; the finished tasks' runs still in its heavy-run line (`docs/heavy-runs.md`); and every task that still keeps something there.
A task counts as finished there only once its close has finished its own cleanup (`LeftoverPrograms.sweeping` here, `LeftBehindHere.sweep` around the close order on a computer that runs work), so nothing the close is about to end is listed.
Only the stops command's own `left`, read by a cleanup look on that computer, carries each kept stop's command; the order and the notices never do.
A program the process table cannot be read for is left out, never guessed alive.
A computer that runs work answers the list through `inf:computer:left-behind`; the home keeps only the tasks it records as finished and names each by its key (`src/core/placed/leftBehindNotices.ts`).
The pressure notice and the line-blocked notice carry that list (`docs/heavy-runs.md`, "Capacity and pressure").
A close that kept a file marks its report on the timeline (`leftoversKeptInFile`); once a list read for a notice shows that task keeps nothing there any more, the home marks the report resolved, so later notices and their Activity line stop naming it (`resolveClearedLeftovers`, `src/core/placed/pressureLeftovers.ts`).
A report from a close that kept no file stays as it was.

A cleanup look acts on the list through the stops command (`docs/axi-commands.md`, "The stops command") after the captain's pick.
`rerun` runs a kept stop once again as the close did, and drops it from the file when it runs cleanly or keeps its new outcome.
`end` sends an end request, then a kill after the grace period, each only when the program's start time reads equal to the kept one; a program gone or replaced by a new one with the same number leaves the file.
As at the close, `end` signals nothing while the process table cannot be read, and keeps the program in the file.
`drop <task> <stop id>` removes a kept stop without running it; a cleanup look uses it, without asking, for a stop whose target it found already gone.
All three refuse a task that is not finished on that computer, or whose close is still cleaning up.

A memory warning's one notice names those recorded unresolved outcomes by task on their recorded computer, without claiming the programs are still running or assigning them measured memory (`docs/heavy-runs.md`, "Capacity and pressure").
Older reports without computer provenance are not guessed onto a computer, and a successful stop or ended program is not named as a leftover.
A report recorded while that warning is open is named in the next warning's notice, not in a notice of its own.
The pressure notice offers no cleanup action.

A close with no stops and no holders writes nothing.
On Windows a holder is a program whose working folder or program file is under the task's folders, read from the system itself; Windows does not list which program holds a file open, so a program that only keeps a file there open is not found.

## A job the captain asked to keep

A job the captain's words ask to keep running after the task, such as a scheduled backup, is the captain's, not scaffolding (the captain's approved plan on INF-4381, direction A).
Its crewmate sets it up with the system's own scheduler as the account its shell runs as, and records a keep instead of a stop: `keep --label "<the job>" --check '<command that checks it runs>' '<command that removes it>'` (`docs/axi-commands.md`, "The stops command").
The app never reads the job's own files; the keep carries what the crewmate declared.
A keep is saved in the same `stops.json`, under `keeps`, with its label, its check and remove commands, the folder the shell was in, the account the shell runs as, when it was recorded, and its kept folder; keeps and stops share one count of ids (`src/core/tasks/taskStops.ts`).
Recording one answers a kept folder for the job's files, `kept/<task>-<id>` beside the task folders (`<userData>/kept` here, `kept` in the work folder of a computer that runs work), made readable only by the user.
It is outside the task's working copy and temporary folder, so no close removes it, and a removal of a computer that runs work leaves it, as it leaves the person's other files.

What the close does with a keep follows its close reason (`keepsAtClose`, `src/shared/leftoverPrograms.ts`):

- A close by a merge, a release, an answer or the captain's word (`landed`, `merged`, `released`, `answered`, `settled`, `finished`) leaves the job running and its kept folder in place.
  The keep leaves the task's file, and the home records the job in `kept/jobs.json` beside its task folders (`KeptJobs`, `src/core/tasks/keptJobs.ts`, its one writer), naming the computer (null for this one), the account, the label, its check and remove, its kept folder, the task and when; retention never removes it.
  The close's one line names each kept job ("job "<label>" keeps running"), and its report carries the jobs (`kept`).
- A discard, cancel or failure, or a superseded task with no open successor, runs each keep's remove once, newest first, after the stops and before the programs holding the task's folders are ended, as a stop runs (the captain's answer on INF-4381).
  A remove that ran cleanly takes the kept folder with it; one that failed or did not finish keeps the folder and is kept in `leftovers.json` as a failed stop is, where a cleanup look can run it again.
  The line names each remove and how it went, and the report carries them (`removed`).
- A task carried on by another hands its keeps on with its stops (below).

A crewmate whose task runs as another user on the home's own computer is refused a keep: the job would run as that user, not as the captain, so it says so on its card, and the first mate can start the job as a task under the captain's own account.
An administrator's step, such as a system-wide unit or letting a job run while the captain is logged out, is one required action on the crewmate's card naming its one command; no password or sign-in is ever asked for.
A job made before this shipped is not recorded.

### Kept running

Settings → Automation and the Automation panel list each recorded job under Kept running, by its label, the computer it runs on, the account it runs as and the task that set it up (`KeptRunning`, `src/core/tasks/keptRunning.ts`; the read `automation.kept`).
A job's id is its kept folder's own name, `<task>-<id>`, and for a job on a computer that runs work `@` and that computer's id too, since a task that moved computers counts its keeps again from 1 there.
Check runs the job's check where it runs and notes on its record whether it exited 0 (running), exited otherwise (not running), ran past the stops' minute, or could not reach that computer.
Remove asks once, as its button turns into Remove for good, then runs the job's remove there through the catalog's `kept-job-remove`, which the first mate can also run when the captain asks.
A remove that ran cleanly takes the kept folder and drops the job from `kept/jobs.json`; one that failed, did not finish, or could not reach the computer keeps the job listed with how it went.
Here the command runs as a close runs a stop, in the kept folder; on a computer that runs work the home sends `inf:computer:kept-job` (`kept-job-orders.md`) with the command it keeps, and that computer runs it only in a folder directly inside its own kept folder.
On either computer a kept folder that is gone is made again before the command runs, so it never runs among other jobs' folders.
A computer out of reach, or one without that change, runs nothing, and the job stays.
Beside a remove that did not finish, Forget takes the job off the list without running anything (`inf:automation:kept-forget`, through `KeptJobs.forget`); its words say the job may still run on that computer, whose kept folder stays.
Forget stays the captain's click: asked to forget one, the first mate's `kept-job-forget` offers a card whose Open Automation opens Settings → Automation on that job (`item` `kept:<id>`), and it is refused for a job whose remove did not fail.

## A task carried on by another

A task closed as carried on by a successor (`carriedOnClose`), or as the earlier attempt of a stronger-model retry, hands its stops and keeps to that task, after the successor's own, and runs none of them: what it registered belongs to the work that goes on (`openSuccessor`).
A handed keep keeps its kept folder, and the successor's own close decides it.
Its working copy and temporary folder still go, so the programs holding them are ended as at any other close, here and on a computer that runs work (the captain's answer on the review of INF-3447's piece 1).
A successor that is already closed would never run them, so they run at this close instead; one that closes later, even before it started, runs them at its own close.
The line says how many stops and kept jobs went to which task.
A successor already on another computer cannot run them there, so they run at this close instead.
Stops kept in a task's folder here run at its close here whatever computer it ran on, so stops handed to a successor before it started on a computer that runs work, or registered before a task moved off this computer, still run.

## On a computer that runs work

A computer that runs work gives its crewmates the command (the placed spec's `stops`) and keeps their stops in each task's folder there.
Its close order, `inf:session:close`, runs the same sweep there once the conversation, its shell commands and its task channel have closed, and before the home retires the working copy or removes the temporary folder, which both follow that order.
The home names the task that carries the work on when it runs on that same computer (`carriedTo`), when the task started (`startedAt`), and `keeps: "keep"` for a merged or answered close (`kept-jobs.md`), and the order's answer carries the report (`leftovers`), which the home writes on the task's timeline once (`PlacedSessions.closeThere`).
An order that says nothing on keeps, as from a home without the change or for a task that moved off that computer, removes them.
The report's kept jobs are recorded at the home under that computer, once per kept folder.
The placed spec's `keeps` grants the command's `keep` there: the home sends true to a computer that lists the change, and false to one that runs as another user on the home's own computer, whose crewmate hears that refusal; a computer the home sent nothing refuses a keep too.
Every close order the home sends goes through that one sender: the close of a closed task, the close before a task's working copy there is retired after it moved off that computer (`PlacedCopies.retireMoved`), and the close of a leftover a computer holds for a task the home no longer records there (`PlacedCopies.retireLeftover`).
The same holders are left alone there: the computer's own run and what it started, a group another task still open there declared, and a program running before the task started.
A leftover close after the task's record was purged carries no start time, so there every program holding the task's folders is ended.
A computer without the change gets neither, and its tasks keep today's close.

## What it leaves alone

The programs of open tasks and their heavy-run bookings (`docs/heavy-runs.md`), programs that hold no closed task's folder and were never registered, programs already running before the task started, and tasks closed before this shipped.
It never sweeps by age and never reaches other programs on the computer.
A program holding the task's working copy or temporary folder is ended at close whoever started it, including a terminal or editor a person opened there after the task started (the captain's answer on the review of INF-3447's piece 1).
