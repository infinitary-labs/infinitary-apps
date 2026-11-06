# macOS's question about other apps' data

macOS protects the folders where other apps keep their private data.
When a process the app started reads one, macOS asks a person "Infinitary would like to access data from other apps."
It names Infinitary because Infinitary started the crewmate, and the crewmate never sees the dialog: its command waits until a person answers.
A crewmate's search of the whole disk or the home folder is what walks into those folders (INF-1217).

## Fewer searches

A crewmate names a folder instead of searching for it:

- A crewmate's `tasks` with `projects` true lists every project's key, name and folder on the computer where the first mate lives (`TaskQueryReach.projectFolder`, `src/core/tasks/taskQuery.ts`).
- A by-key `tasks` read names `computer`, the computer the task's crewmate ran on, and `evidence_folder`, its evidence folder there (`CrewToolHooks.taskQueryReach`), so a file on another computer is a gap to report rather than a search.
- The crewmate's evidence note says to search only folders it can name, never the whole disk or the home folder (`crewmateEvidenceNote`, `src/core/pi/piResources.ts`).
  It sits in the per-task note, outside the crewmate's fixed context (`tests/crewmate-fixed-context.test.ts`).

Nothing blocks a crewmate that searches widely anyway; that search still raises the dialog.

## The dialog's reason

The app ships `NSAppDataUsageDescription` in `electron-builder.yml`, which the local app's config inherits, and `tests/release-contract.test.ts` holds its words.
They say a crewmate's search reached another app's files and that Don't Allow is usually fine.
The dialog shows the same words for every such question, so they cannot name the task; the task's own record does (below).

## The privacy watch

On macOS the app reads macOS's own privacy log while it runs (`AppDataWatch`, `src/core/privacy/appDataWatch.ts`), with `/usr/bin/log stream --style ndjson` and a predicate on tccd's `AUTHREQ_` lines.
A live read needs no password on an administrator account; where it cannot start, the watch ends quietly and records nothing.

1. A request's context line names its service; the watch keeps `kTCCServiceSystemPolicyAppData` requests only.
2. Its attribution line names the process macOS holds responsible and the process that reached the data; the watch keeps a request whose responsible process is the app's own.
3. It finds the task: the process, or the nearest of its parents, works inside a live task's working copy on this computer (`taskOfProcess`, through macOS's `ps` and `lsof`).
4. If the request still has no answer once the task is found, the task's timeline gets a progress line from the host that it waits on macOS, which stands as its Now.
5. When macOS writes the result line, the timeline gets a second line naming the answer, Allow or Don't Allow.

A request macOS answers at once from an earlier choice shows no dialog and records nothing.
One search's several requests make one waiting line and one answered line.
The words are `PRIVACY_WORDS`, owned by the watch.

What it does not cover:

- A task on another computer that runs work: the watch reads this computer's log, for this computer's crewmates.
- The log's format is Apple's and undocumented, so a macOS update can change it; the parser reads only the fields above and passes over any line it cannot read.
- It reads a request that waits on a person by the same three lines, its result written once the person answers.

A development run takes a stand-in for the log reader, `INFINITARY_PRIVACY_LOG`; every journey runs one that prints nothing unless the spec names its own (`tests/helpers/privacyLogStandIn.ts`), so no test reads this Mac's own privacy log.
`tests/e2e/macos-privacy.spec.ts` prints a real request's lines from inside a seeded task's working copy and reads the task's Now.
