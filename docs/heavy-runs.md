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
After admission the child execs the original program, retaining standard input, output, error, environment and working directory; the outer wrapper returns its exit status.
The waiting wrapper prints line facts on standard error, leaving the admitted program's standard output intact.
Short claim requests use the existing two-second cadence and bypass the shell's kept-answer mechanism; the waiting wrapper is itself the shell job.

A nested wrapper carries `INFINITARY_LOAD_HOLD` and reuses the outer declaration only when the app verifies the same task and process group.
A nested demand larger than the outer declaration refuses before starting its program.
A disconnected or revoked command cannot start a new program; a living, already admitted group keeps its reservation.
An app restart refuses the old command keys, but restores the reservations of living groups before admitting new work.

## Capacity and pressure

Admission consumes the existing completed resource sample, not another CPU sampling loop.
The observation's age starts before sampling and must remain within the existing freshness allowance.
Missing or stale readings admit nothing.
The shared `resourceCapacity` owner retains the existing placement margins: 80 percent of observed idle processor capacity, and available memory minus the greater of 512 MiB or 10 percent of installed memory.
The line subtracts each living admitted declaration from that headroom before admitting another request.
This is conservative reservation accounting, not a prediction or a promise of physical isolation.
A normal request cannot pass an earlier waiting request, even if the later request is smaller.
A macOS warning or critical pressure reading suspends new admissions; normal pressure and fresh capacity allow the same line to advance.
The existing resource-pressure Activity and first-mate wake remain the only pressure notices.
No pressure change kills, pauses, slows or moves a running program.
The registered soft hold `load-line` passes only through the existing recorded captain override; the command has no bypass flag.

## A whole group's lifetime

A reservation belongs to the whole process group, not the requesting HTTP connection, model turn or group leader.
The app checks group existence without sending a terminating or scheduling signal.
A completed process-table reading also detects an ended group or a reused group identifier with a different birth stamp.
The line releases a declaration only after the registered group ends.
A descendant that survives its leader therefore keeps both the reservation and explicit task attribution, including after an app restart.
`ProcessRoots` registers group ownership separately from process roots, so an unrelated process that reuses the departed leader's PID cannot inherit its task attribution.

The line persists only the task id, request id, declaration, group id, birth stamp and waiting/running state in its own `load/holds.json`, under the home or work data folder.
It writes before answering admission and refuses admissions when its saved state cannot be read or written.
A failed declaration store leaves independent measured Use available and marks last-known declarations unavailable, never ended.
It stores no command, arguments, environment or credentials.
Disposal ends observation, not running work, and leaves the saved reservations for restart reconciliation.

Processes that escape the group, including work a system service starts, cannot be contained or attributed by a process-group reservation.
The caller includes that work's needs in its declaration and keeps the wrapped run alive until it finishes.
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
The home asks and grants the load capability only when the work computer lists the named `heavy-run-line` contract change.
An older computer is not asked and retains its existing capabilities.
The iPhone and iPad app retains its existing surface and ignores these optional facts.

## Checks

`src/core/placed/loadLine.integration.test.ts` runs real native wrappers through the task channel with a recorded ordinary-use Mac reading and explicitly supplied pressure states.
It exercises queue order, unchanged streams and exit status, pressure admission, unknown and stale readings, revoked waiters, surviving descendants, restart restoration, failed state writes, nested demands and recorded overrides.
`src/core/placed/processResources.test.ts` exercises declared-group attribution, PID reuse and explicit nested roots using recorded process metadata.
This project's own local phone gate and journey runs declare their runs through this command (`docs/testing.md`, "A local heavy run's place").
