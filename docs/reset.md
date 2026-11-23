# Reset Infinitary

Settings → General ends with Reset Infinitary, which takes this computer's Infinitary back to how it was just installed: the next start opens on the welcome screen, asking where the first mate should live.
Purge task data, the row above it, removes tasks alone and keeps projects, sign-ins and settings; each row says what it keeps.

## The row

The row is the window's own and never a view's: a window that controls another computer's first mate does not show it, and `inf:app:reset` refuses there (`Shell.resettable`).
Pressing Reset turns the row into its question, as Secrets' Forget does: what it deletes, how many open tasks stop (`inf:app:reset-scope`), and that projects in the person's own folders keep every file and commit, with Purge task data named for clearing tasks only.
Keep everything has focus, so Enter never resets; it changes nothing and gives focus back to Reset.
The danger button, Reset Infinitary, starts the reset; the app quits and starts again.

No agent can start a reset.
`inf:app:reset` is a host channel only the window's page reaches, and the first mate's side, `inf:app:reset-prepare`, is a program-only channel (`PROGRAM_ONLY_CHANNELS`) that neither the page nor `infinitary-axi` reaches; both are destructive exceptions in the app actions coverage (`src/shared/actionCoverage.ts`).

## Before it quits

The window's program runs the reset (`runReset`, `src/main/reset/running.ts`), each step capped so a remote service never holds it up, and none stops the next:

1. The first mate undoes what its own side set up elsewhere (`prepareReset`, `src/core/reset/prepare.ts`): it removes its paired phones and computers while the connection still runs, so a connected one hears it was removed; discards each open task, so its registered stops and keeps run, and waits for them; removes each kept job with its own remove; undoes what it set in projects outside its folder ("Your projects"); signs out its accounts; and removes its integrations, revoking a sign-in where the service offers it.
2. On the person's own folder of a flavor, the program clears the system password store's items and its start entries ("Outside the folder").
3. It writes the mark beside the folder, naming the outside kinds the next start still clears.
4. It stops the first mate - beside a command, whichever run holds the folder, with its starter let go for good (`Shell.stopForReset`) - and starts the app again.

Nothing before the quit deletes the folder, which this start still holds.

### Your projects

A project that lives in the data folder, one the app cloned, goes with the folder.
One that lives outside it - adopted from the person's own folder, even when a link inside the folder names it - keeps every branch, commit and file; only the settings Infinitary wrote into it go (`undoProjectSettings`, `src/core/reset/projectGit.ts`): its task remotes, the push address it set on origin, its `branch.<name>.infinitaryTask` keys, its `refs/infinitary/` references and the links to working copies inside the data folder.

## At the next start

`finishResetAtStart` (`src/main/reset/atStart.ts`) runs from the main entry before anything of the start opens the folder, the compile cache included, and before Electron is ready (`finishReset`, `src/core/reset/finish.ts`).
It takes the reset's own lock, `<folder>.reset-lock`, by the move lock's rules, so a second start meanwhile quits quietly.
Then, by the mark's stage:

1. `asked`: the folder is renamed aside to `<folder>.resetting-<pid>` in one step, and the mark moves to `moved`.
2. `moved`: every folder renamed aside and the older copies are deleted, and the mark moves to `outside`.
3. `outside`: each outside kind the mark lists is cleared.

The mark goes last, so a start cut off at any step carries on at the next; each step can run twice, and a fresh folder is never wiped by an old mark.
A kind that cannot be cleared stays on the mark for up to three starts, then the mark goes anyway.
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
- **The app's own files**, cleared at the next start, once the old app no longer writes them: on a Mac its preferences, caches, the updater's downloads, its saved window state and the logs of its run and its work.
  Other systems keep these inside the data folder.

What stays is what the person set up elsewhere themselves, or what the app keeps no record of: the `infinitary-axi` command's link and its agent skill, a phone's key the app added to `authorized_keys`, this computer's key on other computers, a computer this one works for (which sees it as out of reach), and a system job an administrator set up.
