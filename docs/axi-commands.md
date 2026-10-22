# Task AXI commands

A crewmate reaches some of its task's tools as commands in its own shell rather than as tools in its model's tool list: its task's browser, as `infinitary-browser-axi`, and the integrations, as `infinitary-integrations-axi` (`docs/integrations.md`) (the captain's approved design on FI3-1429, after his AXI principles and chrome-devtools-axi).
A command costs a crewmate nothing until it runs one, so the tools it replaces leave every crewmate's standing context.
Every command answers in its task alone, through the app, and every rule its tool keeps stays with that tool's owner: the browser's with `TaskBrowsers` (`docs/task-browser.md`).

## Who has it

A crewmate gets a command where the tool it replaces would bind: `infinitary-browser-axi` where its task has a browser, which is a task on this Mac when the host has a browser engine and a command process (`HostCapabilities.axiProcess`), or a task on a computer that runs work that keeps task browsers (`docs/task-browser.md`, "On another computer").
That computer runs its own channel and command process, the same way, for the tasks it holds: its keys live in its work folder's `task-channel/` (`docs/helper.md`), and its commands reach only the browsers there.
The crewmate's instructions carry one line for it, `CREWMATE_BROWSER_LINE` (`src/core/pi/piResources.ts`), the captain's approved words: "This task has its own browser: run `infinitary-browser-axi` to see or use a web page.
Never press the last step of a purchase or booking; ask the captain on a card."
Its `emit_card` keeps `browser_button` and `browser_handoff`, which carry the sign-in and payment rules (`docs/task-browser.md`, "Asking for help").
Its record leaves the command's calls out, as it leaves out the app's own tools, so what a crewmate types into a page never reaches its lines (`runsTaskCommand`, `src/core/axi/names.ts`; `docs/task-record.md`, "A crewmate's actions").

## The launcher

`resources/axi-bin/infinitary-axi` is the one launcher, a POSIX shell script, and every `infinitary-<tool>-axi` in that folder is a link to it; the name it ran as says which command it is.
The packaged app ships the folder outside its archive (`electron-builder.yml`), and an unpackaged run uses the checkout's.
The packaged app's run-as-node fuse is off, so a shell has no Node to run: the launcher uses only shell builtins and the system's curl (`/usr/bin/curl`, read with `-q` so no `~/.curlrc` adds options, and with no proxy).
A bare `-v` answers at once from `INFINITARY_AXI_VERSION`, without the app.
Anything else goes to the app as one request, each argument its own form field in order, with the command's name, the path it ran from, the shell's working folder, the shell's limit, when the shell started and the shell's id; the app's answer is the command's exit code on its first line and what it prints after it.
A shell with no channel, or a channel that does not answer, prints an error with code `NO_CHANNEL` and exits 1.

## The channel

`AxiChannel` (`src/core/axi/channel.ts`) is how a command reaches its task.
The app listens on a port of this Mac's loopback (`127.0.0.1`) for the run.
A task granted a tool gets its own key, a 256-bit secret written to a file only its owner can read (0600), as the one header line curl sends, in `userData/task-channel/` (`AppPaths.taskChannelDir`, 0700).
The channel empties that folder when it opens and when it closes, so a run that was killed leaves no key that outlives the next start, and nothing is left in the system's temporary folder.
The task's shell is told three things (`TaskShell` on the session spec, laid over the host's environment by `withTaskShell`): the address (`INFINITARY_AXI_ADDRESS`), the key's file (`INFINITARY_AXI_KEY`), never the key itself, and the version; and the launcher's folder goes first on its search path.
Pi's own shell (`jobs/jobManager.ts`) and the Claude client, and so every command the client runs, carry it.
A request names its task by its key alone: the app looks the key up by its digest, and a command reaches only the tools of the task whose key it holds; nothing in its arguments names a task.
Anything on this Mac can reach a loopback port, a web page among them, so a request that names another host (a name rebound to this Mac) or carries an origin is refused before its key is read; the launcher sends neither.
A task granted again keeps its key, so a shell already given it still answers, and the task's close revokes it and deletes its file.
The app's quit stops every running command and removes the keys.

## The command process

axi-sdk-js writes `process.exitCode` and reads `process.argv`, so each command runs in a process of its own, never the app's: the host starts one per request (`src/core/axi/axiProcess.ts`, a utility process in the app through `HostCapabilities.axiProcess`, a plain `fork` in tests).
It runs `runTaskAxiCli` (`src/core/axi/cli.ts`) over the command's table with what the shell passed, its home view naming the path the shell ran it from, and sends back what the command printed and its exit code.
The table reaches the task's tool only through one call per operation, which the app answers against the tool it granted that task: for the browser, `CrewmateBrowser`'s `navigate`, `inspect`, `act`, `capture`, `close` and `pages`, and never a picture's bytes.
A command process that has not answered in a minute is stopped.
Its output goes to the app alone, never to the app's log.

## A shell's limit

Pi's shell answers within 3 seconds and turns anything longer into a background job (`SYNC_CAP_MS`); it tells every command it runs that limit in `INFINITARY_SHELL_CAP_MS`, when the shell started in `INFINITARY_SHELL_STARTED_MS` and the shell's own id in `INFINITARY_SHELL_ID`, and the launcher passes all three on.
The app keeps a command within it, counting from when the shell started while that shell can still answer, not from when the request arrives, so a slow launcher still answers before the shell gives up: an operation still running 750 milliseconds before the limit goes on in the browser, and the command prints `running: <command>` with how to read its answer.
A request that arrives once that limit has already run out counts from when it arrives, as before, and a finished answer kept for the next command is given even then.
A computer that runs work uses this same channel and this same shell, so its commands keep the same limit.
That answer is kept for the task's next command: if it has finished by then, that command prints it under `earlier:` and does not run, saying so; if not, it refuses with `BUSY` and does not run either.
The bare command is the way to look again, so an action is never sent twice.
A shell with no limit, such as the Claude client's, waits for every answer.
Every answer comes back through the shell that ran the command, and on a loaded Mac that way back, or the app's own process, can be held up past the limit, which no margin covers.
So a request tells the shell whose id it carries that its command reached the app (`JobManager.answering`), and that shell waits for the answer to come back instead of turning it into a background job.
It waits at most one limit more, so a shell that goes on with other work after the command still becomes a job.
A shell whose command reaches the app only after its limit is already a background job by then.

## The runtime

`runTaskAxiCli` (`src/core/axi/cli.ts`) is the shared runtime, built on `axi-sdk-js` 0.1.13, and runs only in the command process.
Each tool supplies its name, purpose, version, home callback and command table, and each command its usage, description, accepted flags and callback.
A flag is either a switch or consumes a value; unknown, repeated and missing-value flags refuse before connecting.
`--` ends flag parsing so subsequent text is content, including literal `--help`.
Global `--help`, command `--help` and `-v` answer without connecting to a task.
Unknown commands and invalid arguments answer on stdout with exit 2 (`VALIDATION_ERROR`); a refusal and a connection or operational error use exit 1.
No command table may register an SDK reserved command, and the runtime shadows every one with a refusal, including `update`, so no updater runs or appears in help.
It never calls a hook installer and never writes provider settings.

## The browser command

`infinitary-browser-axi` (`src/core/axi/browserCommands.ts`) turns arguments into the task browser's own operations and prints their answers; every decision stays `TaskBrowsers`'s.
A ref is written as the outline shows it, with or without `@`: `@g1:e5`, `g1:e5` or `[g1:e5]`.

| Command | What it does |
| --- | --- |
| `infinitary-browser-axi` | Home: the page now, with how to use it, or that no browser is open and how to open one; reads a kept answer. |
| `open <url>` | Open a public website over https or a page this Mac serves. |
| `back`, `forward`, `reload` | Move the page; a form's answer is never reloaded. |
| `snapshot [@ref] [--from <line>] [--find <words>] [--full]` | Read the page as an outline window, from a line or around words; `--full` shows every line; a ref reads a cut passage in full. |
| `wait <text>` | Wait up to ten seconds for words, then read the part that holds them. |
| `click @ref`, `hover @ref`, `drag @from @to` | Pointer input on a control. |
| `fill @ref <text>` | Put text in a field, replacing what it holds, or choose a list's option of that label; never sends a form. |
| `fillform @ref=<text>...` | Fill up to 50 text fields in order without sending. |
| `press <key> [@ref]` | Press a key on a control or on what has focus. |
| `scroll <up\|down\|top\|bottom> [@ref]` | Scroll the page, or bring an element into view. |
| `screenshot [name] [--uid @ref] [--full-page] [--reason <why>]` | Photograph into the evidence folder; the crewmate opens the file with its read tool. |
| `pages`, `selectpage <n>`, `closepage <n>` | The browser's pages, which is current, and closing a second one. |
| `console`, `network` | The page's bounded diagnostic lists. |
| `stop` | Stop the browser, or withdraw a request still waiting for the captain. |

It offers nothing that runs script on a page (`eval`, `run`), uploads a file, answers a dialog, emulates a device, profiles (`lighthouse`, `perf`, `heap`), updates itself or installs a hook.
It shows content first, following the captain's ten AXI principles:

1. Its answers are TOON.
2. Pages, console messages and network requests list as rows of three or four fields.
3. An outline shows a bounded window with its size and where it sits, `--full` shows it all, and a ref reads a cut passage.
4. A page answer opens with its aggregates: the page's title, address, ref book, how many controls carry a ref, its place among two pages and the errors it logged since the last answer, then what the command did (`BrowserPageFacts`).
5. An empty list says so (`0 messages`, `0 requests`), and so does a browser that is not open.
6. A refusal prints the browser's own words as an error on stdout, which say what to do instead, with exit 1 (`REFUSED`, `BUSY`); a malformed ask exits 2 before reaching the browser.
7. The crewmate's one prompt line is the session hook, and a wake about its browser names the command for its fresh look, carrying none of the page.
8. The bare command shows the page, not help.
9. Each answer ends with `help`: how to read on, from facts the window knows, and the browser's rules where they apply - the sign-in rule where a page opens, the payment rule on the home view and in the help of `click` and `press`, and the signed-in rule on every answer from a browser that may show the captain's account (`BROWSER_RULES`).
10. Every command has its own `--help`, `-v` answers fast, and the home view names the command's path and purpose.

The words a crewmate reads in an answer name the commands, through `browserCommand` (`src/core/browser/commandWords.ts`).
A refusal is typed by `TaskBrowsers`, never read off its words (`BrowserAnswer.refused`).

## The integrations command

`infinitary-integrations-axi` (`src/core/axi/integrationCommands.ts`) reaches the integrations the captain connected (`docs/integrations.md`): discover, then call (the captain's q1 on INF-775).
The bare command lists them with who each is signed in as and its actions, `show <name>` lists one's actions with what each does, its rule and its input's JSON Schema, and `call <name> <action> '<json input>'` runs one.
The input is one JSON object, checked before it is sent, and a malformed one exits 2.
Every decision stays `IntegrationsService`'s: a paused integration, an action turned off and a change that asks the captain each print the service's words as an error with exit 1 (`REFUSED`).
A task on this Mac is granted it whenever the host has a command process; a computer that runs work does not grant it yet.
Its kept answers follow the shell's limit as the browser's do.

## Tests

`cli.test.ts` holds the runtime: content-first home, flags, help and version without a task, refused updates and literal content.
`browserCommands.test.ts` holds the table: each command's operation and input, every malformed ask refused with exit 2 before reaching the browser, only the approved commands, the page's aggregates before its outline, the rules where they apply, compact rows and empty lists, a picture's path without its bytes, refusals with exit 1, a kept answer's three words and the home view.
`channel.test.ts` runs the real launcher with `sh` and the system's curl against the real channel and the bundled command process: only the browser the key names is reached, the key file is 0600 in a 0700 folder and never in the environment, a forged, missing or revoked key reaches nothing, a request naming another host or carrying an origin is refused even with the task's key, the keys' folder is emptied when a channel opens and closes, refusals and malformed asks keep their exit codes, help and `-v` need no task, and a command past its shell's limit, counted from when the shell started while it can still answer, answers `running`, the next command `BUSY`, and the next look the kept answer, the action sent once.
A click that finishes after that start-counted deadline and before the receipt-counted one answers `running`, a finished kept answer is given even when the later command's deadline has passed, a request that arrives after the limit has run out counts from receipt, and a start after receipt does not extend the limit.
A command whose app is held up from before the channel's deadline until after Pi's limit still answers `running` through Pi's own shell, not as a background job.
`jobManager.test.ts` holds Pi's shell telling a command its limit, when that shell started, on the wall clock the channel reads, and carrying the task's shell, and a shell whose task command reached the app waiting past the limit for its answer, at most one limit more, `hostEnv.test.ts` that a child does not inherit `INFINITARY_SHELL_CAP_MS`, `INFINITARY_SHELL_STARTED_MS`, `INFINITARY_SHELL_ID` or the older `FM3000_SHELL_CAP_MS` from the process that started the app, and that extra still sets the Infinitary names, `claudeSession.test.ts` the Claude client's, `crewSupervisor.test.ts` that a task on this Mac is granted its browser's command and prompt line where its browser binds and none without one, and `crewActions.test.ts` that the record leaves the command out.
`tests/e2e/task-browser.spec.ts` and `tests/e2e/task-browser-booking.spec.ts` drive every browser journey through the command on Pi crewmates, and the booking journeys on Claude crewmates too, in the hermetic app; the scripted crewmate reads its answers through one helper (`toolAnswers` and `lookingAgain` in `tests/e2e/mockProvider.ts`), which looks again when the channel answered `running` or `BUSY`, and the take journey holds that its wait answered with `running`, its answer came with the next look, and it was run once.
When the shell itself becomes a background job, the helper ends the turn until that job's exit wake supplies its output, ignoring the receipt's partial output and unrelated or repeated job exits rather than running the browser action again.
`tests/mockProvider.test.ts` exercises those answers through the provider's request interface using the shell tool's receipt and the host's rendered exit wake, including a job whose output itself asks for the next look.
`channel.test.ts` also runs `infinitary-integrations-axi`: list, show and call reach only the integrations the task was granted, a refusal exits 1, a malformed input exits 2 before reaching them, and a task without the command is answered `NO_TOOL`.
`tests/release-contract.test.ts` holds the launcher and its links shipped outside the archive.
