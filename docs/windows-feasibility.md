# Windows feasibility observations

Windows is not a supported release target; the internal Windows installer and its checks are `docs/windows.md`.
The manually requested `windows-feasibility.yml` investigation collects observations on a disposable `windows-2025` x64 runner, not an ordinary-user Windows 11 desktop.
It publishes no installer and changes no product behavior, accounts, signing setup or system permissions.
Its successful job means observation collection finished, never that Windows parity passed.
Failures and unreachable checks are results to read, not assertions to weaken.

## Running the investigation

Confirm capacity and spending approval before dispatching the workflow through the project's own forge sign-in (`docs/forge.md`, "Verification workflow requests").
The job has a 35-minute limit, uses the standard hosted Windows runner, keeps no dependency cache and retains its evidence artifact for one day.
Account for any pull request checks separately; the job's time limit is not an account spending limit.
Do not enable a schedule or add it to a release gate without a separate support decision.

The workflow attempts the unchanged frozen dependency install and source build independently, then collects each production-boundary observation in its own process, with a 100-second process-tree cleanup limit.
`HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` point to disposable folders before application code loads, and Pi's catalog network is off.
No real provider client or sign-in is used.
The runner writes logs, structured results and any startup picture under its temporary directory, outside the checkout.
Download evidence to the task's evidence folder; never commit results or generated binaries.

## What the observations establish

- Native loading opens an in-memory SQLite database, calls a Windows function through koffi and asks ONNX Runtime which speech providers it carries.
  Provider listing does not establish usable graphics or real dictation.
- Shell work uses the production `JobManager`, not the runner's replacement shell.
  Descendant cancellation is attempted only if that command owner can start a command; an unavailable shell leaves cancellation blocked, not passed.
- Private files use the production atomic private writer with a synthetic sign-in value and read back Windows ACLs without changing them.
  No second user is created, so cross-user denial still needs separate proof.
- Transport uses the production pinned TLS dialer against an ephemeral loopback home, a synthetic device identity, and a wrong-home refusal.
  It also probes the existing private route boundary; neither result proves SSH bootstrap, a background service or mixed-device work.
- A synthetic provider drives a real Pi coding session through the production session factory, writing a marker and trying the production command owner.
  This isolates session feasibility from full supervisor dispatch and does not qualify real subscription login or renewal.
- Desktop startup uses the existing isolated Electron launcher and records the resulting window and its security settings when launch succeeds.
  Failure to reach the window is an unresolved startup result, not permission to disable the sandbox.
- A separate hidden-browser observation bundles the unchanged production page host and connection guard into a disposable Electron entry, so a full-app startup failure does not hide browser feasibility.
  It uses keyboard input on a loopback page, records a picture, and probes refusal of a public name resolving to loopback; it qualifies no saved real sign-in or remote desktop session.

The task report owns demonstrated results, remaining Windows 11 access needs and effort estimates.
Windows on Arm, Windows Server product qualification, distribution, signing, updates, microphone hardware, desktop sessions and other-user operation remain outside these observations.
