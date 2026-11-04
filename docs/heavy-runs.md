# Declared heavy runs

The accepted load design (INF-1621 piece 2) puts heavy programs in one admission line on the computer that runs them.
It does not put crewmates in a load queue or change task placement.
The caller judges and declares the entire run's processor and memory needs; the app neither estimates a request nor enforces a running process's use.
`LoadLine` (`src/core/placed/loadLine.ts`) is the one writer of declarations, admission and saved group ownership on each computer.
The home owns its local line and each work computer owns its own line.

## Asking and running

The task's `infinitary-load-axi` command uses the existing task command channel ([AXI commands](axi-commands.md)).
A bare invocation reads only that task's declared runs.
`infinitary-load-axi run --processors <number> --memory-mib <number> -- <program> [arguments]` declares positive processor equivalents and memory in MiB, then waits for admission.
The launcher starts its waiting child in a native process group before asking, and the app verifies that group's live process identity.
The caller's program and arguments stay in that shell, never crossing the task channel.
After fresh admission the group leader becomes a small native supervisor, which creates the payload once in the same group with inherited input, output, error, environment, arguments and working directory.
The supervisor forwards termination and interrupt signals, waits for the payload and returns its exit status; it never stops a payload for load or a missing receipt.
It exports the inherited hold before payload creation; verified nesting execs in that same group without creating another supervisor or changing its startup charge.
A shell asynchronous payload would inherit ignored interrupt handling, so `scripts/load-supervisor.c` owns fork, signal forwarding and waiting instead.
The build compiles this helper for both Mac chips or the current Linux architecture, following the existing native git-launcher pattern, and ships it outside the archive in `load-bin`.
Disposable native checks use the same compiled helper.
The waiting wrapper prints line facts on standard error, leaving the admitted program's standard output intact.
Short claim requests use the existing two-second cadence and bypass the shell's kept-answer mechanism; the waiting wrapper is itself the shell job.
A command process that cannot start, exits without answering or reaches its deadline answers an admission claim with the typed `CLAIM_UNAVAILABLE` outcome and the same reading cadence.
A transport timeout on a claim carries that outcome too; a first transport timeout has already waited out its bound, and later attempts reuse the last cadence received.
The wrapper keeps the same process group and declaration and asks again, without a limit on how long it can remain queued.
A lost claim reply may finish on the host later, but neither that reply nor a remembered admission starts the program: the wrapper still requires its own fresh successful admission answer.
Admission recovery applies only before payload creation, never to a payload launch or another command's effects; invalid requests, revoked keys, lost channels and owner refusals still end the waiting wrapper.
If a later process-table reading is unavailable, a previously verified caller with the same task, group and declaration keeps waiting in its existing place instead of treating the missing reading as proof it ended.
The reply grants no execution until a fresh reading verifies the caller, even if capacity has already admitted its saved hold; that reservation remains counted in the meantime.
An unreadable first claim, a caller absent from a readable table, a changed declaration and an unverified nested claim still refuse.

A nested wrapper carries `INFINITARY_LOAD_HOLD` and reuses the outer declaration only when the app verifies the same task and process group.
A nested demand larger than the outer declaration refuses before starting its program.
A disconnected or revoked command cannot start a new program; a living, already admitted group keeps its memory growth reservation and any unconfirmed processor startup charge.
An app restart refuses the old command keys, but restores the reservations of living groups before admitting new work.

## Launch receipts

After creating the payload, the supervisor starts a same-group receipt worker with no caller streams.
The receipt names only task-bound hold, supervisor PID and durable birth identity, plus payload PID and birth identity; the command, arguments and environment stay local.
LoadLine verifies live group membership and both identities, rejects exited payloads, and saves the launch identity before acknowledging it.
Receipt birth stamps use Linux start ticks or a targeted UTC Mac reading, independent of the payload shell's timezone; existing saved group birth fields keep their original format.
Repeated exact receipts are idempotent; a different payload, changed identity, ended hold, revoked grant or failed store cannot clear a startup charge.
The native supervisor retains an exited payload's PID until receipt pursuit stops, preventing reuse during that handoff.
An interrupted receipt operation returns `RECEIPT_UNAVAILABLE`, separate from `CLAIM_UNAVAILABLE`.
Only that receipt repeats after launch, never admission or payload creation.
The worker stops on payload exit and cancels its pending transport or cadence wait; an unverified short-lived payload leaves the startup charge while its group remains.
Both operations carry stable operation identities and clear the shell cap and shell ID, avoiding unrelated kept answers without changing command or transport bounds.
A timeout is an unknown outcome, not evidence that the host did nothing.

## Capacity and pressure

Admission consumes the existing completed resource sample, not another CPU sampling loop.
The observation's age starts before sampling and must remain within the existing freshness allowance.
Missing or stale readings admit nothing.
The shared `resourceCapacity` owner retains the existing placement margins: 80 percent of observed idle processor capacity, and available memory minus the greater of 512 MiB or 10 percent of installed memory.
With no admitted run, the first waiting request starts when its memory declaration is at most installed memory less that same memory margin, regardless of processor load or today's available memory (INF-1685 and INF-2165, direction A).
It still needs a fresh reading with a memory figure and normal pressure.
Further requests need 80 percent of whole-computer observed idle processors, minus the full processor declarations of admitted starts not yet covered by a qualifying aggregate interval.
There is no admitted-group CPU add-back or persistent maximum-of-declared-and-measured charge after coverage.
Each admission spends and durably saves its startup declaration before answering, including repeated claims, observation callbacks, timer passes and reconsideration.
The sampler supplies the actual aggregate CPU interval endpoints and sampler lifetime locally, independently of its process window and the callback's request-start time.
An interval must begin strictly after the host verifies launch; a larger sample number, a reused endpoint or a process-window duration is not sufficient.
Duplicate, out-of-order or retired-lifetime intervals cannot advance coverage or refresh capacity.
A new sampler lifetime requires new coverage; missing per-group CPU counters alone do not defeat trustworthy aggregate readings.
Until coverage the full startup declaration remains, even when aggregate use already includes some startup work.
A covered living group still counts as admitted for the no-admitted-run exception.
Later processor bursts may slow running work; admission neither predicts them nor stops existing work.
Memory counts each admitted run once (INF-2165).
The available-memory reading already lacks a running group's resident memory, so the line adds that measured resident memory back to the headroom and then reserves the larger of the run's declared and resident memory.
Resident memory comes from the same process-table reading and needs no processor window.
A run with no measured memory reserves its declaration with nothing added back.
This is admission accounting, not a prediction or a promise of physical isolation.
A normal request cannot pass an earlier waiting request, even if the later request is smaller.
A macOS warning or critical pressure reading suspends new admissions; normal pressure and fresh capacity allow the same line to advance.
The existing resource-pressure Activity and first-mate wake remain the only pressure notices.
Activity shows one line per pressure change: the computer, the level and the task holding the most memory; the first-mate wake carries every task's share (`src/core/placed/resourcePressure.ts`).
No pressure change kills, pauses, slows or moves a running program.
The registered soft hold `load-line` passes only through the existing recorded captain override; the command has no bypass flag.

## A whole group's lifetime

A reservation belongs to the whole process group, not the requesting HTTP connection, model turn or group leader.
The app checks group existence without sending a terminating or scheduling signal.
A completed process-table reading also detects an ended group or a reused group identifier with a different birth stamp.
The line releases a declaration only after the registered group ends.
A descendant that survives its leader therefore keeps its hold and explicit task attribution, including after an app restart.
`ProcessRoots` registers group ownership separately from process roots, so an unrelated process that reuses the departed leader's PID cannot inherit its task attribution.

The line persists only the task id, request id, declaration, group id, birth stamp, waiting/running state and optional verified payload identity in its own `load/holds.json`, under the home or work data folder.
It writes before answering admission and refuses admissions when its saved state cannot be read or written.
A failed declaration store leaves independent measured Use available and marks last-known declarations unavailable, never ended.
It stores no command, arguments, environment or credentials.
Legacy holds without verified launch evidence keep their processor declarations until the group ends.
Restored verified launches retain their startup charge until a current-lifetime interval covers the restart boundary; saved monotonic times are never compared across restarts.
Older code ignores the additive launch field and restores the full declaration conservatively.
Disposal ends observation, not running work, and leaves the saved reservations for restart reconciliation.

Processes that escape the group, including work a system service starts, cannot be contained or attributed by a process-group reservation.
The caller includes that work's needs in its declaration and keeps the wrapped run alive until it finishes.
This project's local virtual Macs borrow a virtual place through `borrow-virtual-mac` instead (`docs/testing.md`, "A virtual Mac as a runner").
Their phone and journey gates reuse `BORROWED_PLACE` and do not ask this load line; the virtual Mac appears here only as measured load.
Programs that never declare a run stay visible through measured resource use; the app does not pretend to contain them.

## What the task shows

The task record keeps measured Use unchanged and adds a separate Run row for its declared runs.
Waiting says which computer, why it is waiting or how many runs are ahead, and the declared processor and memory amounts.
Running shows the same declaration with its admitted state; it never calls that declaration measured use.
A lost connection preserves explicitly unavailable last-known run state instead of implying the run ended.
The row adds no control or task status.
Living declarations count as background work for the existing task witness, even after the requesting shell exits; a remote declaration must still have fresh contact.

The optional load facts ride the existing computer-resource view and its two-second feed.
The authenticated `inf:computer:load` order carries only already-recorded overrides and returns line facts, never process identities or commands.
The home reads standing overrides through `TaskService.passingOverridesForComputer`, seeking only non-null permission overrides and joining their execution computer and evidence head by task id, without composing task records.
Closed tasks remain eligible because a declared process group can survive its task closing; `overridePasses` retains the recorded hold and version scope.
The home asks and grants the load capability only when the work computer lists the named `heavy-run-line` contract change.
An older computer is not asked and retains its existing capabilities.
The iPhone and iPad app retains its existing surface and ignores these optional facts.

## Checks

`src/core/placed/loadLine.integration.test.ts` runs real native wrappers through the task channel with a recorded ordinary-use Mac reading and explicitly supplied pressure states.
It exercises queue order, unchanged streams and exit status, pressure admission, unknown and stale readings, interrupted claim commands retaining their identity and hold, revoked waiters, surviving descendants, restart restoration, failed state writes, nested demands and recorded overrides.
`src/core/axi/channel.test.ts` checks the launcher's transport-timeout classification and that an interrupted non-load action remains terminal rather than gaining retry permission.
`src/core/placed/processResources.test.ts` exercises declared-group attribution, PID reuse and explicit nested roots using recorded process metadata.
This project's own local phone gate and journey runs declare their runs through this command (`docs/testing.md`, "A local heavy run's place").
