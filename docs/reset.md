# Reset Infinitary

Settings → General ends with Reset Infinitary, which takes this computer's Infinitary back to how it was just installed: the next start opens on the welcome screen, asking where the first mate should live.
Purge task data, the row above it, removes tasks alone and keeps projects, sign-ins and settings; each row says what it keeps.

## The row

The row resets the computer whose window shows it, and on a computer that controls another's first mate it resets both ("From a computer that controls the first mate").
Pressing Reset turns the row into its question, as Secrets' Forget does: what it deletes, how many open tasks stop (`inf:app:reset-scope`), and that projects in the person's own folders keep every file and commit, with Purge task data named for clearing tasks only.
Keep everything has focus, so Enter never resets; it changes nothing and gives focus back to Reset.
The danger button, Reset Infinitary, asks the system's own confirmation of the person at this computer, the one Secrets uses: Touch ID or the account password on a Mac, Windows Hello, or the Linux system prompt.
Cancelling it, or a confirmation that fails, changes nothing and gives focus back to Reset; where the system has none to ask, such as an isolated folder, the row's question alone confirms.
Once confirmed, the app quits and starts again.

No agent can start a reset.
`inf:app:reset` is a host channel only the window's page reaches, and the first mate's side, `inf:app:reset-prepare`, and a controlling computer's ask, `inf:home-reset:start`, are program-only channels (`PROGRAM_ONLY_CHANNELS`) that neither the page nor `infinitary-axi` reaches; all three are destructive exceptions in the app actions coverage (`src/shared/actionCoverage.ts`).
The reset command and the screens below ask the system's own confirmation the same way, and the command refuses where there is none to ask.

## From a computer that controls the first mate

A computer that controls another computer's first mate, the home, shows the row once the home lists the contract change `home-reset` (`ThisMac.homeResets`); an older home shows no row, since it cannot be reset from here.
The row and its question name the home: Reset Infinitary on the home and this computer, which deletes everything Infinitary keeps on both, and the counts are the home's open tasks.
The person confirms at this computer with its system's own confirmation, which names both computers.

Then this computer's program asks the home `inf:home-reset:start` over the connection, and only once the home answers does it reset itself:

1. The home serves the ask only to a paired computer that controls it, never a phone, a computer that only runs work or its own window, and answers before it starts.
2. The home resets itself with no question of its own, since its person confirmed at the computer that asked: every step of "Before it quits" runs there, except that it leaves the asking computer on its list, so the two never race over unpairing.
3. This computer then resets itself: it has no first mate of its own to undo, so it clears what it reaches outside its folder, writes the mark and restarts on the welcome screen.

A home that does not answer, or refuses, resets nothing on either computer: the row says the home did not answer and stays on its question.

### A first mate with no window

A home whose first mate a command started (`<app> run`, at boot, by its service or behind a window opened beside it; `docs/run.md`) takes the reset in that run, as a window would, with three differences (`resetsFor`'s `endRun`, `src/main/reset/wiring.ts`):

- On a Mac or Linux its own start-at-boot entry is not turned off through the service manager, whose stop would end the run partway: the run takes the entry's files away and goes on (`bootEntryOff`, `src/main/reset/ownEntries.ts`), and the mark leaves the entry to the next start too.
  On Windows the run removes its task through Task Scheduler, after the mark is written, so a removal that ended the run still leaves the next start to finish the reset.
- A window opened beside it keeps its own profile inside the folder (`window-profile`), so ending the leftover programs leaves that window alone.
- The run starts nothing again: it ends with 0 and says so, and its starters' files are gone, so nothing starts it again; on a chosen or isolated folder only the agent file inside the folder goes, since the entries in the home folder start the person's own folder.
  A window beside it starts again by itself once the run ended and the mark is there (`BesideOptions.resetAsked`), but never while its own reset runs, which writes the mark before the clearer that ends the run (`resetWatch`, `src/main/reset/ownReset.ts`), and that start wipes the folder and opens on the welcome screen; with no window there, the next start of Infinitary on that computer does.

## Where a reset can start

A reset starts in three places, each confirmed by the person at this computer:

- **Settings → General**, the row above.
- **The screens shown when Infinitary cannot open**: the saved-data refusal, when the folder holds data from a newer version (`docs/saved-data-compatibility.md`), Windows' three owner-only refusals (others can read the folder, Windows could not check who can, or making it owner-only did not finish), and the could-not-start screen below.
  The refusals of a folder an older name left behind and of a move in progress offer no reset, since a reset there would delete what the person is still moving.
- **The reset command**, `<app> reset`, below.

The screens and the command reset with no first mate running (`resetWithoutFirstMate`, `src/main/reset/withoutFirstMate.ts`): the program clears what it reaches outside the folder, writes the mark, ends every program still holding a file in the folder and restarts, so the next start wipes the folder as after the row.
What only a running first mate undoes stays as a plain wipe leaves it: paired devices are not told, open tasks' stops do not run, accounts are not signed out with their providers and projects keep the settings Infinitary wrote into them.

A screen's Reset Infinitary turns the screen into the row's question, with Keep everything focused, then asks the system's confirmation; where the system has none to ask, the question alone confirms, as on the row.
A reset that is not confirmed goes back to the screen and says nothing was reset.

### Infinitary could not start

A window start on its own folder counts itself in `<folder>.start-attempts`, beside the folder and never in it (`src/main/reset/startAttempts.ts`), once it holds the folder's lock; the count goes once a window is ready to show or the first mate or the view started.
A start that finds two earlier starts that never got that far shows Infinitary could not start instead of trying again (`showCouldNotStart`, `src/main/reset/couldNotStart.ts`), with Try again, which clears the count and starts the app once more, Reset Infinitary, and Quit, which leaves the count so the next start shows the screen again.
A start with no window, a move and a run beside a command count nothing, a person's own Quit at a startup question (Linux git or sandbox, Windows Git setup) clears the count, and a reset deletes the count with the folder.

### The reset command

`<app> reset` (`src/main/reset/command.ts`) resets this computer's Infinitary from a terminal, for a computer whose window never opens.
It asks the system's own confirmation of the person at this computer and wipes the folder at once, then says Infinitary opens on the welcome screen next time.
It refuses, changing nothing, where the system has no confirmation to ask, as on an isolated or chosen folder, so a shell an agent drives can never pass it; while Infinitary runs on the folder, whose own row resets it; and when the person does not confirm.

## Before it quits

The window's program runs the reset (`runReset`, `src/main/reset/running.ts`) once the system confirmed the person, each step capped so a remote service never holds it up, and none stops the next:

1. The first mate undoes what its own side set up elsewhere (`prepareReset`, `src/core/reset/prepare.ts`): it removes its paired phones and computers while the connection still runs, so a connected one hears it was removed; discards each open task, so its registered stops and keeps run, and waits for them; removes each kept job with its own remove; undoes what it set in projects outside its folder ("Your projects"); signs out its accounts; and removes its integrations, revoking a sign-in where the service offers it.
2. It writes the mark beside the folder, naming every outside kind still to clear, before anything that could end this program.
3. On the person's own folder of a flavor, the program clears what it reaches outside the folder now ("Outside the folder"), and leaves the home this computer runs work for (`leaveWorkHome`, `src/main/reset/workHome.ts`): it stops the work's run, tells that home Leave, as a device's own Leave does, so the home takes this computer off its list instead of keeping it as out of reach, and removes what was set up here for it.
   The work's working copies sit inside the data folder, so the next start deletes them with it, unmerged work included.
   A home out of reach still lists this computer until it is removed there.
4. It writes the mark again, naming only the outside kinds the next start still clears.
5. It stops the first mate - beside a command, whichever run holds the folder, with its starter let go for good (`Shell.stopForReset`).
6. It ends every program of this account still holding a file or working folder in the data folder, such as a server a task started or a terminal the person opened in a task's working copy (`endLeftoverPrograms`, `src/main/reset/leftovers.ts`): each gets 15 seconds to end by itself, then an end request and a kill; never this app or a program it started.
7. It starts the app again; a run with no window ends instead ("A first mate with no window").
   On Windows the new start waits for this program to end, through the same hand-over an update uses (`restartOnWindows`, `src/main/reset/windowsRestart.ts`), so it finds the folder free.

Nothing before the quit deletes the folder, which this start still holds.

### Your projects

A project that lives in the data folder, one the app cloned, goes with the folder.
One that lives outside it - adopted from the person's own folder, even when a link inside the folder names it - keeps every branch, commit and file, and each task's saved work under `refs/infinitary/kept/` and `refs/infinitary/away-copy/` (`undoProjectSettings`, `src/core/reset/projectGit.ts`).
Discarding each open task already released its own remote and deleted its branch, saving its unmerged commits first; the reset itself removes only the push address Infinitary set on origin and the links to working copies inside the data folder.
It never touches another task's remote or branch mark, so another run of the app on the same project, such as a development build, keeps its tasks.

## At the next start

`finishResetAtStart` (`src/main/reset/atStart.ts`) runs from the main entry before anything of the start opens the folder, the compile cache included, and before Electron is ready (`finishReset`, `src/core/reset/finish.ts`).
It takes the reset's own lock, `<folder>.reset-lock`, by the move lock's rules, so a second start meanwhile quits quietly.
Then, by the mark's stage:

1. `asked`: the folder is renamed aside to `<folder>.resetting-<pid>` in one step, and the mark moves to `moved`.
2. `moved`: every folder renamed aside and the older copies are deleted, and the mark moves to `outside`.
3. `outside`: each outside kind the mark lists is cleared.

The mark goes last, so a start cut off at any step carries on at the next; each step can run twice, and a fresh folder is never wiped by an old mark.
The outside kinds are cleared once, at the start that wipes the folder, and a kind that cannot be cleared then is left: a later start may already run the fresh install, whose own Secrets, start entries and preferences a retry would delete.
A folder renamed aside that cannot be deleted keeps the mark at `moved` for up to three starts, which delete the renamed folders and the older copies again, never the fresh folder, then the mark goes anyway.
The older copies are the person's own folder's of a flavor alone: an older name's folder (Firstmate 3000's), a folder a move set aside or was still building, the hand-over's throwaway profile and the move's lock files.
An isolated or chosen folder (`INFINITARY_USER_DATA_DIR`, `--user-data-dir`) is wiped alone, with no older copies and nothing outside it.

### A folder another program holds

Windows refuses to rename a folder another program holds open.
The start tries again every two seconds for a minute, never opening the folder meanwhile, then shows one box on a throwaway profile outside it: Infinitary could not finish its reset, with Try again, which starts the app once more, and Quit (`showResetHeld`, `src/main/reset/held.ts`).
A run with no window says so on its terminal and ends.

## Outside the folder

Only a run on the person's own folder of a flavor reaches any of these, each by this flavor's own names (`src/main/reset/outside.ts`):

- **The password store**: every slot of the flavor's Secrets, its standby lock and, on a Mac, its approval key, removed through the same native custody that keeps them (`SecretCustody.remove`).
  Left there, Secrets beside the fresh folder would open as tampered ("Starting over", `docs/secrets.md`).
  A locked or unreachable store is left for the next start.
- **Start entries**: the command's starter, let go for good; the start-at-boot entry, as `start-at-boot --off` removes it; the start-at-login item; and the background agent of work this computer runs for another home.
  The next start retries only the start-at-boot entry, since the rest needs the old folder's records.
- **Phone keys**: the key lines phones placed in this account's `authorized_keys` to reach this computer, each ending in the phone's own comment; every other line stays.
- **The command's link and skill**: the `infinitary-axi` link Settings made, only while it still leads to this copy's own command, and the agent skill `setup skill` wrote, only while it still reads as the app wrote it.
- **The app's own files**, cleared at the next start, once the old app no longer writes them: on a Mac its preferences, caches, the updater's downloads, its saved window state and the logs of its run and its work.
  Other systems keep these inside the data folder.
- **The window's saved-data key**, cleared at the next start before the window opens: the key Chromium keeps in the password store to encrypt the window's cookies, on a Mac the keychain item `<name> Safe Storage` and on Linux the item of Chromium's own schema, each under the app's name.
  Windows keeps it inside the data folder.

Every flavor shares some of these: the window's saved-data key, phone keys and the agent skill.
They are left while another flavor's folder sits beside this one, whose own would stop working.

What stays is what the person set up elsewhere themselves, or what the app keeps no record of: this computer's key on other computers, and a system job an administrator set up.
