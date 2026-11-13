# The freeze recorder

The freeze recorder notices when the app's main thread, which handles the captain's clicks and keys and runs the core, stops answering, and records where it was (INF-2061's plan, built as INF-2066).
Its code is `src/core/freeze/freezeRecorder.ts`, and its watchdog's is `src/core/freeze/watchdog.ts`.

## When it runs

It runs in an alpha build and nowhere else, which is the captain's answer on INF-2061: "activate it only in alpha builds".
A run that sets `INFINITARY_FREEZE_RECORDER=1` turns it on too, so the freeze journey can read the record of an unpackaged build ("Before a change merges").
The latency check reads it while the captain types and scrolls on a record the captain's size (`docs/testing.md`, "The latency check").
A stable build and an ordinary development run never start it.

## How it notices a freeze

The main thread sends a heartbeat every 10 ms (`HEARTBEAT_MS`) to a watchdog on its own worker thread, each carrying `process.threadCpuUsage()`.
When no heartbeat has come for 50 ms (`FREEZE_THRESHOLD_MS`, INF-2078's plan: the stall a person feels while typing or scrolling), the watchdog pauses the main thread once through the inspector (`inspector.Session.connectToMainThread()`), reads its call frames and resumes it.
The watchdog persists an incident start before asking the inspector for names or receiving another heartbeat.
When the next heartbeat arrives, it completes the same incident with the processor time the main thread spent during it.
Elapsed heartbeat and watchdog times use the monotonic clock; wall time labels the record only.
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

Electron's creation of the app's first window is one long native call on a slow processor, which the app cannot divide.
So the app's start waits for a timer turn between the core's start and the window's creation (`src/main/app.ts`): the timers that came due while the core started run before the window is made, and the two are separate stalls (INF-2338).
An immediate would not do it: it runs in the same turn as the input that finished the start, with no timer between.

## The record

The record is `freezes.jsonl` in the app's data folder (`AppPaths.freezeRecordPath`), written only by the watchdog.
It keeps the newest 500 lines (`RECORD_MAX_LINES`) and drops older ones.
Legacy lines remain readable and unchanged.
New lines have an `incidentId` and a `status`: `started`, `completed` or `interrupted`.
The watchdog atomically replaces a start with its completion under the same identity, retaining one snapshot per incident within the existing line bound.
At the next recorder start it marks unfinished starts interrupted, recording when it observed the interruption, never inventing an end, duration, processor time or names.
An interrupted line remains interrupted on later starts.
A completed line holds when the stall began, its elapsed time between heartbeats (`wallMs`), the main thread's own processor time in it (`cpuMs`) and one captured JavaScript location, innermost first, each frame with its function name, file name, line and column.
`captureRequestedAt` records when the watchdog requested the pause and `capturedAt` when it received the paused frames, independently of the ending heartbeat.
The same started snapshot is updated as capture facts arrive, so interruption retains observed timing without inventing missing measurements.
Unfinished snapshots retain no frames, as in the incident lifecycle's original contract.
An old record or a capture never requested or received leaves the corresponding time absent, never inferred.
Each line also notes what the main thread's last heartbeat before the stall said about the windows and its speed (INF-3896, which found the app running the same work 2 to 12 times slower than a timing run and could not tell why).
`window` is `focused` when one of the app's windows had focus, `visible` when one was shown and not minimized, `hidden` when all were hidden or minimized, and `none` with no window; the main thread reads it every tenth heartbeat (`WINDOW_READ_BEATS`), and a process with no windows, such as a computer that runs work, leaves it absent.
`speed` is how long a fixed piece of work, the speed probe (`SPEED_PROBE_ROUNDS`, about 6 microseconds on a Mac's fast core), took the main thread in nanoseconds: `beforeNs` in the heartbeat before the stall, `afterNs` in the heartbeat that ended it, and `fastestNs`, the fastest it ran in this run so far.
A before or after several times the fastest is the main thread running slowly, such as on an efficiency core or while the system throttles the app, rather than doing more work; the main thread's processor time alone cannot tell the two apart.
A start carries the window and the speed before; only a completion has the speed after.
`build` preserves the recording computer's existing source identity (version, source commit or unknown, and whether its source is mutable), not the investigating checkout's identity.
It records no arguments, values or text, and nothing sends it anywhere: Diagnostics sends nothing new.

A line's names can be marked `uncertain`:

- `waited`: the main thread spent under half the stall on its own processor, so it was waiting outside JavaScript, on another program or a file, and the pause landed after the wait.
- `late`: the names were read only after the stall had ended.

On a computer busy enough to take the processor away from the app, busy code can also fall under half and be marked `waited`; the mark then errs toward doubt, never toward trust.

A stall spent inside one long built-in call, such as one JSON parse, is named at its caller, because V8 pauses only when JavaScript runs again, and the innermost name can be the code the caller ran next.
Every stack is a captured location, not a cause or a duration for any named function, even when processor use is high and capture precedes the ending heartbeat.
The absence of a `waited` or `late` mark establishes no cause.

## The minute pass's steps

Most recorded stalls began in the seconds right after the once-a-minute pass over open tasks, and their call paths were spread over hundreds of places, so the record could not say which step of the pass crossed the line (INF-4076).
The recorder now times each step and tags each stall with the step that was running (`src/core/freeze/passSteps.ts`, `PassSteps`).
A step is one pass the ticker runs (`src/core/orchestrator/ticker.ts`), named as it registered, such as `idle-ladder`, `gate-sweep` or `check-watch`, and three pieces of work the passes set off that run in turns of their own: `sweep-release`, which lets the held board and presentation updates go, `board-push`, the task board's push, and `presentation-refresh`, each row's posture and place.
A pass that starts async work returns its promise to the ticker, which awaits nothing; only the steps follow it, to see when it settles.
With no recorder, which is every build but an alpha, a step only runs; with one, the step's result, its thrown error and a rejection left unhandled are the same as before.

Each stall's line, started or completed, carries `step` when the main thread was inside a step or a step's promised work was outstanding:

- `running`: the step whose synchronous work the main thread was in when the stall began.
- `unsettled`: the steps whose promises had not settled yet.

The main thread tells the watchdog each time the running step or the unsettled set changes, as a message apart from the heartbeat, so the tag is what the main thread said just before it stopped.
Unsettled work says only that the stall fell while it was outstanding, not that it ran then: several steps' work can be outstanding at once.

The pass record is `minute-passes.jsonl` in the app's data folder (`AppPaths.passRecordPath`), written only by the watchdog, off its watching timer so a large file never looks like the computer slept.
It keeps the newest day of passes (`PASS_RECORD_MAX_LINES`) and drops older ones.
Each line is one pass: when it began, the build identity, and every step run from its start to the next pass's start, board pushes and refreshes the crew set off included, each with when it started after the pass began (`startMs`), its synchronous time (`syncMs`), the main thread's own processor time in that (`cpuMs`) and, for a step that returned a promise, when it settled after the step started (`workMs`), or `unsettled` when it had not by the next pass.
A pass's line is written when the next pass starts, so a run's last pass is never written.
Joining the two records by time shows which step was running at each stall and how long the same step took in minutes without one.

## The memory reading

Beside the stalls, the recorder reads the main process's own memory at its start and every five minutes after (`MEMORY_READING_MS`, `src/core/freeze/memoryRecorder.ts`), INF-2392's plan after it found the main process holding 9 GB and could not tell from outside the app what held it.
The record is `memory.jsonl` in the app's data folder (`AppPaths.memoryRecordPath`), written by the main thread, one JSON line per reading.
It keeps the newest week of readings (`MEMORY_RECORD_MAX_LINES`) and drops older ones.
The reading needs no watchdog, so it runs even when the watchdog cannot start.

Each line holds, in bytes:

- `footprintBytes`: the process's physical footprint as the system counts it, compressed and swapped memory included (Electron's private footprint, macOS's `phys_footprint`, what Activity Monitor shows); absent where the host cannot read it, never zero.
- `rssBytes`: resident memory only, which leaves out what the system compressed or swapped.
- `heapTotalBytes` and `heapUsedBytes`: the JavaScript heap, and the live part of it.
- `externalBytes` and `arrayBuffersBytes`: native memory JavaScript objects still hold, such as buffers, and the part of it in array buffers.
- `mallocedBytes`: memory V8 itself allocated outside its heap.

It also holds when it was read, the process id, the process's uptime in seconds and the recording build's source identity.
The split (`memorySplit`) reads the JavaScript heap, the native memory JavaScript holds (`externalBytes`), and the native memory nothing in JavaScript holds: the footprint less the other two, unknown when the footprint is.
A growing third part points at native objects the app's code no longer reaches, and a growing second part at buffers it still does.
It records no values or text, and nothing sends it anywhere.

## The per-version tally

Beside the record, the recorder keeps every stall each installed version had, over every run of it on this computer (INF-3044's plan, the captain's ask that the once-per-version summary "cover all freezses that happened from that app version").
The tally is `freeze-tally.json` in the app's data folder (`AppPaths.freezeTallyPath`, `src/core/freeze/freezeTally.ts`), written only by the main thread, and the record's 500-line bound does not cut it short.
For each version it holds the runs the recorder started, the time those runs were awake on the monotonic clock, which a sleeping computer stops, the completed stalls with their time between heartbeats and processor time in all, the unfinished ones, and every captured location with its count, time, processor time, longest stall, first and last seen and how many of its stalls were marked `waited` or `late`.
A location is the exact captured call path; a stall with no frames captured has a location of its own.
It also keeps the longest completed stall whole, or the newest unfinished one when none completed, as the summary's example.
Each stall counts toward the version in its own build identity, so an unfinished stall recovered at the next start counts for the version that had it.
The recorder writes the tally every minute (`TALLY_WRITE_MS`) and when it stops; a run that is force-quit loses the completed stalls of its last minute from the tally, while its unfinished stall is recovered from the record.

## The first mate's offer

Each completed or recovered interrupted incident is handed to the core and counted in the tally.
When the app first starts on a new version, the watchdog first recovers the previous runs' unfinished stalls and says so (`{ recovered: true }`); the recorder then takes every earlier version out of the tally and hands each that had a stall to the core as that version's summary (`onVersionsEnded`).
When one of the captain's projects lives at Infinitary's own source on GitHub (`INFINITARY_SOURCE`, matched by where the project lives, not its name), the first mate hears each summary as a `freeze-recorded` wake, at most once per installed app version through the durable inbox's once-identity.
The wake says how many runs and minutes awake the version had, how many times the main thread stopped and about how many a minute, their time and processor time in all and any that never finished, then every location, most time first, each with its count, time, processor time, longest, first and last seen and uncertain marks, and the longest stall's identity and capture timing.
A list of locations too long for one message spills whole to a file (`capWithOverflow`), and the wake names it.
Different call paths, restart, acknowledgement or dismissal do not reset that identity; another installed version has its own allowance.
A version that ends while no such project is on the list is taken out of the tally and never summarized, and one kept for days sends nothing until the next version starts.
A wake saved before the tally (one stall, or one run's stalls with its longest) still renders with its old words.
Explicit captain questions are independent of this automatic allowance.
The captain's answer on INF-2061 asked for exactly this: "offer a fix task only if the canonical infinitary github repo is a project in the project list".
The wake gives the facts and leaves the judgment to the first mate: whether investigation is worthwhile, and if so a decision card offering a fix task whose first work is diagnosis.
A cause remains a hypothesis until measured in the affected context; a targeted repair requires causal before/after evidence with comparable workload and instrumentation.
A later fast lookup in a different process or snapshot neither identifies nor excludes the original cause.
The brief preserves incident/build identity, interval measurements and request/capture timing, explicitly naming missing evidence instead of inventing it.
With no such project the line stays in the record only.

### Replaying misleading attribution

The deterministic incident replay in `src/core/freeze/freezeRecorder.test.ts` renders the production wake from retained INF-2239/INF-2262 facts.
It retains the 324 ms interval, 298 ms processor reading and sampled function-name order; unavailable original fields are explicitly absent or marked not retained.
It checks the captured-location caveat and diagnosis-before-repair guidance without reconstructing the lost raw line or inferring native work as the cause.
It proves the facts and wording served, not a model's subsequent judgment, and uses no account.

## Before a change merges

The freeze journey (`tests/e2e/main-thread-freeze.spec.ts`, INF-2061's plan, built as INF-2068) runs the actual app with the recorder on, on a record the captain's size: 160,094 task events, 3,400 tasks and 33 open messages in 13 chains, each a reading of the captain's own record (`tests/e2e/captainSizedRecord.ts`).
INF-3896's reading adds what a record with none of it never made slow: the closed tasks' goals, 6,449 answered cards with the offers that carry their words, 3,872 links, a board of 1,701 rows holding a week of closed work with its change stories, live validation and CI repair records, nine open cards naming earlier work, and a heaviest task record of 248 offers.
Only counts and sizes come from the captain's record; every word is made in the seed.
It drives the work that repeats: first mate turns, which read the open messages before and after each, the task board, typing, and five minute passes with the answer-delivery sweep.
It also starts a crewmate and waits for its first report, which comes after its first turn opened: every start-path stall the captain's record held ran in that stretch (INF-2297).
It then starts nine crewmates from one first mate turn while the window takes typing, and finds their nine tasks with one board read per try, so the journey's own reads stay out of the stalls it grades.
It fails, naming the call path, on any recorded stall of 250 ms or more of the main thread's own processor time (`cpuMs`).
It grades processor time, never wall time, so a busy test computer that stretches a stall does not fail it.
Every run prints and annotates its busiest stall, so a change that brings the app nearer the line shows before it crosses it.
The journey chooser selects it for every change that edits the recorder or the main process's own start and clock, and for other main-process changes only through its ordinary rules (`docs/testing.md`, "Journeys on the pull request", rule 11; INF-2486).
A pull request no longer starts journeys, so a crewmate whose change it selects runs it on request before the merge card (`docs/testing.md`, "Journeys on request"), and it runs on Linux in every alpha's check, or in the swept batch it reuses.

A wait on another program spends almost no processor time, so the journey records it without failing it.
The wait check (`scripts/main-thread-waits.ts`, in `pnpm check`) covers it instead: it refuses `execSync`, `execFileSync` and `spawnSync` in `src/main`, `src/core` and `src/shared`, except a file listed in `LISTED_WAITS` with its reason.
A listed file that no longer calls one leaves the list.

The journey sees only the work it drives, and only stalls of 50 ms or more, the recorder's threshold.

## Not covered

It watches only the app's main thread, not a window's own drawing thread.
The memory reading reads only the main process, not a window's process, and only where the core runs with its task record; the app running work for another Mac with no window (`docs/helper.md`) takes none.
The packaged build's fuses turn off the inspector's command-line arguments, not an in-process session; the recorder has not yet been run under them.
