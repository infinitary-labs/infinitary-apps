# Infinitary started by a command

How Infinitary runs with no window, started by a command: `<app> run` starts the whole app - its record, first mate, crew and scheduler - and keeps it running until it is stopped (INF-1228's approved plan, piece 1).
It is for a computer or an account where nobody sits at Infinitary's window, such as a second macOS account that runs the crew while the everyday account only controls it.

## Who owns what

The app owns what no starter can do: running with no window, a clean stop, and an exit with its reason.
Whatever runs the command owns everything about how it runs: when it starts (at boot, at login or by hand), as which account, whether it starts again after a crash or an update, its priority, its log and its settings file.
So the app adds no option per setup: a macOS boot entry, a Linux service, a login item and a terminal all run the same command.
On screen the mode is called "started by a command", beside Settings' "Start at login"; the words server, service, daemon and headless stay off the app's screens (`docs/vocabulary.md`).

## The command

`<app> run`, where `<app>` is `Infinitary.app/Contents/MacOS/Infinitary` on a Mac, `infinitary` from a Linux package, the AppImage file itself, or `electron . run` in a checkout.
Chromium's own switches may stand before `run`, as they may before `work` (`commandWords`, `src/main/workCommand.ts`); `<app> work run` is the work mode's own command, never this one (`docs/helper.md`).
`<app> run --settings <file>` names a settings file ("A settings file" below); any other word after `run` prints how to use it and exits 2.

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
While it holds the folder it keeps `run.json` there, with its process number, start time and an environment reading, and takes it away as it ends.
Before removing the marker it writes `run-last-stop.json` with the reason, lines, exit code and stop time; both files are private to the account and replaced atomically.
A refused second start owns neither file, so it cannot replace the running command's reading.

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

## A settings file

`<app> run --settings <file>` names a file of settings, so whatever starts the command also decides where programs are found (INF-1228's approved plan, piece 4: "With it, the app finds programs where the file says and asks no login shell").
Without one the core asks the person's login shell for its search path as it starts (`captureLoginPath`, `docs/architecture.md` §17), which needs a shell whose startup files answer, and nobody may be logged in to the account a boot entry starts.
The file is one JSON object, read once as the run starts, relative to where the command runs when it is not a full path:

```json
{ "path": ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] }
```

- **`path`** lists the folders where programs are, in the order they are searched, each a full path.
  Every child the core starts - a crewmate's shell, an install, git and Claude's client - searches the app's own git first, then these folders, then whatever the process path holds that they do not, so the system folders a starter sets stay behind them (`configureSettingsPath`, `src/core/hostEnv.ts`).
  Nothing is guessed: the installer folders the core adds to a shell's answer (`installerDirs`) count only when the file or the process path names them.
- **No login shell is asked**: neither the search path's question as the core starts nor the last rung of Claude's locator (`primeClaudeExecutable`).
  The run's output notes `[host-env] children search the settings path, <n> entries`.

`path` is the only setting; any other name refuses rather than being ignored, so a misspelled `paths` never starts a run that searches none of the folders it meant.
A file it cannot use ends the run before its core starts: it says "Infinitary could not use the settings file <file>: <reason>." and "Fix the file, then run this again." on its error output, keeps both lines as its last stop for `status`, and exits 78 (`EX_CONFIG`), so a starter can tell a file to fix from another failed start (`RUN_SETTINGS_EXIT`, `src/main/runCommand.ts`).
The reasons are a missing or unreadable file, a folder, text that is not JSON, anything but one object, a setting it does not know, no `path`, a `path` that is not a list of folders, and a folder that is not a full path or holds the separator (`readRunSettings`, `src/main/runSettings.ts`).
`--settings` with no file prints the usage and exits 2.
The file is the starter's, as the account and the start are: the app never writes it, and it holds no sign-in, since Claude signs in only where someone is logged in ("Not yet").

## Reading status

`<app> status` prints the command's status in words; `<app> status --json` prints one JSON object and exits without opening a window or starting the core (INF-1228's approved plan, piece 2).
It uses the same data-folder selection as `run`, including the installed release/development distinction and isolated development overrides, but creates no folder, takes no lock, performs no move and reads no database or credential.
It works on Linux without a display or Xvfb.
An ordinary result, running or stopped, exits 0; an unreadable record or unconfirmed lock holder exits 1, and any arguments other than the optional `--json` exit 2.

The JSON's `schemaVersion` is 1, `running` is true, false or null (unknown), `run` names the live command or is null, `lastStop` holds the last recorded stop or is null, `environment` holds the last command's dated reading or is null, and `problems` lists unreadable evidence.
This is the status of `run`, not a health check of the first mate, its subscriptions or its crew.
A live lock without a command marker answers unknown rather than guessing that the window is a command.
A command's marker left after its process disappeared or lost the lock reports an unrecorded stop, with null stop time and exit code; it never claims the preceding clean stop explains this one.
The marker written by piece 1 remains readable, with no environment reading.
A fresh account has no last stop, and failures before a command owns the folder leave no new stop record.
Handled failures after it owns the folder retain their reason, including incompatible saved data and a missing core; updates retain exit 75.
An orderly quit retains exit 0; a signal delivered to Node also retains its name, while Electron's native quit path records a clean quit without inventing which signal caused it.

The environment is explicitly a snapshot **when the command started**, not a live probe of the running session:

- `display`: `own` when Linux starts Xvfb, `session` when the session names a display, `none` when Linux has neither, or `unknown` on macOS.
  A named display alone proves no drawing; INF-1416's check on a disposable Mac saw the hidden pages draw at boot with nobody logged in.
- `keychain`: on a Mac, the `locked`, `unlocked`, `absent` or `unknown` state of the account's own login Keychain, opened by its path under the home its user record names (`~/Library/Keychains/login.keychain-db`, `accountKeychainPath`), read silently through Security.framework's metadata-only `SecKeychainGetStatus` in a disposable utility process, never an item or a password.
  It never asks for the default Keychain: started at boot by a system job, that is the Mac's own unlocked System Keychain while the account's stays locked (INF-1416's check on a disposable Mac).
  An unlocked Keychain promises no sign-in, and a lock changed after start does not change this dated reading.
  Isolated launches never touch the person's Keychain and record unknown; other systems record `not-applicable`, which makes no claim about Linux's separate keyring.
- `voice`: `unavailable`, since a run does not prepare voice.
- `notifications`: `unknown`, since delivery in that session has not been checked.

The status command itself never queries the Keychain or creates a display, so an SSH reader does not substitute its own session's capabilities for the command's.
`src/main/runStatus.ts` owns the command's output; `src/main/runCommand.ts` remains the one writer of its marker and stop record.

## A link by command

`<app> link` prints a one-use link another computer's Infinitary joins with at its first launch, and `<app> link --phone` prints a code the phone app scans, with the same link under it (INF-1228's approved plan, piece 3).
It asks the Infinitary running in this account, started by a command or with its window, so the link joins that app's first mate; it starts nothing, opens no window, takes no lock and works on Linux without a display.
It finds the data folder as `status` does, and asks at that folder's phone door with the door's key (`docs/devices.md`, "A phone that joins by its address"), so `DevicePairing` makes the link exactly as Settings -> Devices does: one use, ten minutes, and for a phone the addresses a phone reaches first.
The words above the link are the ones Settings -> Devices shows (`LINK_SAY`, `src/shared/devices.ts`), and the last line says how long it works.
The phone's code is drawn from the same modules as the one in Settings -> Devices (`phoneCodeModules`, `src/shared/phoneCode.ts`), in half blocks, black on white whatever the terminal's own colors, with the margin a camera needs.
`--json` prints one object instead, `schemaVersion` 1, `for` (`computer` or `phone`), `link` and `expiresAt`; it draws no code.
A link prints with exit 0; any other word exits 2 with the usage.
With no link it exits 1 and says why on its error output:

| What it read | What it says |
| --- | --- |
| No door answers and no app holds the data folder | "Infinitary is not running here, as this user." and "Start it with infinitary run, or open it, then run this again." |
| An app holds the folder but no door answers, as an older app | "Infinitary is open here, but it did not answer this command." and "Quit it and start it again, then run this again." |
| This account's Infinitary controls a first mate on another computer (`docs/view.md`) | "Infinitary here controls your first mate on another computer." and "Make the link on that computer instead." |
| Pairing made no link, as when the saved device list is unreadable | "Infinitary here could not make a link: " and pairing's reason |

The link reaches this command's output alone: the door writes it to no log, and the command is this account's, as the door's key is.
`src/main/linkCommand.ts` owns the command and its words.

## Control from another computer

Another computer's Infinitary that joins a first mate a command started controls it as it controls any first mate (`docs/view.md`, "What the window asks"), and the same rule answers a view of a first mate with its window.
What is left to a command's own first mate is its window's absence:

- **Pages it would open.**
  Every page such a first mate would open in a browser, a sign-in's consent page included, goes to each computer that controls it as the push `inf:app:open-page` (`startCore`'s `startedByCommand`, `src/core/index.ts`), since nobody sits at its computer; `docs/view.md`, "Pages it would open", says what the view does with it.
- **General.**
  General leaves out that computer's Start at login, Dock, dictation and panels, which are its own and have nobody there, as on any view.
- **First launch.**
  Its first launch shows the subscription chips under the line `gateRunLine` makes: "Connect one for your first mate on Mac mini.
  It signs in from here."

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

## Starting at boot

`<app> start-at-boot` sets the usual start at boot up for this account: it writes what the account may and prints the one line an administrator runs (INF-1228's approved plan, piece 7, the captain's answer boot=both; piece 5 of INF-1352's plan).
On Linux it writes this user's own systemd service, `<bundle id>.run.service` (`.dev.run` for a development run, `runLabelOf`, `src/shared/codeNames.ts`) in `~/.config/systemd/user` (or `$XDG_CONFIG_HOME`), and the link in `default.target.wants` that `systemctl --user enable` makes, so the user's systemd starts `<app> run` at their login (`bootUnit`, `src/core/helper/background.ts`).
To start it at boot with nobody logged in, the user must linger: it asks `loginctl enable-linger --no-ask-password <user>`, which systemd allows some accounts, and otherwise prints "To start it whenever this computer starts, before anyone logs in, an administrator runs this once:" and `sudo loginctl enable-linger <user>`, the line the Linux join prints (`afterLogout`, `docs/devices.md`).
The service starts the run again ten seconds after a failure, so an update's exit 75 runs the new version, but not after a clean stop (0) or a settings file to fix (78, `RestartPreventExitStatus`); what the run says goes to the user's journal (`journalctl --user -u <label>.service`), which the command names.
It starts the service now, unless another Infinitary holds the data folder (the window, or a run started by hand): then it says the service starts the next time instead, so it never fails beside it; a run of the service itself restarts with the new file.
`--settings <file>` names a settings file ("A settings file" above) for the service's run, by its full path; a file it cannot use is said now with the run's own words and exit 78, and nothing is written.
`--off` takes the service and its link away and stops it; when the user lingers it also prints how an administrator turns that off (`lingerStays`), since the app never turns linger off itself.
With no systemd for this user it says so and exits 1; any other word prints the usage and exits 2.
`src/main/startAtBoot.ts` owns the command and its words.

On a Mac, which has no linger, a job starts before anyone logs in only from the system's own `/Library/LaunchDaemons`, which an administrator writes (INF-1362, built after INF-1416's check on a disposable Mac showed the run starts, draws its hidden pages and stops cleanly there with nobody logged in).
So it writes the account's own entry, `~/Library/LaunchDaemons/<label>.plist` (a folder launchd never reads itself), and prints "To turn it on, an administrator runs this once:" and the line that copies it into place, owned by root: `sudo install -o root -g wheel -m 644 <entry> /Library/LaunchDaemons/<label>.plist` (`bootPlist`, `src/core/helper/background.ts`).
At the next boot launchd starts `<app> run` as this user (`UserName`), with `HOME` set to their home so the run opens their own data folder, and at the priority of an app the person started, as the home's own work runs (INF-247).
It starts the run again after a failure, so an update's exit 75 runs the new version, but not after a clean stop (0); launchd cannot spare one exit code, so a settings file to fix (78) is started again every ten seconds, launchd's own wait, and is said in the log each time.
What the run says goes to `~/Library/Logs/<label>.log`, which launchd opens as this user and the command names.
It starts nothing now: the copy an administrator puts in place starts at the next boot, and an entry already in place keeps the copy launchd read at boot until the next one.
`--settings <file>` and its refusal are as on Linux.
`--off` takes the account's entry away; once an administrator has put one in place, it prints the line that stops the run and takes it away, `sudo launchctl bootout system/<label> 2>/dev/null; sudo rm -f /Library/LaunchDaemons/<label>.plist`.
With FileVault on, a Mac starts nothing until someone unlocks its disk at boot.

`<app> help` lists the commands, and `<app> help run` prints the run's usage and the ways to start it the app does not set up itself, each with this app's own path: by hand in a terminal, `start-at-boot`, and a Mac login agent's file for `~/Library/LaunchAgents` (INF-1228's plan: "infinitary help run prints examples for other setups").

## Not yet

The rest of INF-1228's plan follows in order, each on its own: from another computer, its computers and phones, through the same pairing (piece 6), and a task's browser shown and taken over there (piece 6, the captain's answer browser=build).
Google's sign-in from another computer waits too: its page sends the browser back to the first mate's own loopback address.
Claude signs in only where someone is logged in: a Mac nobody is logged in to keeps Claude's login locked in its Keychain, and the crew there uses other subscriptions (captain's pick on question 3).
Moving an existing record to another account is planned separately (question 7).

## Tests

`tests/e2e/run-command.spec.ts` starts the built app as `<app> run` in the hermetic environment `launchApp` uses (`hermeticEnv`, `tests/e2e/launch.ts`), with no display on Linux: it runs and stops cleanly, a window opened beside it shows its page, a second run refuses, a replaced program ends it with 75, and a word after `run` exits 2.
With a settings file and the system folders as its path, a run never asks a stand-in login shell that the same run without one asks, and notes the file's folders; a misspelled setting ends it with 78 and keeps why as its last stop.
`src/main/runCommand.test.ts` holds the words after `run`, the window's reading of `run.json` and the lock, and the program's identity.
`src/main/runSettings.test.ts` holds the settings file's reading and each reason it refuses one; `src/core/hostEnv.test.ts` holds the search path a child gets from it with no shell asked, and `src/core/claude/claudeCli.test.ts` the locator's login-shell rung it skips.
`tests/e2e/status-command.spec.ts` starts the built commands in the same isolated environment and reads status before, during and after a run, a second start, a signal, an update, a forced end and a saved-data refusal, plus invalid arguments and a corrupt record.
`src/main/runStatus.test.ts` owns the pure output contract, private retained stop, legacy marker compatibility, unknown readings and the platform capability mapping.
`tests/e2e/link-command.spec.ts` starts the built commands in the same isolated environment: with nothing running `link` says so and makes no data, a word it does not take exits 2, and beside a run a computer's link joins once, a phone's printed code holds its printed link and joins, and `--json` answers a new link; once the run stops it says so again.
`src/main/linkCommand.test.ts` holds the words after `link`, the readings with no answering door, the printed code read back module by module, and the output; `src/core/devices/phoneDoor.test.ts` holds the door's answer and refusals.
`tests/e2e/run-control.spec.ts` starts the built app as `<app> run` with the mock provider and Google's stand-in, joins a second app at its first launch with the link `link --json` prints, and from it opens Intelligence with a card's Open settings button, Usage and Integrations by command, saves a projects folder typed as its path there after a missing one is refused, and signs in to Google, whose page that app's browser opens; once the run stops its own data holds both.
`src/main/startAtBoot.test.ts` holds `start-at-boot` against a stand-in systemd and logind: the service it writes, linger allowed, refused or already on, an Infinitary already open, a settings file, `--off`, no systemd, and `help run`; and on a Mac the entry it writes, read back as launchd reads it, the administrator's line, quoted where a home has a space, a settings file and `--off` before and after an administrator put the entry in place.
`src/main/runStatus.test.ts` holds the account path a run hands to its host and the status it returns without guessing.
`src/main/host/claudeKeychainAccess.integration.test.ts` checks real unlocked, locked and missing disposable stores through the child process; `keychainProcess.integration.test.ts` proves a blocked status call leaves its parent responsive.
`src/core/connection/connection.test.ts`, `src/shared/ipc.test.ts`, `src/core/devices/homeLink.test.ts`, `src/main/shell.test.ts` and `src/core/core.connection.test.ts` hold what such a view may ask and is refused, the welcome's field, a replayed page left unopened, and the page the real core sends instead of opening it; `src/renderer/src/devices/viewWords.test.tsx`, `src/renderer/src/settings/SettingsScreen.test.tsx` and `src/renderer/src/app/commandRefusals.test.ts` hold the sections, words and commands.
