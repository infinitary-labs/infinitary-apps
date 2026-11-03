# Alpha, stable and public downloads

Stable and Alpha support both Homebrew Casks and signed, notarized drag-to-Applications disk images.
Homebrew copies update through Homebrew; direct copies update inside Infinitary without Homebrew.
Both channels keep one app, one bundle identity and the same saved work.
User instructions and migration precautions are in `docs/mac-installation.md`.

## How it holds together

`packaging/release-source.json` selects the public download origin and hidden download page at build time.
The selected download destination is `downloads.getinfinitary.com`; its Cloudflare storage configuration is separate from the source repository's visibility.
The workflow keeps the source repository private and retains its `v<version>` release as the immutable signed record, using the workflow's own token.
Bucket-scoped R2 credentials publish the public copy only after storage is configured.
Without those settings, the approved fallback keeps Homebrew and Linux publishing through the taps and skips disk images and direct feeds.

Each release carries the finalized universal ZIP, a signed and notarized disk image, and the Linux files, with checksum sidecars.
The ZIP remains the native updater's payload and the download paired computers use.
The disk image places Infinitary on the left, an instruction to drag it across, and the Applications shortcut on the right; its artwork and dimensions are owned by the design skill and `electron-builder.yml`.
The release publishes the verified ZIP to the Homebrew tap as well as the configured direct-download destination, then advances each path after its own credential-free fetch-back.
Cask publication keeps its style, compatibility, immutability and channel-isolation gates; direct installation and native updates do not require Homebrew.
Historical download URLs stay available; the readers retain their exact-version fallback for older paired computers.

- **Q13's four conditions bind, with one amendment**: nothing is collected under terms (`DATA_TERMS.published` is false, so the contribution switch is absent from the build and `DATA-TERMS.md` stays the unpublished draft until the beta, revised then with counsel), no outside code is merged before the corporation is the Licensor, the alpha notice ships with the build, and the assets move into the corporation within weeks of formation and before the first outside contribution.
  The amendment is the EONA alpha-before-incorporating decision (captain, 2026-09-22: "on from the first cask: an anonymous daily count, opt-out, disclosed in the notice"), widened by the captain the same day for funnel and retention accounting: the Diagnostics switch is ON by default and carries an allowlisted set of anonymous usage events - the app opening, a first mate turn ending or failing, the first-run funnel - with the app version and an anonymous random install ID that resets when Diagnostics is turned off and back on, never anything typed; it is disclosed in the alpha notice and on the first launch, and turned off by the switch (`docs/sharing.md` is the one home).

## Update channels

`src/core/update/macUpdates.ts` owns the saved subscription, logical-version ordering and consent.
`src/main/host/macUpdates.ts` owns `electron-updater` and Electron's native signed replacement.
The host enables native replacement only for an installed release Mac, not a development or hermetic source run.

- **Persist first.**
  `update-channel.json` in the data root records Stable or Alpha before the first update check.
  A valid existing choice wins; otherwise the installed logical version supplies the initial channel.
  A direct copy keeps the channel independently of the installed version and drops old cask-routing fields.
  A Homebrew copy instead follows its per-copy installation receipt, including the tap and channel chosen by its cask; it never enters the native updater.
  An Alpha subscriber remains Alpha after receiving a promoted stable.
- **Only newer versions.**
  Stable excludes prereleases; Alpha may take a newer alpha or promoted stable.
  The full logical version, not only Get Info's numeric core, determines precedence.
  Selecting Stable while ahead waits for a newer compatible stable, with no downgrade.
  A missing channel feed offers nothing.
  The native library's channel setter enables downgrades, so the adapter explicitly disables them afterward.
- **Consent before replacement.**
  Checking never downloads; Update and restart downloads, checks the checksum, saves the crew's work ("Saving work before an update" below), stages through native signature verification, awaits core shutdown, and restarts.
  Automatic downloads and automatic installation on quit are disabled.
  The notice shows progress and bounded errors, with a link to the release page for recovery.
  The app refuses updates from a mounted or translocated copy, an unwritable installation, or an unsupported system.
- **Switching invalidates pending work.**
  A channel change saves first, invalidates prior checks and offers, and cancels an unfinished download.
  Native staging locks the channel until restart.
  If shutdown fails after staging, the ready state preserves the staged update and retries restart without downloading or staging it again.
- **Settings and controlling views.**
  Settings → General places keyboard-accessible Stable and Alpha choices next to Version.
  The Version row's Check for updates reads the release source now on every copy whose installation the app knows, past the 4-hour saved answer, and joins a check already reading (`checkNow`, `inf:update:check`); command search's Check for updates opens it and presses it.
  Its line says what the check found: the latest release, a copy ahead of its channel, no release yet, the version available with Show update opening the update notice, or that updates could not be checked.
  A failed press never says the copy is up to date, while the quiet hourly check stays silent on failure; the button is unavailable while an update downloads, installs or waits for a restart.
  While an update saves the crew's work the line says Saving work, then Updating, and after the restart Resuming work until every turn the update stopped has started again.
  A Mac controlling another Mac changes and checks its own installed app, never the remote computer's.
  The release indicator and Settings share one renderer status store.

## Builds by system and chip

The selected Cloudflare snapshot serves `feeds/latest-mac.yml` for Stable and `feeds/alpha-mac.yml` for Alpha, using standard updater metadata with the finalized ZIP's URL, size and SHA-512.
The same snapshot carries schema-1 `infinitary-updates.json`, `infinitary-builds.json`, and `versions/<version>.json` with immutable ZIP and disk-image identities.
`releaseFeedFiles` reuses the existing forward-only target and builds producers and validates URLs against the configured destination.

The builds file carries `macos` → `arm64` and `x64` → `zip` and `dmg`, and `linux` → `x64` → `deb`, `rpm`, `appimage`, `arch` and `nix`.
Every build names a file on that version's release and its SHA-256.
Both channels naming one version must agree on channel-neutral bytes; the Arch and Nix recipes may differ because their package names encode the channel.
Linux and paired-device readers use the configured source; exact historical paired-device versions may still resolve through the old tap and its checksum sidecars.
Unknown build kinds remain compatible with older readers.

`node scripts/linux-recipes.ts release --version <v> --packages <dir> --out <dir>` prepares the Linux artifacts, recipes, `SHA256SUMS`, `manifest.json` and `assets.txt`.
A retry adopts published package bytes before rendering their recipes again.

## Updates on Linux

A Linux installation updates through the one update reader (`src/core/update/updateChecker.ts`), never a second one, from the builds file above.

- **Which package it is.**
  The deb and the rpm carry `resources/package-type` (`electron-builder.linux.yml`), the Arch recipe and the Nix package write their own, and an AppImage is told by its runtime's `APPIMAGE` and `APPDIR` (`src/core/update/linuxInstall.ts`).
  An installation whose package Infinitary cannot name is offered the version and its release page, and installs nothing.
- **A deb or an rpm.**
  The panel offers Install.
  The app downloads the build into its own data folder, refuses bytes whose SHA-256 is not the published one, saves the crew's work ("Saving work before an update" below), and asks the system for the person's password (`pkexec`).
  The command that runs then copies the package into a folder only the superuser can write, checks that copy's checksum again, so the bytes it installs are the bytes it checked, and hands it to `apt-get` or `dnf`, which bring anything the package needs.
  The app then writes its channel marker with the version it installed and starts again.
- **An AppImage.**
  The panel offers Install; the app downloads the build beside the AppImage it runs from, checks its checksum, saves the crew's work, replaces the file in one rename and starts the new one, with no password.
  An AppImage in a folder the person cannot write is refused in plain words.
- **Arch, Omarchy and NixOS.**
  Their packages update through their own package manager, so the notice names the command: for Arch and Omarchy, fetch the channel's recipe, check its checksum and `makepkg -si`; for NixOS, `nix-env -iE` with the recipe's address and checksum.
  Each recipe writes its channel marker beside the app, so an alpha installation that takes a stable version stays on alpha.
  The recipes publish on the configured public release; nothing publishes to the Arch User Repository.
- **When installing cannot finish.**
  A closed password prompt, a computer with no way to ask, a refused checksum or a stopped installer each say so in the panel, nothing changes, the crew's work carries on, and the panel shows the command that installs the same build by hand, checksum first.
- **Development and tests.**
  Only an unpackaged run reads `INFINITARY_UPDATE_BUILDS_URL` and `INFINITARY_UPDATE_LINUX_PACKAGE` (with `APPIMAGE` for an AppImage), which point the reader at a stand-in download source and stand in for a package; a run from source on Linux without them reads what a Mac reads.

## Saving work before an update

An update of this computer's own copy saves the crew's work here before anything replaces the copy (INF-2245, the stop-and-resume update the captain approved on INF-2223).
The update asks the crew's work (`CrewWorkForUpdate`, `src/core/update/updateWork.ts`), which `CrewSupervisor.saveForUpdate` answers.
The Mac updater asks once the download is done and before native installation; the Linux updater asks once the download's checksum is checked and before the password prompt or the AppImage's rename (`beforeReplace`, `src/core/update/linuxInstall.ts`).

- **Nothing new starts.**
  While the update saves, no crewmate turn on this computer starts: a reply, a steer, a queued task and the next turn of a task wait on their lanes in order (`heldForUpdate`).
  A turn already on its way to its model is refused before its model takes it (`StoppedBeforeStartError`), and its words stay on its lane.
- **Running work finishes first.**
  Each running turn stops safely (`ModelSession.stopSafely`, `src/core/session/session.ts`): a call it already began finishes and its result is kept in the conversation, a call asked for after the stop is refused and tells the model why, and only then is the turn cut.
  Pi's gate is its `beforeToolCall`; Claude's is a `PreToolUse` hook (`docs/claude-client.md`).
  A Claude call the client begins with its hooks off, as a staged skill turns them off, is waited for once the client says it began.
- **No deadline.**
  The save waits as long as the calls run, and the update panel names each task whose running work it waits for: Waiting for “Release notes” to finish what it is running.
- **What it records.**
  Each turn it stops gets one `turn-resumed` lane row, `stopped: "update"` with no computer, written before the stop (`docs/inbox.md`, "A turn a quit or crash cut").
  Nothing else is copied: the conversation, the task, its files, its approvals and its pause stay with their owners, and an idle or separately paused task gets no row.
- **Closing.**
  Once every turn has stopped, the shutdown waits, with no bound, until every conversation's client is gone (`disposeAll`), so each transcript is written before the new copy reads it.
- **After the restart.**
  The sweep carries each stopped turn on once from its row, before the words that waited; Settings' Version row says Resuming work until every such row is served (`resumingAfterUpdate`).
- **Update later.**
  While the update saves, Update later in the update panel or in command search (`updates.later`, `inf:update:later`) lets the update go: nothing is replaced, a turn still waiting for its calls goes on as if never asked, a turn already stopped carries on from its row, and the words that waited go now, in order.
  An installation that fails after the save, such as a closed password prompt or a refused signature, lets the work carry on the same way.
- **What it does not wait for.**
  A background job is app-lifetime: the shutdown stops it and its row says the quit stopped it (`src/core/jobs/jobManager.ts`), which the crewmate hears after the restart.
  A turn on another computer goes on there; the connection and Remote Login updates of a computer that runs work still pause its turns the earlier way ("Updating" in `docs/devices.md`).
  The guarantee starts with the copy that has this code: an update that replaces an older copy stops work the way that copy did.

## Casks and update targets

The cask generator and strict tap readers remain active release prerequisites for Homebrew installations.
The new feed writer reuses their typed forward-only target rules with the configured release names; it never renders a cask.
Every cask's homepage is Infinitary's website, `https://getinfinitary.com/` (`HOMEPAGE`), on both supported taps; the release contract checks it.
The app's offered Homebrew command runs `brew update` and upgrades the installed channel's fully qualified cask (`upgradeCommandFor`), including the old Firstmate tap.
Naming the tap and cask lets Homebrew 6 and later trust that cask when the installation predates tap trust, without trusting the whole tap, and works on older Homebrew too.

## Republishing the casks

The automatic cask republication workflow remains active.
A generator change on main rewrites the casks at their existing targets only after verifying the public downloads; it does not create a release or advance a target.
A dry run preserves the generated casks without pushing them.
Its optional `mac_runner` input selects a temporary runner for that dry run without changing `MAC_RUNNER`; publication ignores the override.
Historical releases, tags and checksum sidecars stay intact, and unrelated products on the shared taps remain untouched.

## The old-cask switch

Existing Firstmate 3000 users install an Infinitary disk image directly, without a final Homebrew upgrade.
The existing saved-folder handover preserves their work and explicit channel choice; the new updater replaces the marker's legacy routing fields with its persistent subscription.
Optional Homebrew ownership cleanup happens before copying the new app and never uses `--zap` (`docs/mac-installation.md`).
For channels activated in `packaging/old-cask-switch.json`, the release also mirrors the finalized ZIP and Linux assets to the old tap, verifies their public downloads, and advances its casks and frozen-schema metadata.
People who keep their Homebrew installation continue upgrading the same cask; the app's offered command names its tap explicitly so it also works after Homebrew begins requiring tap trust.
Moving to a disk image remains optional.
The switch lists `alpha` and `stable`; releases of either channel also update the corresponding older cask.

## The signed channel workflow

`release.yml` resolves one source and publishes verified immutable artifacts before any channel moves.

- **One source commit.**
  The `channel` input is `stable` - the workflow's default - or `alpha`, and both are requested from main, so the workflow file is always main's.
  The `resolve` job (Linux, no secret) provisions Node 24 before running `scripts/resolve-release.sh` from the workflow's own commit, in a clone with every branch and tag, and pins the source commit first.
  Both the resolver and its source-destination check need Node on the job's search path; a gate runner's action runtime alone does not provide it.
  For an automatic alpha it is the successful rolling-main run's exact `head_sha`; a manual alpha names its `candidate`, and a stable names the `promote`d alpha's own commit ("Promoting an alpha").
  The verify lanes, the update check, the signing job and the source tag use exactly it, and the targets file records it.
- **One candidate.**
  A successful completed `main` workflow automatically starts an alpha through `workflow_run`, supplying its exact source as the candidate.
  A manually dispatched live alpha still requires a full candidate commit id.
  `verified_main_run` is the recovery route for reusing a successful exact-source main run, not an unchecked skip switch.
  The resolver refuses it unless `git diff --name-only $(git merge-base <candidate> origin/main) <candidate>` lies under `release-notes/`: its code is exactly main's at the commit the review started from.
  Merges that land on main meanwhile wait for the next alpha.
  A rehearsal may omit it and build the dispatched commit.
- **Versions.**
  Both channels number from the newest stable tag, a bare `vX.Y.Z`.
  Alpha is its next patch, or its next minor when a commit since it is a breaking change (`type!:` or a `BREAKING CHANGE` footer), numbered by the workflow's run number: `X.Y.(Z+1)-alpha.N`.
  Stable is its alpha's numeric core.
  A fresh history with no stable tag of its own numbers from the record of past releases, `release-notes/archive.json`, which the resolver reads from the workflow's own commit: the next patch or minor above the newest numeric core either channel published in the archived history; and every version must be newer than that history's newest stable and newest alpha (`docs/release-notes.md` "A fresh history").
  Rehearsals use run numbers too, so gaps are normal.
  Nothing is committed: `package.json` and `CHANGELOG.md` stopped changing at stable 0.1.30.
  The private source record uses `v<version>` tags; Cloudflare downloads use `releases/v<version>/` object keys.
  An alpha is a prerelease, never latest.
  The source repository never needs to become public, and both Homebrew taps retain their releases and update files.
- **Two version identities.**
  The packaged `package.json` carries the logical version (`-c.extraMetadata.version`), which the running app reports (`app.getVersion()`); `CFBundleShortVersionString` and `CFBundleVersion` both carry its numeric core, so nothing relies on macOS accepting a prerelease suffix.
  The packaged `self-map.json`, in `Resources/` and inside `Resources/self-source/`, names the logical version too: the build step passes it as `INFINITARY_RELEASE_VERSION` to `scripts/generate-self-source.mjs`, so a crewmate reading only the self-source can tell which build it holds; the `package.json` inside that tree is the repository's own and keeps 0.1.30.
  `scripts/check-app-launch.sh <app> <logical version>` proves them separately at every launch gate - the built app, the distribution zip, and both fetched-back copies: the two fields from the bundle, the logical version by asking the running app, on a throwaway profile, through its own healthcheck over Chromium's debugging port (`scripts/app-runtime-version.mjs`).
  The gate starts the app in a process group of its own; afterwards it asks the app to quit and waits for it, stops outright whatever of that group, or whatever names the profile, is still running, reaps the app, and removes the profile only once nothing can write into it.
  Every launch runs the workflow's own copy of the gate and its probe: the signing job puts them in place of the source's once the app is packaged, and the publication job and the old-cask check before they launch anything, so a stable promoting an older alpha launches through the current gate while its app stays the alpha's.
- **Linux in every release.**
  The `linux` job calls `linux-packages.yml` at the release's version on its one source commit, with the notes job's catalog, for both channels, a stable promotion included: it builds the Linux packages and installs and opens each on a clean copy of its system (`docs/linux-packages.md`) while verify runs.
  The publication job waits for it, lays out the Linux files (`linux-files`) from its artifact and records them in the source record beside the zip, adopting any package a retry finds already published.
  It publishes them inside the same publication steps as the zip: the public release must match the record byte for byte, and both fetch-backs - the public one without a credential - compare every file and its sidecar before the feed commit writes the builds file.
- **Full alpha checks, inherited stable checks (FI3-482).**
  An automatic alpha reuses the completed rolling-main run's `linux-checks`, `linux-e2e` and `mac` lanes without running them again: those lanes cover Linux typecheck, lint, adherence lint, unit tests and build; every Playwright journey on Linux, in shards (`docs/testing.md`, "The Linux source desktop"); macOS unit tests, every Playwright journey, the installed Claude client check, the replay gate, and the development package with its signature, data-folder and bundled-git checks.
  The release also runs the update check (`mac-update.yml`, "The update check" below) on Apple silicon: the real update from the signing job's handoff, once every check passed, before publication.
  There is no Linux-only bypass.
  Performance grading stays on request (`verify.yml` with explicit `full_system=true`, task/source/reason and `perf=true`; `docs/forge.md`, "Verification workflow requests").
  A stable omits verify and inherits its alpha's checks: the resolve job reads the published alpha's release run, found by its run number (the alpha's suffix), because a run dispatched from main records main's commit rather than the candidate it built.
  The stable's source is the alpha tag's own commit, so nothing differs from what that run checked.
  The run must have succeeded with every lane's latest execution completed successfully, each Linux journey shard included, or carry validated exact-source main proof for an automatic alpha.
  Reuse reads GitHub's run and latest per-job executions, requires the trusted main-push identity, every full-check owner and complete Linux shard sets, and refuses skipped required owners, partial, cancelled, failed or other-source results.
  A manual alpha without reusable main proof, including a rehearsal, still runs full verification.
  A stable is refused without its alpha's proof, never verified again on its own.
  A promoted alpha must also have a passing update check on Apple silicon, or, for an alpha released before the update check, passing five-copy signed installer and updater jobs for both architectures.
  An alpha without those results is refused: publish and verify an updater-capable alpha first.
  The resolve and signing summaries name the alpha and link its run, explicitly saying the lanes were omitted, not passed here.
  The conditional reusable-workflow call may show as skipped; its Linux and Mac lane jobs are absent, never green skips.
  An API error stops resolution rather than inventing assurance.
  The signing job is the same for both channels and repeats none of the lanes' checks: it checks public-download visibility and updater capability, then builds, performs Developer ID signing, signed-app, launch and data-folder gates, notarization and stapling, the distribution zip's Gatekeeper and launch gates and checksum.
  Stable rebuilds new bytes, so all publication and fetch-back gates stay.
- **Signing while the checks run (INF-2074).**
  The signing job waits only for the notes it packages and the phone check; it builds, signs and notarizes while the verify lanes and the Linux packages are still checked.
  Its token only reads: it records, uploads and publishes nothing, so a failed check leaves no tag, release or public file behind.
  The update check and the publication job wait for every check, the verify lanes and the Linux packages included; recording is publication's first effect.
  A stable has no lanes to wait for, so its signing starts at once as before.
  The signing job holds the real Mac while the release's Mac lane runs, so that lane takes a virtual place or waits for the real Mac (`docs/testing.md`, "The real Mac's place").
- **Signing on the real Mac, publication in a virtual Mac (INF-1716).**
  The signing job runs on the real Mac through the checked disk image, then hands off and frees it.
  Its handoff is one uncompressed Actions artifact per attempt: the zip to record and, when one was built, the checked disk image, with a manifest of the run, attempt, workflow revision, source, channel, version, download mode, and each file's size and checksum.
  It never carries the app, the workspace, a credential or the environment, nor the Linux files, which come from the linux job; the artifact's id and the manifest's checksum are the signing job's outputs.
  The `publish` job starts only after the signing job and every check succeeded, in one disposable virtual Mac from the placement service, on the `release_light` or `light` kind's queue or its `mini-mac-virtual` pool (`docs/testing.md`, "Each Mac job's kind and size"); it waits for a free place and never falls back to the real Mac.
  Before any effect it validates the handoff: the manifest is the one the signing job wrote, names this run, an attempt no later than this one, this workflow revision and this release, and the files are exactly those it lists, byte for byte.
  Then it lays out the Linux files, records the zip and the Linux files in the source record, records the disk image and runs every later step in its existing order: the record's fetch-back, Cloudflare, Homebrew, the casks, the old-cask switch and the feeds, or a rehearsal's tap and feed rehearsals.
  Every Mac check there - signature, Gatekeeper, launch and version, the disk image against the zip - still runs, never replaced by a checksum; the job holds no Apple signing material, and each destination's credential stays on its own steps.
  Rerunning only the publication job reuses the signing job's handoff from whichever attempt produced it; rerunning the signing job hands off anew, and the record's immutable adoption still decides which bytes publish.
  The handoff code lives in the workflow itself, so an older alpha promoted to stable needs none of it in its source.
- **Release notes are checked first (`docs/release-notes.md`).**
  The `notes` job runs before `verify` or any signing, on the resolved source with full history.
  Every source change since the previous release needs a note or a reviewed exclusion, reviewed with its change before merge.
  An automatic alpha validates its exact-main source with `--verified-main`; it makes no new notes commit that would invalidate the inherited full check.
  The existing published-release reader derives historical manifests from immutable tags when no committed record exists.
  A manual notes-only candidate keeps its existing reviewed-source and committed-history checks.
  The job generates the offline catalog, the signing job packages it as `Resources/release-notes.json`, and the packaged copy's logical version and source commit are verified before notarization.
  A stable promotion proves `release-notes/` is identical to its alpha's, so promoted stables reuse the alpha's entries and ids; prose corrections need a new alpha.
  Its highlights are the captain's picks, written into the generated catalog by the workflow's own tooling ("Promoting an alpha").
  The publication itself changes nothing in the project, and a rehearsal pins nothing.
- **No local full e2e run before a cut.**
  Rolling main supplies the automatic alpha's full Mac and Linux proof; an alpha without reusable proof runs its own `verify.yml` lanes.
  Full e2e runs are CI-only, including release preparation; request an additional run for any branch on GitHub's Actions page, or through `github_write` for the ref the crewmate's task needs (`docs/forge.md`, "Verification workflow requests").
  Locally, run only affected spec files (with `--no-deps` for renderer/application specs).
- **Failed alpha checks.**
  Nothing is recorded or published: the signing job may have finished, but its signed files stay only in the run's handoff artifact, which expires after seven days.
  Automatic journey retries stay zero.
  When a test fails, the release crewmate gets it fixed on main; its next rolling run that passes starts the next alpha automatically.
  Only when the failing journey passes alone on the same commit may the failed checks be manually re-run once, keeping the alpha's version; if they still fail, diagnose rather than retry again.
  No urgent-alpha bypass.
- **Published bytes never change** (`scripts/publish-release-asset.sh`).
  The source release is the record: its tag must name the source commit.
  A retry adopts an already-published ZIP: its signing job reads the record before the disk image, builds the image from that ZIP's finalized, stapled app rather than the retry's rebuilt app, and hands that ZIP over.
  The publication job's record must then name the same bytes; a record another run of the version changed since that read fails before anything publishes, and a fresh dispatch signs from it.
  An already-published disk image is adopted too, and its contained app must match the ZIP exactly.
  The Cloudflare copy must match the private source record byte for byte.
  Nothing uploads with `--clobber`; a missing sidecar is added, a present one must agree.
- **Disk images and ZIPs have separate gates.**
  `scripts/build-mac-dmg.sh` packages the prebuilt app without re-signing or rebuilding it.
  The workflow signs the container with the existing Developer ID identity, notarizes it, and staples it before computing its checksum.
  `scripts/verify-mac-dmg.sh` checks notarization and Gatekeeper, mounts read-only, checks the Applications shortcut and saved Finder layout, compares the app with the ZIP, and launches a copied installation.
  The unauthenticated fetch-back repeats the ZIP and disk-image gates against the actual public downloads before a channel advances.
- **One atomic feed snapshot** (`scripts/publish-feeds.sh`).
  After every public download passes fetch-back, `scripts/release-feeds.ts` writes the moved channels' standard updater metadata, targets, builds, and immutable per-version manifest into one immutable R2 snapshot.
  `scripts/publish-storage-feeds.ts` retains previous files, verifies the new snapshot publicly, and conditionally switches `feeds/current.json` last.
  See “Download storage” below for the object and credential contract.
  An alpha moves only alpha; a stable moves stable and also alpha when newer than alpha's current target.
  A late older publication, inconsistent manifest, invalid existing file, or changed bytes at a published version is refused.
  A concurrent pointer write is refused rather than overwriting the other publication; read the new snapshot before publishing again.
  A release is never cancelled to start another; only a newer rehearsal of the same channel and ref replaces an older rehearsal.
- **Rehearsals publish nothing.**
  `-f dry_run=true` runs the channel's full checks, Linux packaging, signing, notarization, the disk-image gates and the update check itself.
  It computes a local initial feed plan and keeps the metadata as `release-feed-rehearsal`, without instantiating a storage client or reading upload credentials.
  The rehearsal proves the release's metadata construction, not compatibility with a live channel's current target; live publication validates that state before switching.
  No tag, release, cask or feed is published, and no repository visibility changes.
  Its summary names each gate's outcome; a skipped live publication or fetch-back did not pass in that run.

## Download storage

`packaging/release-source.json` owns the production download origin and hidden download-page address.
The site keeps its private-alpha landing page and never links to `/alpha-downloads/`; the page is unindexed, not authenticated, and anyone with its address can download.
The storage and serving Worker belong to `infinitary-infra`; creating or deploying them is separate from merging this release code.
Repository variable `R2_BUCKET` and secrets `R2_ENDPOINT` (`https://<account-id>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` activate direct publication.
The endpoint stays secret because it contains the Cloudflare account identifier; the two upload keys are bucket-scoped.
With all four absent, a live release skips the disk image and direct feeds but still publishes Homebrew and Linux to both activated taps.
Its Linux recipes use the tap's download URLs in that mode (`RECIPE_HOST=tap`), never the not-yet-configured storage address.
A partial configuration fails before publication.
Upload credentials are passed only through the recipient's environment and signed HTTPS request headers; they are never placed on a command line or printed.

`scripts/publish-downloads.ts` uploads the finalized private-record bytes to `releases/v<version>/<asset>` and adds a SHA-256 sidecar for every asset.
The S3-compatible uploader signs each payload's SHA-256 and uses `If-None-Match: *`; an existing object is accepted only after its digest agrees, never overwritten.
The release verifies every asset and sidecar through unsigned HTTPS before the signed ZIP and disk-image gates and before advancing any direct channel.
Every historical version remains downloadable.
Release objects and snapshot objects carry `Cache-Control: public, max-age=31536000, immutable`; the download service caches Linux file types as well as ZIPs and disk images.

A snapshot lives under `feed-snapshots/<id>/`.
The ID is SHA-256 of the JSON encoding of sorted `[filename, SHA256(content)]` pairs.
The snapshot retains all prior feed files and version manifests and applies all changed channels together.
`feeds/current.json` contains `{ "schemaVersion": 1, "prefix": "feed-snapshots/<id>/", "files": ["alpha-mac.yml", "infinitary-builds.json", "infinitary-updates.json", "latest-mac.yml", "versions/<version>.json"] }`, with the actual sorted list of files; a channel not yet published may be absent.
The uploader requests identity encoding when reading R2 objects, verifies every snapshot object publicly, then replaces this pointer with `If-Match: <previous strong ETag>`, or `If-None-Match: *` for its first creation.
If R2 still supplies a weak or missing validator, the uploader refuses the pointer write; it never strips `W/` or guesses a strong validator.
A conditional-write refusal stops the publication without moving the selected snapshot.
A transport failure can leave an unknown write outcome; read the object or pointer before any deliberate retry, never replay it automatically.
The download Worker resolves `/feeds/<filename>` against one read of this pointer and serves only a listed file.
Pointer and feed responses, including missing objects, carry `Cache-Control: no-store` so a previous missing object cannot hide a completed upload.
Installer serving supports GET, HEAD and byte ranges.

The first live publication waits for the storage owner to confirm the bucket, domain, cache behavior, credentials and real R2 conditional-write semantics.
After that setup, a separately authorized alpha proves public fetch-back, both taps, and signed installed updates on both Mac architectures; unit fixtures do not prove those live effects.

## Cutting an alpha

A rolling `main.yml` run that passed automatically starts an alpha at that exact commit (INF-2259, the captain's accepted override).
The alpha cuts only when no earlier alpha is still being cut and something the desktop app is built from changed since the previous release ("An alpha with nothing new to build", below).
The `workflow_run` completion trigger uses the checked source, not main's newer head, and never dispatches another full check just for the cut.
Main runs no phone check ("An alpha does not wait on the phone check", below).
A failed, cancelled or incomplete main run cuts nothing; main's waiting-version coalescing and fix-forward process stay unchanged.

1. **Validate the completed run.**
   The resolver reads the completed successful trusted main-push run and every latest per-job execution from GitHub.
   It requires every full-check owner and all Linux journey shards at exactly the source being released.
   A covered main run, whose files a green swept batch already checked, names that batch run instead; the resolver then reads the batch run's full check and requires its verdict's tree to be the source's tree (`docs/testing.md`, "The swept batch").
2. **Keep the same source.**
   The notes check validates committed declarations without a separate notes-review commit.
   Existing immutable tags supply published manifests through the same ledger reader when they have not been committed afterward.
   Missing or invalid notes still fail the release; editorial corrections merge normally and wait for their own passing main check.
3. **Run release-only gates and publish.**
   Phone availability, Linux package installation, signing, notarization, actual signed update and public-download checks still run.
   Only broad `verify.yml` coverage is inherited; a skipped verification call is not reported as a new pass.
   The source tag `v<version>` names the exact checked commit.

### An alpha with nothing new to build

A rolling alpha cuts only when it has something new to ship (INF-2465, the captain: "make it so that the rolling alpha release pipeline on main only runs when there are desktop app code changes").
The resolve job's first step decides it, before main's proof is read, and when it skips, the run ends green with a summary saying why and no later job runs.
It skips in two cases:

1. **An earlier alpha is still being cut.**
   While an earlier rolling alpha run is still going, no new one cuts, whatever either holds (the captain: "as long as there's one main alpha release still happening, don't start any new alpha cuts. doesn't matter what changes are in each").
   An earlier run counts once its notes job exists, so a run still deciding whether to skip never stops another.
2. **Nothing the desktop app is built from changed.**
   `node scripts/release-notes.ts desktop-changes --source <commit>` finds the previous release by the notes check's own rule and lists the paths that changed since it on the desktop build list, `scripts/desktop-build.ts`.
   An empty list skips; a source with no previous release cuts.

The list names what the release installs, builds and packages the app and its Linux packages from: `src/` without its test files, `resources/`, `packaging/`, `vendor/`, `store/`, `patches/`, the package and builder configuration, the design skill and the scripts the build runs.
Tests, the phone, docs, `.github/`, `release-notes/` and every other script never cut an alpha on their own.
`tests/release-workflows.test.ts` fails when the build starts running a script the list misses, unless `BUILD_SCRIPTS_THAT_SHIP_NOTHING` names it with a reason.

A skipped merge is not lost: the next alpha that cuts carries it, and that alpha's notes check covers its note or exclusion.
A failed or cancelled alpha publishes no tag, so the next run still finds the change and cuts.
Main's full check still runs on every merge that changes more than the phone app or the docs, and its green mark still moves.
Skipped runs leave gaps in the alpha numbers, which already skip run numbers.
Manual alpha requests, recoveries, rehearsals and stable promotions never skip.

Main's next check waits while an alpha is cut, so merges made meanwhile queue and are checked together once the cut ends (`docs/testing.md`, "Main's desktop release check").
Each rolling alpha run is named "Alpha from main run N" after the main run it cuts from, which is how that wait finds it.

### Pausing the rolling pipeline

The captain can pause the automatic pipeline and resume it later (PERS-51, the captain: "add a "pause/resume" button on the rolling alpha panel for me to pause/resume the rolling pipeline manually").
The pause is the repository variable `ROLLING_ALPHA_PAUSED`: `true` pauses, and any other value or no variable leaves the pipeline running.
While it is `true`:

1. **Main checks stop.**
   A main check a push started cancels itself in its first job, `alpha-wait.yml`, before any other check behind it starts, and its summary says "Paused by the captain".
   A cancelled check never moves main's green mark and never cuts an alpha.
   A main check started by hand still runs.
2. **Rolling alphas hold.**
   The resolve job's first step ends a rolling alpha run green with "Paused by the captain" ("An alpha with nothing new to build", above).
   An alpha already past that step finishes.
3. **Everything else carries on.**
   Merging and pull request checks continue, and manual alphas, recoveries, rehearsals and stable promotions ignore the variable.

GitHub reads a variable only when a job starts, so the variable alone cannot stop a check that is already running.
Pausing therefore sets the variable and also cancels main's running and waiting checks, the captain's answer "stop now, also cancel the running check".
The pause lasts until Resume, which clears the variable and re-runs nothing, the captain's answer "the next merge starts a check that covers the pause".
The next merge's check runs at main's head, so it covers every merge made during the pause, and its alpha carries their notes.
`tests/release-workflows.test.ts` holds both steps.

### An alpha does not wait on the phone check

An alpha ships the signed desktop app only (INF-2353, the captain's pick "Drop phone from alpha gate", asked as "alpha is the desktop app, right?"), and main runs no phone check at all (INF-2492, the captain: "remove phone check from main altogether. we run all phone check parts at release").
`scripts/main-alpha-proof.mjs` therefore reads every job of the main run, and `release.yml`'s resolve job starts only on a successful one.
The phone's own gates run where the phone ships: `ios-release.yml` runs every part on iPhone and iPad before a TestFlight upload, and the release's phone job still waits for a TestFlight build ("The phone goes first", below).

For a failed release's recovery, a manual alpha request can name `candidate=<exact source>` and `verified_main_run=<successful main run id>`; the resolver reads and validates that proof again.
A manual candidate without reusable proof follows the existing full-verification route, including its notes-only candidate and release-specific gates.
Neither passing main nor automatic publication authorizes merging an unrelated pull request or changing stable's captain-selected highlights.

## The phone goes first

A phone updates more slowly than the desktop app, so a desktop release waits for a phone build that keeps changing things on it (INF-1649).
The captain's words: "alpha desktop builds wait for phone build is on testflight. stable desktop releases wait for phone builds are live in app store (which we haven't done yet, so enforce this only once the first ios app release is live in app store)".
A phone build keeps changing things on a release when the release's view floor reaches the phone's contract, or the phone's own floor reaches the release's (`docs/contract.md`, "The version rule").

- **Alpha.**
  The release run's phone job (`scripts/phone-order.ts`) looks for such a build on TestFlight: an `ios-release.yml` run whose availability job passed, or a later status check of its build that passed.
  A build Apple once confirmed stays enough, and the job does not ask Apple whether it is still on TestFlight (the captain's "A past success is enough").
  A major that kept views leaves the build already on TestFlight enough, so the alpha waits for nothing.
  After a major that broke views, the release crewmate dispatches `ios-release.yml` from main first, with the next phone version, and dispatches the alpha once its availability job has passed.
- **Stable.**
  The phone job asks Apple which phone build is live in the App Store and waits for one that keeps changing things on the stable.
  Until Apple shows that a version of Infinitary was ever released in the App Store, a stable waits for no phone.
  Once one was, a stable always waits for such a build, also while a withdrawn version leaves none live.

Without such a build the phone job fails, and the release job neither signs nor publishes anything; a rehearsal says what it would wait for and never fails on it.

## Promoting an alpha

Every stable is a published alpha rebuilt as stable (captain, FI3-424): the same code, tested as the alpha, never whatever main holds.
Builds are not byte-for-byte repeatable, so "the same code" means the alpha's commit and lockfile with its stable version.
A promotion opens no pull request (captain, FI3-1057).

A release crewmate sends `"return_run_details": true` with its GitHub dispatch; an accepted answer with `workflow_run_id` starts the app's minute watch automatically.
It confirms the run's version through `github_read` and ends its turn when the answer says the watch stands.
If the accepted answer supplies no run number, it finds the run through `github_read`, confirms its version, and calls `read_workflow` with `runId` alone.
That short read saves the app's minute watch while the run goes on: end the turn, never sleep or loop on run reads.
The app wakes the crewmate on the first failed job and when the run ends, up to three hours (`docs/forge.md`, "The run watch").
Read the named job's log on a failure wake; a release run outcome is not a pull request green reading or permission to merge.

1. **Pick the highlights.**
   The captain picks the three highlights a stable shows, from every change since the last stable (captain, FI3-1392); each alpha review's ranks stay with its alpha users.
   Before anything runs, the crewmate preparing the promotion builds the stable's catalog the way the release run does, with the alpha's own tooling, in a scratch working copy at the alpha's tag (`git worktree add --detach <copy> v<alpha>`): `node <copy>/scripts/release-notes.ts generate --version <X.Y.Z> --source HEAD --out <dir>/release-notes.json`.
   The script does not start through a path with a symbolic link in it, such as macOS's `/tmp`, so the copy lives at a real path.
   From main, `node scripts/release-notes.ts stable-highlights --catalog <dir>/release-notes.json` lists every change since the last stable, with the rank each alpha review gave it and whether it has a hero picture.
   The crewmate puts up one decision card titled for the stable, with three required slots: 01, the lead, then 02 and 03.
   Each slot lists every one of those changes, the lead's only the ones with a picture, and the card shows each change's hero picture beside its title.
   It marks one recommendation per slot by the release review's rule (`docs/release-notes.md` "Who writes what"): a new feature most people will see, over a fix or a niche case.
   It starts nothing until the captain picks, and the captain's picks, lead first, are the run's `highlights`.
2. **Start.**
   `gh workflow run release.yml --ref main -f channel=stable -f promote=<alpha version> -f highlights=<lead>,<second>,<third>` (for example `0.1.31-alpha.40`, and the picked changes' entry ids).
   The resolver refuses unless the alpha has a source tag `v<alpha>`, its numeric core is newer than the latest stable, and it carries a feat, fix or breaking change since that stable.
   It also refuses a live stable without highlights, and highlights that are not one to three different entry ids.
   The resolve job then refuses unless the alpha's release run has every lane's latest execution passed, or validated exact-source main proof ("Full alpha checks, inherited stable checks").
3. **Release.**
   The run builds the alpha tag's own commit as the alpha's numeric core, `X.Y.Z`, signs and publishes it, and tags `vX.Y.Z` on that same commit.
   Its notes job writes the picks into the stable's catalog as its only highlights, in order, and clears every other rank (`docs/release-notes.md` "The release check").
   That step runs the tooling of the workflow's own commit, because the alpha's commit may predate it; the alpha's own `verify-package` then checks the result.
   It refuses a lead with no hero picture, a pick from outside the changes since the last stable, and a count of picks other than its slots: three, or one per change when there are fewer.
   The words of every change and `release-notes/` stay the alpha's.
   If a gate fails nothing publishes; dispatching the same promotion again keeps whatever that version already published.
   The public notes name the promoted alpha, and the source release names the picks.
4. **Record.**
   The stable's record rides with the next alpha's review commit, which the notes check asks for.
   It keeps the picks, as the stable's source release names them: `node scripts/release-notes.ts manifest --version <X.Y.Z> --highlights <picks> --write`.
   Pinning a promoted stable without `--highlights` is refused.

The next alpha is numbered from the new stable tag ("The signed channel workflow").
A stable rehearsal (`release.yml -f channel=stable -f dry_run=true`) promotes an alpha the same way, or builds the dispatched commit as the next stable when it names none, and publishes nothing.
It may leave `highlights` empty to keep the alpha reviews' ranks.

## Activating the channels

A request for “a release” that names no channel means Alpha; “a stable release” names Stable.
The workflow's own default remains Stable, so an operator always supplies the intended channel explicitly.
An automatic alpha changes no project source; a manual release and a stable promotion follow the candidate and promotion rules above.
When a release review rechecks old crew filings, its report names every checked key, the evidence for its fate, and the keys it left unchecked (`docs/task-graph.md`).

Before activation, the storage owner provisions the bucket, download Worker and domain, verifies conditional writes and unsigned downloads, and supplies the R2 settings through the approved credential recipient.
The source repository remains private; neither this build nor storage activation changes its visibility.
An updater-capable alpha must pass its update check before Stable may promote it.
The first new publication creates the selected feed snapshot only after public artifacts pass fetch-back.
Keep the Homebrew casks publishing alongside direct installers; neither a shared tap nor its historical downloads is retired.

## The update check

Every alpha, a dry run included, proves on Apple silicon that the version alpha subscribers have now updates to it (INF-1900, the captain's direction D).
`.github/workflows/mac-update.yml` runs `scripts/check-update-from-alpha.mjs` in a placement-service virtual Mac, on the `release_light` kind's queue in a publishing release, otherwise the `light` kind's or `mini-mac-virtual` (`docs/testing.md`, "Each Mac job's kind and size").
Intel is a best-effort side effect of the universal build: no release runs a hosted Mac for it (the captain, INF-1900).
It reads the published alpha feed, `feeds/alpha-mac.yml`, for the version alpha subscribers have now, which is a promoted stable right after a promotion.
It downloads that version's public disk image, checks it against its published checksum and copies the app into `/Applications` the way a person installs it, with its direct-installation receipt.
It then serves a local copy of the alpha feed that offers the release, under the same private local root, hosts entry and isolation guard as the five-copy check below; no production override enters either app.

The `update` job runs after the signing job and every check, from its handoff, and publication waits for it.
It is the release's only update check: the rehearsal that ran before signing repeated only its first checks, so INF-2498's plan removed it.

- The handoff's zip must be the one the signing job handed over.
- The installed app must trust the local feed and offer the release on Alpha without downloading anything before consent.
- A real streaming turn through a local custom connection is running when the installed app takes the update; the release's own signed zip must replace it natively, the app must restart on its own as the new version on Alpha, with a valid signature and its direct receipt.
  The live reply must stop before the replacement, and the captain's message and a personal draft must survive.

The check builds nothing, signs nothing and sends nothing to Apple; its observations are kept as `update-evidence-*` artifacts.
The saved work is created by the installed published app itself, through its own interface, because an older app refuses a database a newer build wrote.
A stable inherits its alpha's update check and does not run it.

The five-copy check below stays available on request and no longer runs in a release.
A pull request that changes Electron or `electron-updater`, the update code (`src/main/host/macUpdates.ts`, `src/core/update/`), signing or packaging (`electron-builder.yml`, `scripts/build-mac-dmg.sh`, the entitlements) or how the app shuts down runs it before merging, through `verify.yml` with `installer_only=true`.
The update check covers only the path from the current alpha to the release; channel switching, refused downloads, the read-only disk image, the saved-work handover and Homebrew are the five-copy check's.

## Isolated signed verification

`verify.yml` with `installer_only=true` invokes `mac-installer.yml` for the requested ref and runs no personal-Mac signing job.
The build and Apple-silicon checks request the `build` and `light` kinds' queues, or the placement service's `mini-mac-virtual` virtual-only label where those have none; Intel remains on `macos-15-intel`.
`installer_chip` (`both` by default, or `arm64` or `x64`) drops the other Mac type's installed checks from the run for a one-chip recheck; a release passes none and checks both.
The workflow uses existing Apple credentials only in disposable Actions Macs, under a scratch signing home, and publishes nothing.
Before installation, signing or trust changes, `scripts/installer-environment.ts` refuses local execution and requires the kernel's virtual-machine reading on a self-hosted runner; the physical Mac cannot substitute for a guest.
`scripts/installer-signing.mjs` repeats that guard and keeps passwords off command lines.
It creates the scratch home's `Library/Preferences` before writing the keychain search list, because Security does not create that parent directory.
Before packaging, it checks the disposable identity's search-list visibility and signs and verifies a throwaway executable; finding the certificate alone is not signing proof.
It builds real release binaries at ordered fixture versions, notarizes them, and tests the actual native updater on Apple silicon and Intel.
The packager's automatic notarization is disabled: `scripts/installer-notarize.ts` submits each app and disk image once, saves its submission ID and artifact digest, and reads that same submission until Apple accepts or rejects it.
The upload streams normal output and saves the assigned ID before the upload finishes; JSON output would withhold it until the command ends.
Uploads use the enclosing workflow's time limit, not the two-minute deadline for status and ticket commands.
If saving an ID fails, the script stops its upload child and reports that failure; it never continues without the journal.
Recorded transport failures get bounded retries for status reads and ticket attachment, never a second upload; an upload without a confirmed ID remains explicitly unknown.
A changed artifact cannot reuse another artifact's submission.
Only acceptance followed by ticket attachment and validation passes, and signature and Gatekeeper checks remain required.
Failed requests capture the guest's network interfaces, default route and power assertions beside the submission journal, which the workflow retains even on failure.
The status wait has a thirty-minute budget per artifact; transport retries wait fifteen seconds, thirty seconds, then one minute three times, within the workflow's existing limit.
Before redirecting GitHub, the probe prepares Homebrew's Ruby runtime and real `homebrew/core` tap, retaining the tap's commit in its observations.
The API-disabled cask upgrade needs that core metadata even though Infinitary has no formula dependency; a missing tap is fetched while public GitHub is still reachable, never replaced with an empty tap, and its one-time clone has fifteen minutes.
A temporary local HTTPS server supplies the normal production addresses inside those disposable machines; no production feed override or disabled signature check enters the app.
The server uses the same isolation guard and inherits only the runner's actual `GITHUB_ACTIONS` and `RUNNER_ENVIRONMENT` facts alongside the restricted scratch environment, never a claimed hosted identity or the parent's signing credentials.
Those admission facts go only to the verification server; the installed application's environment stays separate.
The installed app uses the existing virtual-Mac drawing switches in a guest, avoiding the paravirtualized Metal stall described in `docs/testing.md`, "Drawing in software".
The installed probe creates its own scratch preferences directory, reads back the trust-keychain search list, and requires both the system HTTPS reader and the installed app to accept the fixture feed before preparing active work.
The disposable app environment sets `NODE_USE_SYSTEM_CA=1` so Node's Homebrew metadata reader uses the same registered system root; the value must be exactly `1`.
The release's disabled node-options fuse strips `NODE_EXTRA_CA_CERTS`, so the fixture does not rely on that variable or change the fuse.
One environment builder supplies both direct launches and the guest's LaunchServices values, which cleanup restores or unsets; the opt-in also reaches the fixture app's child processes.
This opt-in is confined to disposable verification, retains certificate and hostname checks, and does not make an unregistered root trusted.
The active-work setup, status reads and cleanup waits record their phases and have limits; the probe records a failure before starting cleanup.
Between fresh-install scenarios, the probe stops the app and removes only the download cache named by `packaging/app-update.yml`, so a previous download cannot bypass the next scenario's transport check.
It leaves the shared `Library/Caches` directory and other cache owners intact; stopping the app's main process does not establish that every macOS cache writer has stopped.
The fixture certificate is registered in the disposable System keychain and must appear in the admin trust listing; cleanup deletes that certificate by SHA-1 rather than removing the last admin trust record.
Independent cleanup continues after an error and never replaces the original proof failure.
While a native replacement is awaited, the probe samples from outside the signed app every two seconds and appends each change to `install-stages.jsonl`: whether the app and ShipIt are running, the installed version, and the app's update phase and problem while its page answers.
A replacement that never arrives keeps the app's last status reading, ShipIt's `ShipIt_stderr.log`, `ShipIt_stdout.log` and `ShipItState.plist` from the scratch home, and ten minutes of the system log for ShipIt, Infinitary and Squirrel; cleanup also keeps ShipIt's files before removing the scratch home.
The app itself is unchanged, so this tracing never voids reused signed copies.
The installed-version reader pins the archive with a temporary hard link on the same volume, so replacement cannot mix one archive's header with another's contents; a missing archive remains unobserved and malformed contents still fail.
The saved-work handover must finish with both copies intact, the original retired and refused, and the new folder openable; the recovery copy is never expected to disappear.
The proof exercises fresh copies, alpha-to-alpha with unchanged numeric bundle versions, alpha-to-promoted-stable-to-next-alpha, stable-to-stable, no-downgrade switching, cancellation, corrupt bytes, invalid signatures, permissions, read-only images and the saved-work handover from Firstmate 3000 to Infinitary.
It temporarily removes Homebrew's standard entrypoints on each disposable machine for the native-update checks, then restores them for signed Homebrew installation and upgrade checks.
`scripts/check-installed-homebrew.mjs` runs generated Stable and Alpha casks from both supported taps against the signed ZIPs, using disposable local taps and cached artifacts.
Homebrew 6 refuses to load casks from an untrusted tap, so where Homebrew has the `trust` command the check trusts each disposable tap, whole, in the scratch home's trust store before reading its casks; an older Homebrew loads them without trust.
It checks quarantine, the per-copy receipt, signature and notarization after installation and upgrade; the running Homebrew app must show its own command and refuse native replacement.
Failed fixture commands retain their exit status, signal and standard error or, when that is empty, standard output.
The build job validates each stapled ticket with Apple once; installed checks then require the installed `Contents/CodeResources` to exist and match the fixture ZIP's ticket bytes, alongside the signature and Gatekeeper checks.
They do not repeat Apple's online ticket lookup, which can lose its network on a hosted runner; a missing, changed or unreadable ticket fails and records both sides without a retry.
Uninstalling without `--zap` and installing the direct copy must retain the saved task and draft and restore direct ownership and in-app channels.
A real streaming turn through a local custom connection must stop before replacement, and its message must survive restart alongside a saved task and personal draft.
Its observed transcript and pictures are artifacts; fixtures and signing material are not released.
Hermetic UI journeys and unit tests do not substitute for this signed proof.

### Reusing signed verification copies

A test-setup repair can reuse existing signed copies without another build or Apple submission when the reviewing agent has established that the application behavior is unchanged.
This is not an automatic judgment from file names: the agent reviews every difference, including packaged inputs and the embedded source record.
An application change needs new signed copies instead.
The original copies keep their original embedded source and signatures; a reuse run records its newer verification source separately and never presents those copies as a new build.

A `verify.yml` dispatch selects `installer_only=true` and supplies `installer_reuse` as a JSON object with `runId`, `artifactId`, `artifactSha256`, `sourceHead`, `checkHead`, `changedPaths`, `sameApplication: true` and a nonempty `applicability` explanation.
The two heads are full commit IDs, and `changedPaths` lists every difference between them, not only the files the agent most recently edited.
A nonempty reuse declaration also selects installer-only mode itself, so it never starts the unrelated full-verification lanes.
The normal release call supplies no declaration and still builds fresh copies.
Preparing this route does not itself authorize a verification run, new signing or publication.

`scripts/installer-reuse.ts` checks the clean checkout and exact declared differences, then reads the original run, artifact and successful build through the job's read-only GitHub access.
The artifact must belong to that run and workflow version and have been created during the successful signed build; the overall original run may have failed in its installed checks.
The selected artifact ID and SHA-256 are explicit, and an expired, missing or changed artifact fails rather than silently starting a build.
The download streams to disk, matches GitHub's byte count and the declared archive digest, and forwards no GitHub sign-in header to the download host.
The standard Python ZIP64 reader extracts only the producer's exact flat file inventory, refusing duplicates, special files, encrypted members and paths outside that inventory.
Every fixture's bytes must match its recorded size and both digests, the fixture roles must match the current test's roles, and every app ZIP must retain the declared original source in its embedded source record.
The temporary outer archive is removed after verification; the existing app ZIPs and disk images are not modified.

Both disposable-Mac jobs then run the same complete native and Homebrew scenarios as a fresh build, with no signing credentials restored.
The evidence retains the compatibility declaration, original run and artifact, original source and newer check source; the temporary Homebrew metadata also names the original signed source.
Reuse neither waives an installed check nor establishes a new signed pass until those checks actually complete.

## The alpha notice

`packaging/alpha-notice.txt` remains the one home of the alpha notice and appears on every release's notes.
Its Diagnostics disclosure and opt-out remain unchanged (`docs/sharing.md`).
A reviewed wording change reaches new releases; historical releases are never silently rewritten.

## Versions

The alpha ships as 0.x and the public beta stays 0.x (captain decision 2026-09-21); there is no 1.0.0 at the beta gate.
A breaking change takes the next minor, never the next major, so every release stays on the 0.x line.
The tag stays bare (`vX.Y.Z`, never a component prefix) and the release's logical version is read off it.

Versions live in tags alone ("The signed channel workflow"): an alpha is the newest stable tag's next patch or minor, numbered by the workflow run, and a stable is its alpha's numeric core.
A repository that starts again from one commit has no tags of its own; it numbers from the record of past releases instead, above every version either channel published before it, and never tags an archived version (`docs/release-notes.md` "A fresh history").
`package.json`'s version and `CHANGELOG.md` stopped changing at stable 0.1.30; do not hand-edit either.
Plain merge titles are refused.
A stable with nothing to release is the captain's call.

Which release first carried a change is read from its commit, never from a date: `git merge-base --is-ancestor <commit> v<version>` answers it for each fetched tag, and a stable carries exactly what its alpha's commit does.
An installed app's version is the logical one in the `package.json` inside its `app.asar` (the running app's `app.getVersion()`); Get Info and `Info.plist` show only the numeric core ("Two version identities" above).
The build that showed a given card is in that card's observations (`card_observations.build`, `docs/card-evidence.md`).

## Operator steps (the captain's, once)

1. Confirm the five Apple secrets listed in `docs/architecture.md` and public readability of the selected download repository.
   A separate destination also needs `PUBLIC_RELEASE_TOKEN`; the selected source repository uses its workflow token.
2. Rehearse the release with `dry_run=true`, which runs the update check.
   Neither verification nor rehearsal publishes a release or changes visibility.
3. Let a rolling-main run that passed cut its exact source as an alpha, or promote a verified updater-capable alpha with the captain's selected highlights.
   Publication verifies both public Mac downloads and every Linux file before advancing feeds.

## Before the public beta

A checklist the beta gate walks, each item dated when it was added.
An item is done when its result is recorded where it names; it is never ticked here.

- [ ] **Re-read Anthropic's pages on the Claude seat** (added 2026-09-26, the owner's Q8 a on W1: the Claude seat ships in every build, and the beta re-reads the terms).
  Read the Claude Agent SDK overview, Anthropic's legal and usage page, and the Help Center's usage-limits note again.
  Record the reading as a new dated entry under "The terms" in `docs/architecture.md` §16.1 - never an edit of an older one - and confirm the Claude seat still ships, or escalate to the captain before the beta.

## Verification owners

- `src/core/update/macUpdates.test.ts` owns subscription persistence, consent, ordering, stale replies, cancellation and staged-restart recovery.
- `src/main/host/macUpdates.test.ts` owns native configuration, writable-install checks, signature failure and shutdown ordering.
- `src/core/update/releaseFeeds.test.ts` exercises the actual updater metadata parser, immutable manifests and channel advancement.
- `tests/e2e/mac-updates.spec.ts` drives keyboard selection, restart persistence, progress, recovery, cancellation, Saving work and Update later through the hermetic app.
- `src/core/orchestrator/crewSupervisor.test.ts` ("saving work before this computer's update") owns the hold, the safe stop, Update later and the carry-on after the restart; `tests/helpers/sessionContract.ts` owns each backend's safe stop.
- `src/core/update/linuxInstall.test.ts` and `src/core/update/updateChecker.test.ts` own the Linux save before replacement and its Update later.
- `tests/release-workflows.test.ts` evaluates the release workflow's conditions, promotion evidence and no-publication rehearsals.
- `tests/e2e/installed-update-work.spec.ts` checks that a fresh app accepts the proof's local connection and message while its real provider stream stays open, then retains the message after stopping.
- `tests/installed-update-fixtures.test.ts` exercises coherent archive reads across an ordered replacement and the real saved-work mover's retained recovery copy.
- `scripts/check-update-from-alpha.mjs` updates the published alpha to each release's own signed zip in a disposable Apple silicon virtual Mac.
- `scripts/check-installed-updates.mjs` observes real signed replacement and saved work in disposable Actions Macs, on request; `scripts/check-installed-homebrew.mjs` checks signed cask updates and installation-method handover; `scripts/verify-mac-dmg.sh` verifies the finalized installer against its ZIP.
- Cask producer, republication and isolated real-Homebrew consumer tests gate the Homebrew path, including the per-copy receipt and refusal of native update effects.
  The consumer runs the generated install hooks on quarantined disposable apps and verifies that only the ownership receipt changes, preserving quarantine, other metadata and app bytes.

### Checking older Homebrew consumers

`INFINITARY_CASK_HOMEBREW_VERSIONS=5.1.13,5.1.14,6.0.14,6.0.15,current pnpm test tests/cask-consumers.test.ts` runs the cask journeys on each version: installation, upgrade and channel switching, upgrading through republished targets, and the old-cask migration.
The source Homebrew repository must already contain those tags and their matching vendored Ruby versions; the test checks them out only in its scratch clone and never fetches or updates the source.
For archived versions with different Ruby requirements, run each version separately with `INFINITARY_CASK_HOMEBREW_REPOSITORY=<prepared-repository>` pointing at an offline-ready Homebrew copy for that tag.
Without that variable the test uses the installed version.
`INFINITARY_CASK_PRETRUST_VERSION=5.1.14 INFINITARY_CASK_HOMEBREW_VERSIONS=5.1.14,6.0.0,7.0.11 pnpm test tests/cask-consumers.test.ts -t "executes the offered upgrade"` installs before tap trust, then runs the app's complete offered command under each selected Homebrew, on both channels and both taps.
That regression uses the scratch clone's compatible Ruby, local Git sources for `brew update`, and cached stand-in downloads; it verifies the installed version, channel marker, saved work and cask-only trust.
Its default run revokes scratch tap trust after installation to reproduce the same untrusted state without requiring historical Homebrew tags.
Every version runs with `HOMEBREW_DEVELOPER=1`, so current Homebrew also proves the deprecated block is not evaluated.
