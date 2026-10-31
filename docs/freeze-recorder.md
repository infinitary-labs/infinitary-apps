# The freeze recorder

The freeze recorder notices when the app's main thread, which handles the captain's clicks and keys and runs the core, stops answering, and records where it was (INF-2061's plan, built as INF-2066).
Its code is `src/core/freeze/freezeRecorder.ts`.

## When it runs

It runs in an alpha build and nowhere else, which is the captain's answer on INF-2061: "activate it only in alpha builds".
A run that sets `INFINITARY_FREEZE_RECORDER=1` turns it on too, so an end-to-end journey can read the record of an unpackaged build.
A stable build and an ordinary development run never start it.

## How it notices a freeze

The main thread sends a heartbeat every 50 ms (`HEARTBEAT_MS`) to a watchdog on its own worker thread, each carrying `process.threadCpuUsage()`.
When no heartbeat has come for 100 ms (`FREEZE_THRESHOLD_MS`), the watchdog pauses the main thread once through the inspector (`inspector.Session.connectToMainThread()`), reads its call frames and resumes it.
The line is written when the stall ends, when the next heartbeat brings the processor time the main thread spent during it.
A gap the watchdog's own timer also slept through is the whole computer pausing, such as sleep, and is not recorded.

The watchdog keeps the inspector's debugger enabled from the start.
Enabled only after a stall, a wait's pause landed in code that ran after the wait (INF-2061's lab).
In Electron 43.4.0's main process, enabling it ahead left busy code and JSON parsing as fast as before and cost about 10 microseconds for each script the main thread compiled.
A `debugger` statement the main thread reaches while it is enabled is resumed at once.

## The record

The record is `freezes.jsonl` in the app's data folder (`AppPaths.freezeRecordPath`), written only by the watchdog.
It keeps the newest 500 lines (`RECORD_MAX_LINES`) and drops older ones.
Each line holds when the stall began, its wall time between heartbeats (`wallMs`), the main thread's own processor time in it (`cpuMs`) and the call path, innermost first, each frame with its function name, file name, line and column.
It records no arguments, values or text, and nothing sends it anywhere: Diagnostics sends nothing new.

A line's names can be marked `uncertain`:

- `waited`: the main thread spent under half the stall on its own processor, so it was waiting outside JavaScript, on another program or a file, and the pause landed after the wait.
- `late`: the names were read only after the stall had ended.

On a computer busy enough to take the processor away from the app, busy code can also fall under half and be marked `waited`; the mark then errs toward doubt, never toward trust.

A stall spent inside one long built-in call, such as one JSON parse, is named at its caller, because V8 pauses only when JavaScript runs again, and the innermost name can be the code the caller ran next.

## The first mate's offer

Each recorded line is handed to the core.
When one of the captain's projects lives at Infinitary's own source on GitHub (`INFINITARY_SOURCE`, matched by where the project lives, not its name), the first mate hears a `freeze-recorded` wake, once per call path.
The captain's answer on INF-2061 asked for exactly this: "offer a fix task only if the canonical infinitary github repo is a project in the project list".
The wake gives the facts and leaves the judgment to the first mate: whether the freeze is worth a fix, and if so a decision card offering a fix task in that project.
With no such project the line stays in the record only.

## Not covered

It watches only the app's main thread, not a window's own drawing thread.
The packaged build's fuses turn off the inspector's command-line arguments, not an in-process session; the recorder has not yet been run under them.
