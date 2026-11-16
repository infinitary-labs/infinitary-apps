# Windows

Infinitary on Windows is one unsigned internal installer for x64 PCs, built and checked by `.github/workflows/windows.yml`.
It is not published: no release carries it, nothing signs it, and no update reaches it.
The installed app offers no update either: it never reads the release source, and the Version row says Infinitary does not update itself on Windows yet (`createInstalledUpdateChecker` in `src/core/update/updateChecker.ts`).
Windows on Arm, signing, updates and a published download are later pieces of the Windows plan.
The earlier hosted investigation and what it observed are `docs/windows-feasibility.md`.

## What is built

`electron-builder.win.yml` extends the shared `electron-builder.yml` and builds one NSIS installer, `Infinitary-<version>-windows-x64-setup.exe`.
It keeps only Windows x64's own native code: the speech library, koffi's addon, the SQLite build and the terminal helper.
Native modules are not rebuilt, as on Linux: better-sqlite3 carries a Node-API build for Windows x64 that Electron loads as it is.
The load supervisor (`scripts/load-supervisor.c`) is a POSIX program, so a Windows build skips it and the installer ships no `load-bin`.
The installer and the program carry the committed `packaging/build/icon.ico`, rendered from the same picture as the Mac and Linux icons (`scripts/render-app-ico.mjs`); electron-builder ships it unchanged, so the build runs no icon tool of its own.
The task commands (`resources/axi-bin/`) are POSIX shell scripts that talk to the app over loopback with curl, so they run in Git Bash unchanged.

## The installer

The installer is one click for one person: it asks no question and never asks for administrator rights (`requestedExecutionLevel: asInvoker`, `perMachine: false`).
It installs under `%LOCALAPPDATA%\Programs`, registers its removal for this person in Windows Settings, and puts an `Infinitary` entry in the person's Start menu, with no desktop shortcut.
The Start menu entry carries the app's identity (its AppUserModelID), `appId` from `electron-builder.yml`; the app sets the same one at start (`src/main/windowsStartup.ts`), so Windows files its windows and notifications as Infinitary's.
A run from source takes the development flavor's identity, with `.dev` after it, so it never stands in for the installed app.
At its end the installer opens the app through that Start menu entry (electron-builder's `runAfterFinish`, a shell open of the shortcut), so Explorer starts the app as the Start menu does, never the installer.
Removing Infinitary in Windows Settings keeps the saved work: `deleteAppDataOnUninstall` is false, so tasks, settings and sign-ins stay in `%APPDATA%\infinitary` for a later install.
Nothing the app does afterwards needs administrator rights either: the projects folder links an adopted project with a junction, which a standard account may make, where a folder symlink would need Developer Mode (`src/core/workspace/repoRegistry.ts`).

## Git for Windows

Windows ships neither Git nor a bash, and the app needs both: Git keeps each task's work apart, and a crewmate's commands run in Git Bash.
Before its window opens, the installed app looks for a suitable Git for Windows (`src/core/windowsGit.ts`): a folder holding both `cmd\git.exe` and `bin\bash.exe` whose git answers `--version`.
It looks in Git for Windows' Program Files folders, then in its install for one person, `%LOCALAPPDATA%\Programs\Git`, then in the install each `git.exe` on the search path belongs to.
The app uses the first one it finds: its children find that `git` on their search path (`src/core/hostEnv.ts`), and Pi runs commands in its Git Bash (`src/core/pi/windowsBash.ts`).
Nothing changes the PC's own search path or Git settings.

With no suitable Git, the app asks once in a system dialog whether to install Git for Windows (`src/main/windowsGitSetup.ts`), with Install Git for Windows and Quit.
On the person's yes it downloads the pinned release, `GIT_FOR_WINDOWS` in `src/core/windowsGit.ts`, from Git for Windows' own GitHub releases.
Before running it, the app checks the download's SHA-256 against the pinned one and reads its Authenticode signature through Windows PowerShell: the signature must be valid and name Git for Windows' publisher.
It runs the installer for this person alone (`/CURRENTUSER`), silently but with its own progress window, then checks that the installed git answers the pinned version.
A failed step says what failed, installs nothing further, and offers to try again or quit.
A run of the app with no window (`docs/run.md`) has nobody to ask, so it ends with the reason, and a run from source keeps Pi's own lookup.
Moving to a newer Git for Windows changes the version, file, address, SHA-256 and size together, each read from the release's own page.

## The checks

`windows.yml` has two jobs.
`build` runs on the PC's Windows places, a fresh standard account removed when the job ends (`vars.WINDOWS_RUNNER`, default `shell-pc-windows`).
It installs, builds and packages the installer, and keeps it on the run with its `SHA256SUMS` as the `windows-installer` artifact; nothing uploads it anywhere else.
Both jobs first unpack Git for Windows' portable build, pinned by its SHA-256, and put it first on their own steps' search path, so the job's bash, git and curl are that release's: the places' own Git 2.45.2 has a curl that refuses a plain download (exit 43), and the fresh machine has no Git.
Each job's checkout then waits while GitHub refuses the job's token and checks out once more, as every checkout a release reaches does (`docs/testing.md`, "GitHub refusing a job's token"); the wait runs in that Git Bash, in the PowerShell job too.
The project's composite actions are bash, which that Git Bash runs; the pnpm action writes a `.cmd` shim beside each sh one on Windows, so PowerShell steps find `pnpm` too.

`check` runs on a fresh Windows 11 virtual machine for each check (`vars.WINDOWS_CLEAN_RUNNER`, default `shell-pc-win11`), the captain's pick on the Windows plan.
The machine must have a standard person signed in at its desktop with Explorer running, no Git installed, and a runner that runs as that person; it is removed when the job ends.
The portable Git sits in the job's temporary folder and on its own steps' search path only, so the app, opened through Explorer, never sees it.
Its PowerShell steps run in Windows PowerShell 5.1, the one Windows ships, since the machine has no PowerShell 7.
The machine has no Python or compiler either, so the job installs the project's packages without their build scripts and compiles only the message catalogs the journey reads; the journey runs the installed app, never a build of its own.
The job checks the installer against the build's `SHA256SUMS`, runs it silently as a double-click does (`/S --force-run`), and runs `tests/windows/installed-windows.spec.ts` with `playwright.windows.config.ts`.
The job's git never asks for a sign-in, since a prompt on the machine's desktop waits for a press nobody makes, and the journey's config keeps Playwright from reading git, which on a batch's pull request run would fetch the base commit without credentials.
The job uploads its evidence even when its timeout cancels it.
That journey checks, in order:

1. The install is for this person alone, under `%LOCALAPPDATA%\Programs`, and the Start menu entry carries the release's identity.
2. The app opened after install with Explorer as its parent, as the Start menu opens it.
3. The Git for Windows offer is up; the journey presses its install button through Windows' accessibility tree, and the pinned Git installs for this person and the app's saved data appears.
4. Launched again with the mock provider and the `tests/windows/windowsCrew.ts` scenario, a crewmate on a small Node project runs `git status`, `pnpm install`, one test file, a build and a task command in that Git's Git Bash, each step printing its mark only when it succeeded.
   The crewmate then starts a background job whose program starts a child; cancelling the task ends both.
5. The removal entry's own command removes the app silently, as Settings does: the program, its removal entry and its Start menu entry are gone, and `%APPDATA%\infinitary` still holds the saved data.

Its pictures and readings go to the `windows-evidence` artifact.
The check runs on every alpha (`release.yml`'s `windows` job, which an alpha's upload and publish wait on) and on each combined batch that touches Windows-relevant files (`batch-checks.yml`'s `windows` job, which the batch's last job waits on).
`scripts/windows-paths.ts` decides the batch's run from its changed files: the Windows check's own files always count - its workflow and the composite actions it uses, its installer config, the script itself, and its journey's config and every test file the journey reaches by its imports, all read from the checkout - and otherwise any file the build reads counts unless it only makes the Mac or Linux packages, is under `.github/`, or is one of the pull request check's light paths (tests, docs, release notes, the phone app).
An unreadable change runs the check.
It also runs on request (`workflow_dispatch`).
