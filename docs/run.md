# Infinitary started by a command

How Infinitary runs with no window, started by a command: `<app> run` starts the whole app - its record, first mate, crew and scheduler - and keeps it running until it is stopped (INF-1228's approved plan, piece 1).
It is for a computer or an account where nobody sits at Infinitary's window, such as a second macOS account that runs the crew while the everyday account only controls it.

## Who owns what

The app owns what no starter can do: running with no window, a clean stop, and an exit with its reason.
Whatever runs the command owns everything about how it runs: when it starts (at boot, at login or by hand), as which account, whether it starts again after a crash or an update, its priority and its log.
So the app adds no option per setup: a macOS boot entry, a Linux service, a login item and a terminal all run the same command.
On screen the mode is called "started by a command", beside Settings' "Start at login"; the words server, service, daemon and headless stay off the app's screens (`docs/vocabulary.md`).

## The command

`<app> run`, where `<app>` is `Infinitary.app/Contents/MacOS/Infinitary` on a Mac, `infinitary` from a Linux package, the AppImage file itself, or `electron . run` in a checkout.
Chromium's own switches may stand before `run`, as they may before `work` (`commandWords`, `src/main/workCommand.ts`); `<app> work run` is the work mode's own command, never this one (`docs/helper.md`).
Any word after `run` prints how to use it and exits 2.

The main entry (`src/main/index.ts`) reads the words before anything of the app loads (`runCommand`, `src/main/runCommand.ts`) and starts the app itself (`startApp`, `src/main/app.ts`) with no window:

- **The same app.**
  It opens the same data folder the app with its window opens in that account, holds the same single-instance lock, and starts the same core, connection and scheduler, so a device paired with that account's Infinitary reaches it as it reaches the window.
- **No window.**
  It opens no window, menu or icon in the top bar, and on a Mac its activation policy is `prohibited`, so macOS lists it as background-only with no Dock icon.
  The only windows it draws are hidden pages: a task's browser and the checks of a card's demo recording or a preview's font.
  The last of them closing is no reason to quit.
- **A display of its own on Linux.**
  Before Chromium opens a display, it starts Xvfb with a key of its own in the data folder, as the work mode does (`startOwnDisplay`, `src/main/ownDisplay.ts`; `docs/helper.md`, "No screen needed"), so its hidden pages draw with nobody logged in.
  With no Xvfb and no display, it says "Infinitary needs Xvfb to run on a computer with no screen." and "Install Xvfb with your system's software, then run this again." and exits 1.
- **Nobody to ask.**
  Voice is not prepared, and an installed Linux app's checks at start (`docs/linux-packages.md`, "What the app checks at start") are said instead of asked: with no git it exits 1, and with Chromium's sandbox off it says so and runs, since its starter chose to start it that way.

Once its core runs, it says "Infinitary is running here with no window, started by a command." on its output; the notes the app's parts leave go to the same output, each starting with `[`.
While it holds the folder it keeps `run.json` there, with its process number, and takes it away as it ends.

## Stopping and its reasons

Ctrl-C, SIGTERM or SIGHUP stops it the way quitting the app does: the core stops its crew, scheduler and connection (`deferCoreDisposal`, `src/main/lifecycle.ts`), it says "Infinitary stopped.", and it exits 0.
It listens for those signals itself from its start, so a module that listens later (Pi's sign-in store, through signal-exit) never ends the process before the core stops, as in the work mode (`src/main/work.ts`).

When it cannot start, it says why on its error output and exits 1, where the app with its window would open a page of its own (`RUN_WORDS`, `src/main/runCommand.ts`):

| Why | What it says |
| --- | --- |
| The app is already open in this account, or another command runs it | "Infinitary is already open here, as this user." and "Quit it, then run this again." |
| The one-time move from Firstmate 3000 is due (`docs/saved-data-compatibility.md`, "The one-time move") | "Infinitary has work from Firstmate 3000 to bring over first." and "Open Infinitary with its window once to bring it over, then run this again." |
| The folder moved, a move holds it, or newer saved work is in it | the refusal page's title and reason, as two lines |
| This account's Infinitary controls a first mate on another computer (`docs/view.md`) | "Infinitary here controls your first mate on another computer, so there is nothing for a command to run here." and "Leave it from Infinitary's window here first, then run this again." |
| Anything else stopped its start | "Infinitary could not start: " and the reason |

## After an update

Every account on a computer runs the one installed app, so updating it in one account replaces the program a command runs in another.
Once a minute the run reads which file the installed program is - its device, inode and time, so a replaced file reads as another whatever its version says - and once it is another, it says "Infinitary here was updated, so this run ends." and "Start it again to run the new version.", stops as it does on a signal, and exits 75 (`EX_TEMPFAIL`), so a starter that starts it again only after a failure starts the new version too (`followInstalledProgram`, `src/main/runCommand.ts`).
The program is the app's executable, or the AppImage file its runtime names (`APPIMAGE`).
A program that cannot be read, as while an update moves the app into place, is read again a minute later.
A development run may stand in the program with `INFINITARY_RUN_PROGRAM` and how often it is read with `INFINITARY_RUN_PROGRAM_EVERY_MS`; an installed app reads neither.

## The window opened beside it

Opening Infinitary's window in the same account while the command runs shows the app's saved-work page, titled "A command started Infinitary here", which says it already runs on this computer as this user with no window, and how to control it or open the window instead; closing the page quits (captain's pick on INF-1228's question 6: "It says a command started Infinitary here, and quits").
The window asks before it asks for the single-instance lock, since a process the lock refused never becomes ready to show a page: `run.json` names a live process that holds Chromium's lock, which on a Mac and on Linux is a link naming its holder (`SingletonLock`, `<host>-<pid>`) (`runningByCommand`).
A note a crashed run left names a process that is gone or holds no lock, so the window opens as usual.

## Not yet

The rest of INF-1228's plan follows in order, each on its own: `infinitary status --json` with what the place lacks (piece 2), `infinitary link` for a computer or a phone (piece 3), a `--settings` file for the search path and the rest (piece 4), control of everything the window does from another computer, a task's browser included (piece 6), and `infinitary start-at-boot` with the one administrator line on both systems (piece 7).
Claude signs in only where someone is logged in: a Mac nobody is logged in to keeps Claude's login locked in its Keychain, and the crew there uses other subscriptions (captain's pick on question 3).
Moving an existing record to another account is planned separately (question 7).

## Tests

`tests/e2e/run-command.spec.ts` starts the built app as `<app> run` in the hermetic environment `launchApp` uses (`hermeticEnv`, `tests/e2e/launch.ts`), with no display on Linux: it runs and stops cleanly, a window opened beside it shows its page, a second run refuses, a replaced program ends it with 75, and a word after `run` exits 2.
`src/main/runCommand.test.ts` holds the words after `run`, the window's reading of `run.json` and the lock, and the program's identity.
