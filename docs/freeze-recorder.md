# The freeze recorder

The freeze recorder notices when the app's main thread, which handles the captain's clicks and keys and runs the core, stops answering, and records where it was (INF-2061's plan, built as INF-2066).
Its code is `src/core/freeze/freezeRecorder.ts`, and its watchdog's is `src/core/freeze/watchdog.ts`.

## When it runs

It runs in an alpha build and nowhere else, which is the captain's answer on INF-2061: "activate it only in alpha builds".
A run that sets `INFINITARY_FREEZE_RECORDER=1` turns it on too, so an end-to-end journey can read the record of an unpackaged build.
The latency check reads it while the captain types and scrolls on a record the captain's size (`docs/testing.md`, "The latency check").
A stable build and an ordinary development run never start it.

## How it notices a freeze

The main thread sends a heartbeat every 10 ms (`HEARTBEAT_MS`) to a watchdog on its own worker thread, each carrying `process.threadCpuUsage()`.
When no heartbeat has come for 50 ms (`FREEZE_THRESHOLD_MS`, INF-2078's plan: the stall a person feels while typing or scrolling), the watchdog pauses the main thread once through the inspector (`inspector.Session.connectToMainThread()`), reads its call frames and resumes it.
The line is written when the stall ends, when the next heartbeat brings the processor time the main thread spent during it.
A gap the watchdog's own timer also slept through is the whole computer pausing, such as sleep, and is not recorded.

The watchdog keeps the inspector's debugger enabled from the start.
Enabled only after a stall, a wait's pause landed in code that ran after the wait (INF-2061's lab).
In Electron 43.4.0's main process, enabling it ahead left busy code and JSON parsing as fast as before.
A `debugger` statement the main thread reaches while it is enabled is resumed at once.

## At startup

Enabling the debugger reads every script the main thread has loaded so far, all at once on the main thread: it hashes each script's source and counts its lines.
Each script loaded after that is read as it loads.
Enabled when the core started the recorder, it read the app's whole main process, 33 MB of source in 2,880 scripts, and held the main thread for 386 ms of its own processor time on a Mac and 537 to 638 ms on the Linux runners, one stall with no names (INF-2071).
So the app's main entry (`src/main/index.ts`) arms the watchdog before it loads the app's own code (`armWatchdog`), where the debugger reads only the few scripts loaded so far, and waits until it is on; the main thread answers the watchdog while it waits.
The rest is read script by script as the app's code loads, before the recorder starts.
The recorder takes that watchdog when the core starts it (`takeWatchdog`), so a stall from its first heartbeat is named.
A core started with nothing armed, such as one in plain Node, starts a watchdog without waiting: its debugger comes on while the recorder already watches, so the cost of enabling it is recorded as a stall rather than hidden before the record starts.

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
