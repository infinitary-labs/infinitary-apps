# Reset Infinitary

Settings → General ends with Reset Infinitary, which takes this computer's Infinitary back to how it was just installed: the next start opens on the welcome screen, asking where the first mate should live.
Purge task data, the row above it, removes tasks alone and keeps projects, sign-ins and settings; each row says what it keeps.

## The row

The row is the window's own and never a view's: a window that controls another computer's first mate does not show it, and `inf:app:reset` refuses there (`Shell.resettable`).
Pressing Reset turns the row into its question, as Secrets' Forget does: what it deletes, how many open tasks stop (`inf:app:reset-scope`), and that projects in the person's own folders keep every file and commit, with Purge task data named for clearing tasks only.
Keep everything has focus, so Enter never resets; it changes nothing and gives focus back to Reset.
The danger button, Reset Infinitary, asks the system's own confirmation of the person at this computer, the one Secrets uses: Touch ID or the account password on a Mac, Windows Hello, or the Linux system prompt.
Cancelling it, or a confirmation that fails, changes nothing and gives focus back to Reset; where the system has none to ask, such as an isolated folder, the row's question alone confirms.
Once confirmed, the app quits and starts again.

No agent can start a reset.
`inf:app:reset` is a host channel only the window's page reaches, and the first mate's side, `inf:app:reset-prepare`, is a program-only channel (`PROGRAM_ONLY_CHANNELS`) that neither the page nor `infinitary-axi` reaches; both are destructive exceptions in the app actions coverage (`src/shared/actionCoverage.ts`).

## Before it quits

The window's program runs the reset (`runReset`, `src/main/reset/running.ts`) once the system confirmed the person, each step capped so a remote service never holds it up, and none stops the next:

1. The first mate undoes what its own side set up elsewhere (`prepareReset`, `src/core/reset/prepare.ts`): it removes its paired phones and computers while the connection still runs, so a connected one hears it was removed; discards each open task, so its registered stops and keeps run, and waits for them; removes each kept job with its own remove; undoes what it set in projects outside its folder ("Your projects"); signs out its accounts; and removes its integrations, revoking a sign-in where the service offers it.
2. On the person's own folder of a flavor, the program clears what it reaches outside the folder now ("Outside the folder"), and leaves the home this computer runs work for (`leaveWorkHome`, `src/main/reset/workHome.ts`): it stops the work's run, tells that home Leave, as a device's own Leave does, so the home takes this computer off its list instead of keeping it as out of reach, and removes what was set up here for it.
   The work's working copies sit inside the data folder, so the next start deletes them with it, unmerged work included.
   A home out of reach still lists this computer until it is removed there.
3. It writes the mark beside the folder, naming the outside kinds the next start still clears.
4. It stops the first mate - beside a command, whichever run holds the folder, with its starter let go for good (`Shell.stopForReset`).
5. It ends every program of this account still holding a file or working folder in the data folder, such as a server a task started or a terminal the person opened in a task's working copy (`endLeftoverPrograms`, `src/main/reset/leftovers.ts`): each gets 15 seconds to end by itself, then an end request and a kill; never this app or a program it started.
6. It starts the app again.
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
