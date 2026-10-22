# The private alpha (roadmap 1.2)

The v1 community installs Infinitary with one line while the product repository stays private through the beta gate (captain decisions 2026-09-21; plan section 1.2):

```
brew install --cask infinitary-labs/tap/infinitary
```

People who installed Firstmate 3000 keep the command they have; the old-cask switch moves them across ("The old-cask switch").

## How it holds together

- **The tap is Infinitary's public tap**, `infinitary-labs/homebrew-tap` (FI3-1720's answers; the captain makes it in the rename's step 12).
  Its casks (`Casks/infinitary.rb` for stable and `Casks/infinitary@alpha.rb` for alpha, written by `src/core/update/tapPublication.ts` - see "Casks and update targets") carry the download URL, the checksum and the one-paragraph alpha notice as their caveats - never the product source.
  The stable cask token is the public name, `infinitary`, never a codename.
  Firstmate 3000's tap, `kunchenguid/homebrew-tap`, keeps its casks for the people who installed them ("The old-cask switch").
- **The artifact is a release on the tap itself**, because Homebrew fetches a cask's URL with a plain unauthenticated GET and a private repository's release assets refuse one.
  The tap is public, so `release.yml` publishes the signed, notarized, stapled universal zip and its `.sha256` sidecar there under the app-prefixed tag `infinitary-v<version>`, or `infinitary-alpha-v<version>` as a prerelease for an alpha (neither ever marked the tap's "latest"), with the alpha notice, the channel's install line, the checksum and the source commit as the release notes.
  The product repository keeps its own bare `v` tag, and its private release keeps the same artifact as the record.
  The same releases carry the Linux files beside the zip, each with its `.sha256` sidecar, and `SHA256SUMS` ("Builds by system and chip").
  There is no separate releases repository.
- **The generator refuses any other host.**
  `generate-cask.sh` exits before writing a cask whose URL is not a `.zip` asset of the tap's release of the version it writes (`infinitary-v<version>`, or `infinitary-alpha-v<version>` for an alpha version) - the private product repository above all, a foreign host, or another product's or version's release on the tap - so a wrong URL cannot reach the tap.
  It equally refuses a version its channel does not carry and a checksum that is not 64 lowercase hex digits.
- **The release proves what the community gets.**
  After publishing, the workflow fetches the exact URL the cask will carry with `curl` and no token, checks it against the sidecar and the recorded artifact, and runs the signed-app and launch gates on that copy; only then does it write the casks and the update targets in one tap commit, running Homebrew's own style cops (`brew style --except-cops=Cask/InstallSteps`) on the casks first.
  A private, missing or altered asset fails the release before the tap learns of it ("The signed channel workflow").
- **The update indicator reads the public tap** (`src/core/update/updateChecker.ts`), because an unauthenticated read of a private repository's releases would report "no update" forever.
  It reads the installed channel's target from the tap's update targets file and, until that file is published, a stable installation falls back to the tap's release list (see "Update channels" below).
  It never asks the tap for its latest release, which could be another product's.
- **Q13's four conditions bind, with one amendment**: nothing is collected under terms (`DATA_TERMS.published` is false, so the contribution switch is absent from the build and `DATA-TERMS.md` stays the unpublished draft until the beta, revised then with counsel), no outside code is merged before the corporation is the Licensor, the alpha notice ships with the build, and the assets move into the corporation within weeks of formation and before the first outside contribution.
  The amendment is the EONA alpha-before-incorporating decision (captain, 2026-09-22: "on from the first cask: an anonymous daily count, opt-out, disclosed in the notice"), widened by the captain the same day for funnel and retention accounting: the Diagnostics switch is ON by default and carries an allowlisted set of anonymous usage events - the app opening, a first mate turn ending or failing, the first-run funnel - with the app version and an anonymous random install ID that resets when Diagnostics is turned off and back on, never anything typed; it is disclosed in the alpha notice and on the first launch, and turned off by the switch (`docs/sharing.md` is the one home).

## Update channels

The release-channel plan (FI3-279) gives one app two update channels, stable and alpha.
Both replace the same `Infinitary.app` and share `<appData>/infinitary` (`docs/saved-data-compatibility.md` protects that shared saved work).
This section is the update reader's half; "Casks and update targets" below is the writer's half that produces its inputs, and "The signed channel workflow" publishes them.

- **The installation chooses the channel.**
  After a successful install or upgrade the installer writes `update-channel.json` into the data root: the closed schema `{"schemaVersion": 1, "channel": "stable" | "alpha"}`, plus one optional `cameThroughOldCask` boolean, outside the signed app.
  Firstmate 3000's casks write it once the old-cask switch lists their channel, and an installation whose marker carries it reads Firstmate 3000's tap and names that cask's command ("The old-cask switch").
  The app only reads it, on every check, from its own userData (`src/core/update/updateChannels.ts`), so a development run (`infinitary-dev`) or an isolated run never reads the installed app's marker.
  A valid marker wins whatever version runs: an alpha tester who receives a stable version stays on alpha, and installing the stable cask switches notices to stable.
  A marker may also name the `version` its installer installed; then it holds only while that version runs, so a package installed by hand later decides its channel again.
  The casks never name one; on Linux the app writes one after it installs an update, and an Arch or NixOS package carries one beside the app ("Updates on Linux").
  A missing, unreadable or invalid marker reads as alpha only for an alpha version `X.Y.Z-alpha.N`, otherwise stable.
  An installation whose cask has not yet written the marker - every installation until a cask from "Casks and update targets" reaches it - reads that fallback.
- **Each channel is offered its own target.**
  The reader fetches `infinitary-updates.json` from the tap's default branch.
  It names at most one target per channel: the version, its public release page, its download, the download's SHA-256 and the product source commit it was built from.
  The tap writes it with the casks, after the download was fetched back and verified, so a notice never names a version its cask cannot install.
  Stable considers only the stable target.
  Alpha considers the alpha target, which is either an alpha or the stable version handed to alpha.
  Only a strictly newer version is offered, by SemVer precedence (`src/core/update/semver.ts`): `0.1.25-alpha.10` is newer than `0.1.25-alpha.2`, `0.1.25` is newer than every `0.1.25-alpha.N`, and `0.1.26-alpha.1` is newer than both.
- **The targets file is validated whole.**
  Schema version 1 with no unknown keys; a stable target carries a stable version; every version is a stable `X.Y.Z` or an alpha `X.Y.Z-alpha.N`; the release page is exactly the tap's release of that version's tag (`infinitary-v<version>` for a stable artifact, `infinitary-alpha-v<version>` for an alpha one) and the download a `.zip` asset of that release; the checksum and commit are lowercase hex; and a stable version named by both channels names the same artifact.
  Anything else refuses the whole file.
  `buildUpdateTarget` is the one producer of a target record.
- **The panel names the channel.**
  The indicator stays quiet unless an update is offered.
  Its panel says "Stable updates" or "Alpha updates", names the offered version with the installed one beneath it ("You have 0.1.26-alpha.14", the status's `currentVersion`, because Get Info shows only the numeric core and never the alpha), and shows that channel's selectable command, `brew update && brew upgrade --cask infinitary` or `brew update && brew upgrade --cask infinitary@alpha`; View release opens the target's release page.
  Nothing downloads or installs on its own.
- **Linux reads the builds file.**
  A Linux installation reads `infinitary-builds.json` instead of the targets file, for its own chip and package ("Builds by system and chip", "Updates on Linux"); a Mac reads exactly what it read before, so installed Macs never meet a new key.
- **A Mac controlling another reads its own.**
  An app controlling the first mate on another Mac runs no core, and still makes this reader for the app installed on it, from the same `createInstalledUpdateChecker` the core uses (`docs/view.md`): its notice and release page are this Mac's, never the other Mac's.
- **Failures never invent an update.**
  A successful read holds for 4 hours per channel.
  A failed or invalid read keeps that channel's last good answer, or reports no update, and retries on the next ask.
  A valid file without a channel's target offers that channel nothing; it never authorizes a guess from the release history.
- **Rollout before the builds file exists.**
  Until the first release that carries Linux, the tap has no builds file, and a Linux installation is offered nothing, never a Mac's version.
- **Rollout before the targets file exists.**
  While the file is missing (404), a stable installation keeps the legacy reader: the tap's release list, only `infinitary-v<X.Y.Z>` tags, never a draft, a prerelease, an alpha tag or another product's release.
  An alpha installation is offered nothing and never the stable command.
  Installed stable apps keep reading `infinitary-v` tags and never see an alpha tag.
- **Development and tests.**
  An unpackaged run simulates the channel's next version unless `INFINITARY_SIMULATE_UPDATE=0`.
  Only an unpackaged run reads `INFINITARY_UPDATE_TARGETS_URL`, `INFINITARY_UPDATE_RELEASES_URL` and `INFINITARY_UPDATE_CURRENT_VERSION`, which point the reader at a stand-in tap and present an installed version; a packaged app never reads them.

## Builds by system and chip

The release-channel file installed Macs read is a strict schema-1 file, so it cannot learn a new key without every installed Mac refusing it.
Linux therefore reads a second file on the tap, `infinitary-builds.json`, written by the same writer in the same tap commit (FI3-1432 piece 7).

- **What it holds.**
  For each channel, the version it offers, that version's release page, its source commit, and every build of it keyed by system, chip and kind: `macos` → `arm64` and `x64` → `zip` (the universal zip, for both chips), and `linux` → `x64` → `deb`, `rpm`, `appimage`, `arch` and `nix`.
  Each build is a download on that version's tap release and its SHA-256.
- **How it is read.**
  `parseBuilds` (`src/core/update/updateChannels.ts`) checks what it carries: each channel's version is one it carries, its release page is that version's release, and every download is an asset of that release whose name ends as its kind's does (`.zip`, `.deb`, `.rpm`, `.AppImage`, `.PKGBUILD`, `.nix`).
  A version both channels name carries the same release, source and channel-neutral bytes; an Arch recipe or Nix package may differ, because each names its channel's package.
  Keys a reader does not know are dropped rather than refused, so a later system, chip or kind - Windows, Arm - adds to the file without an installed app refusing it.
  `schemaVersion` changes only when a reader must refuse.
- **How it is written.**
  `advanceBuilds` (`src/core/update/tapPublication.ts`) moves in step with the targets file: each channel the targets move takes this publication's builds for that channel, and a channel's version always equals its target's.
  A stable publication hands its builds to alpha whenever it hands its target, with alpha's own Arch recipe and Nix package.
  A publication without Linux builds onto a tap that carries the file is refused, and an invalid file is never overwritten.
  `node scripts/tap-publication.ts advance ... --linux <manifest>` writes it beside the casks and the targets file; `scripts/publish-tap.sh` takes the manifest as `LINUX_MANIFEST` and checks the channel's Linux builds name exactly the files that were fetched back, before any commit.
- **The Linux files.**
  `node scripts/linux-recipes.ts release --version <v> --packages <dir> --out <dir>` lays out one release's Linux files as they publish: the Ubuntu package, the Fedora package and the AppImage the `linux` job built and checked, each channel's Arch recipe (`<package>-<version>.PKGBUILD`) and Nix package (`<package>-<version>.nix`) rendered from that Ubuntu package - a stable renders alpha's too - and `SHA256SUMS`, with `manifest.json` for the tap writer and `assets.txt`, the order they publish in.
  Rendering is repeatable, so a retry that adopts the published Ubuntu package renders the recipes that were published with it.

## Updates on Linux

A Linux installation updates through the one update reader (`src/core/update/updateChecker.ts`), never a second one, from the builds file above.

- **Which package it is.**
  The deb and the rpm carry `resources/package-type` (`electron-builder.linux.yml`), the Arch recipe and the Nix package write their own, and an AppImage is told by its runtime's `APPIMAGE` and `APPDIR` (`src/core/update/linuxInstall.ts`).
  An installation whose package Infinitary cannot name is offered the version and its release page, and installs nothing.
- **A deb or an rpm.**
  The panel offers Install.
  The app downloads the build into its own data folder, refuses bytes whose SHA-256 is not the published one, and asks the system for the person's password (`pkexec`).
  The command that runs then copies the package into a folder only the superuser can write, checks that copy's checksum again, so the bytes it installs are the bytes it checked, and hands it to `apt-get` or `dnf`, which bring anything the package needs.
  The app then writes its channel marker with the version it installed and starts again.
- **An AppImage.**
  The panel offers Install; the app downloads the build beside the AppImage it runs from, checks its checksum, replaces the file in one rename and starts the new one, with no password.
  An AppImage in a folder the person cannot write is refused in plain words.
- **Arch, Omarchy and NixOS.**
  Their packages update through their own package manager, so the notice names the command: for Arch and Omarchy, fetch the channel's recipe, check its checksum and `makepkg -si`; for NixOS, `nix-env -iE` with the recipe's address and checksum.
  Each recipe writes its channel marker beside the app, so an alpha installation that takes a stable version stays on alpha.
  The recipes publish on the tap's release; nothing publishes to the Arch User Repository.
- **When installing cannot finish.**
  A closed password prompt, a computer with no way to ask, a refused checksum or a stopped installer each say so in the panel, nothing changes, and the panel shows the command that installs the same build by hand, checksum first.
- **Development and tests.**
  Only an unpackaged run reads `INFINITARY_UPDATE_BUILDS_URL` and `INFINITARY_UPDATE_LINUX_PACKAGE` (with `APPIMAGE` for an AppImage), which point the reader at a stand-in tap and stand in for a package; a run from source on Linux without them reads what a Mac reads.

## Casks and update targets

The writer's half of the channel plan (FI3-279 piece 3): the two casks and the update targets file the reader above consumes, produced by one typed module, `src/core/update/tapPublication.ts`, from the closed facts in `updateChannels.ts`.
It publishes nothing itself; "The signed channel workflow" writes its output to the tap.

- **Two casks, one app.**
  `infinitary` (stable) and `infinitary@alpha` both install `Infinitary.app` (`com.getinfinitary.infinitary`) and declare `conflicts_with` each other, so Homebrew refuses to install one beside the other.
  `uninstall quit:` has Homebrew quit the running app before an upgrade replaces it or an uninstall removes it.
  Uninstalling keeps the data root; only `brew uninstall --zap` deletes it, and nothing tells anyone to use it.
  The alpha cask's name is "Infinitary Alpha".
- **The install records the channel.**
  After every install, upgrade or reinstall, each cask writes its own `{"schemaVersion":1,"channel":"stable"|"alpha"}` to `~/Library/Application Support/infinitary/update-channel.json`, overwriting the other channel's: installing stable switches an alpha installation to stable even when both casks carry the same artifact, and the alpha cask carrying a stable version still writes alpha.
  Homebrew 6.0.15 and later use declarative `postflight_steps` with `write_file` and `base: :home`, which writes through a temporary file and a rename.
  The cask checks for `Homebrew::InstallSteps::DSL#write_file`; older Homebrew uses a legacy `postflight` block that creates the data folder and writes the same marker.
  Both paths support installs and upgrades, including an alpha cask carrying a stable version and channel switches.
  The casks are verified from Homebrew 5.1.13 through current; `postflight_steps` alone needs 5.1.14, but `write_file` needs 6.0.15.
  The release runs `brew style --except-cops=Cask/InstallSteps`: only the cop rejecting the required legacy block is excluded, and all other cops remain enabled.
  The update panel's command still runs `brew update` first.
- **Caveats.**
  The alpha notice, then the channel's own paragraph: which channel this is and how to switch with an ordinary uninstall and install, keeping saved work, never `--zap`.
  The alpha paragraph also says that a stable version which cannot open work saved by a newer alpha refuses without changing it (`docs/saved-data-compatibility.md`).
  The tap carries a stable cask only once it names a stable target, so until then the alpha paragraph names no stable cask: it says there is no stable channel to switch to yet, and never to add `--zap` when uninstalling.
  On Infinitary's own tap that holds from its first alpha to its first stable.
- **Typed inputs.**
  A cask takes a channel (stable when unset), a version the channel carries (stable `X.Y.Z`; alpha `X.Y.Z-alpha.N` or the stable version handed to it), a lowercase SHA-256 and the download, which must be a `.zip` asset of that version's release on the tap.
  The URL is written with Homebrew's `#{version}` interpolation, which `brew audit` requires, and reads back as the exact download.
- **The targets writer only moves forwards.**
  `advanceUpdateTargets` takes the tap's current `infinitary-updates.json` (or none) and one publication - channel, version, asset name, checksum, source commit - and returns the next file, refusing anything else:
  - an alpha publication carries an alpha version and moves only alpha, and only past both alpha's target and stable's;
  - a stable publication carries a stable version, moves stable forwards, and hands the same artifact to alpha when it is newer than alpha's target; a newer alpha stays, with stable still available on its own channel;
  - publishing the identical artifact again changes nothing, so a retry is safe; the same version with other bytes, asset or source commit is refused, because published bytes never change;
  - a late, older publication on either channel is refused, so alpha's target is never behind stable's;
  - a current file the reader would not accept is refused, never overwritten; the result is checked with the reader's own `parseUpdateTargets`;
  - on a tap with no targets file yet, the stable cask the single-channel workflow wrote is the floor (`caskVersion`): nothing publishes behind its version.
- **One tap commit.**
  `tapFilesFor` returns every file one publication writes: the targets file and the cask of each channel whose target moved, carrying exactly that target.
  A channel that did not move keeps its cask untouched, except that stable's first target also writes the alpha cask again at alpha's own target, so its caveats name the stable cask from then on; an identical retry writes nothing.
  From the command line:

  ```sh
  CHANNEL=alpha VERSION=… SHA256=… DOWNLOAD_URL=… scripts/generate-cask.sh   # one cask on stdout
  node scripts/tap-publication.ts advance --tap <tap checkout> --channel stable|alpha \
    --version … --asset … --sha256 … --source-commit … [--rehearsal]          # writes the files, prints a summary
  # --names firstmate (NAMES=firstmate for the cask) writes Firstmate 3000's tap instead ("The old-cask switch")
  node scripts/tap-publication.ts activation --tap <tap checkout>             # may a live alpha publish now?
  node scripts/tap-publication.ts republish --tap <tap checkout>              # both casks again at their targets ("Republishing the casks")
  ```

- **Activation.**
  A live alpha is refused until stable's target is a protected stable: newer than `LAST_UNPROTECTED_STABLE` (0.1.24, the last stable published before the saved-data guard and the channel-aware reader), so whoever leaves the alpha channel always has a stable to return to that refuses work it cannot open (`alphaActivationProblem`; "Activating the channels").
  The minimum protected stable is **0.1.25**, the bootstrap stable, live on both channels since 2026-10-01; from then on the check passes.
  Infinitary's own tap starts with no targets file after Firstmate 3000's stables, so there the newest stable the record of past releases names (`release-notes/archive.json`, 0.4.1) stands in for stable's target while the tap carries none: every stable the tap will carry numbers above it, so when it is protected a live alpha may publish before Infinitary's first stable.
  Until that stable (rename step 14) the alpha cask's caveats say there is no stable channel to switch to yet ("Caveats" above), and the switch appears with it.
  `advance --rehearsal` writes an alpha anyway and notes what a live one would meet.

## The signed channel workflow

The tap token is `HOMEBREW_TAP_TOKEN`, never `GITHUB_TOKEN`.

`.github/workflows/release.yml` publishes both channels through one pipeline (FI3-279 piece 4).
Merging it published nothing; the channels went live on 2026-10-01 ("Activating the channels").

- **One source commit.**
  The `channel` input is `stable` - the workflow's default - or `alpha`, and both are requested from main, so the workflow file is always main's.
  The `resolve` job (hosted Linux, no secret) runs `scripts/resolve-release.sh` from the workflow's own commit, in a clone with every branch and tag, and pins the source commit first.
  For an alpha it is the `candidate` ("Cutting an alpha"); for a stable, the `promote`d alpha's own commit ("Promoting an alpha").
  The verify lanes, the signing job and the private tag use exactly it, and the targets file records it.
- **One candidate.**
  A live alpha refuses to start without a `candidate`, a full commit id that main's history does not have to contain.
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
  Tags: private `v<version>` and public `infinitary-v<version>` or `infinitary-alpha-v<version>`.
  An alpha's two releases are prereleases, never "latest"; neither channel's public release claims the shared tap's "latest".
  `--latest=false` alone only declines to mark a full release: while no release is marked, GitHub shows the newest full release as latest anyway.
  So before a public stable is created, `scripts/publish-release-asset.sh` marks the release the tap shows as latest, then checks it still shows and marks it again if it moved.
- **Two version identities.**
  The packaged `package.json` carries the logical version (`-c.extraMetadata.version`), which the running app reports (`app.getVersion()`); `CFBundleShortVersionString` and `CFBundleVersion` both carry its numeric core, so nothing relies on macOS accepting a prerelease suffix.
  `scripts/check-app-launch.sh <app> <logical version>` proves them separately at every launch gate - the built app, the distribution zip, and both fetched-back copies: the two fields from the bundle, the logical version by asking the running app, on a throwaway profile, through its own healthcheck over Chromium's debugging port (`scripts/app-runtime-version.mjs`).
- **Linux in every release.**
  The `linux` job calls `linux-packages.yml` at the release's version on its one source commit, with the notes job's catalog, for both channels, a stable promotion included: it builds the Linux packages and installs and opens each on a clean copy of its system (`docs/linux-packages.md`) while verify runs.
  The signing job waits for it, lays out the Linux files (`linux-files`) and publishes them inside the same publication steps as the zip: the private record adopts any package a retry finds already published, the public release must match the record byte for byte, and both fetch-backs - the public one without a credential - compare every file and its sidecar before the tap commit writes the builds file.
- **Full alpha checks, inherited stable checks (FI3-482).**
  Every alpha, including a rehearsal, runs verify.yml's `linux-checks`, `linux-e2e` and `mac` lanes: hosted Linux typecheck, lint, adherence lint, unit tests and build; every Playwright journey on hosted Linux, in shards (`docs/testing.md`, "The Linux source desktop"); macOS unit tests, every Playwright journey, the installed Claude client check, the replay gate, and the development package with its signature, data-folder and bundled-git checks.
  Signing waits for all three.
  There is no Linux-only bypass.
  Performance grading stays on request (`verify.yml -f perf=true`).
  A stable omits verify and inherits its alpha's checks: the resolve job reads the published alpha's release run, found by its run number (the alpha's suffix), because a run dispatched from main records main's commit rather than the candidate it built.
  The stable's source is the alpha tag's own commit, so nothing differs from what that run checked.
  The run must have succeeded with every lane completed successfully in its latest attempt, each Linux journey shard included; otherwise the stable is refused, never verified again on its own.
  An alpha published before the Linux journeys joined verify has no `linux-e2e` jobs, so it is refused: promote a newer alpha.
  The resolve and signing summaries name the alpha and link its run, explicitly saying the lanes were omitted, not passed here.
  The conditional reusable-workflow call may show as skipped; its Linux and Mac lane jobs are absent, never green skips.
  An API error stops resolution rather than inventing assurance.
  The signing job is the same for both channels and repeats none of the lanes' checks: it starts at the build, then Developer ID signing, signed-app, launch and data-folder gates, notarization and stapling, the distribution zip's Gatekeeper and launch gates and checksum.
  Stable rebuilds new bytes, so all publication and fetch-back gates stay.
- **Release notes are checked first (`docs/release-notes.md`).**
  The `notes` job runs before `verify` or any signing, on the resolved source with full history.
  The candidate is the reviewed source: the job hands it to the check, which refuses a live alpha without it.
  Every published release before this one needs its record in `release-notes/releases/`, except the release being cut and the alpha a stable promotes.
  Every source change since the previous release needs a note or a reviewed exclusion; the release crewmate adds what is missing to its review commit.
  The job generates the offline catalog, the signing job packages it as `Resources/release-notes.json`, and the packaged copy's logical version and source commit are verified before notarization.
  A stable promotion proves `release-notes/` is identical to its alpha's, so promoted stables reuse the alpha's entries and ids; prose corrections need a new alpha.
  Its highlights are the captain's picks, written into the generated catalog by the workflow's own tooling ("Promoting an alpha").
  The publication itself changes nothing in the project, and a rehearsal pins nothing.
- **No local full e2e run before a cut.**
  The alpha’s own `verify.yml` Mac and Linux journey lanes are the full end-to-end runs.
  Full e2e runs are CI-only, including release preparation; request an additional run for any branch on GitHub's Actions page, or through `github_write` for the ref the crewmate's task needs (`docs/forge.md`, "Verification workflow requests").
  Locally, run only affected spec files (with `--no-deps` for renderer/application specs).
- **Failed alpha checks.**
  Nothing publishes.
  Automatic journey retries stay zero.
  When an outdated test fails, the release crewmate gets it fixed on main, brings its review branch up to date with main, and cuts a fresh alpha from the new candidate without asking again.
  Only when the failing journey passes alone on the same commit may the failed checks be manually re-run once, keeping the alpha's version; if they still fail, diagnose rather than retry again.
  No urgent-alpha bypass.
- **Published bytes never change** (`scripts/publish-release-asset.sh`).
  The private release is the record: its tag must name the source commit, and when it already carries the zip - a retry, whose rebuild never reproduces the same bytes - the published zip becomes the artifact, fetched back and gated like a fresh one.
  The tap's public release must then carry exactly those bytes, or the release fails.
  Nothing uploads with `--clobber`; a missing sidecar is added, a present one must agree.
- **One serialized tap commit** (`scripts/publish-tap.sh`).
  Only after the public download was fetched back without a credential and verified does the workflow clone the tap, have `scripts/tap-publication.ts advance` write the targets file and the cask of each channel that moves, check that the channel's target names the verified download and checksum, run `brew style --except-cops=Cask/InstallSteps` on those casks and push one commit.
  The push is the write boundary: when the tap moved meanwhile - another publication, or another tool on the shared tap - git refuses it, and the publication is read and written again from the tap's new state, so two publications never overwrite each other and a late, older one is refused.
  A real release is never cancelled to start another (each run is its own concurrency group, and verify inside a release cannot be cancelled from outside it); only a newer rehearsal of the same channel and ref replaces an older rehearsal.
- **Rehearsals publish nothing.**
  `-f dry_run=true` runs the channel's whole profile on any ref: its verify lanes, the Linux packages and their checks, every signing-job gate, and the tap commit it would make - casks, targets and builds file computed from the live tap's current state in a clone read without a credential, style-checked, and kept on the run as the `tap-rehearsal-<channel>-<version>` artifact, never committed.
  No tag, no release on either repository, no tap commit.
  The run's summary lists the profile's lanes and the ones it omits, every gate's outcome, both bundle fields and the version the running app reported, the tap files it would write, and the live-only stages a rehearsal does not exercise: both releases, the private and the unauthenticated public fetch-backs, and the tap commit.
  An alpha rehearsal before activation says a live alpha would be refused, and carries on.

## Republishing the casks

A publication writes the casks of the channels it moves with its own source commit's generator, so a change to how a cask is written - support for an older Homebrew, a reviewed change to the alpha notice - would otherwise reach a channel only when that channel next moves.
`.github/workflows/republish-casks.yml` closes that gap: main's generator writes both casks again at exactly the targets the tap already names.

- **Nothing moves.**
  `republishCasks` (`node scripts/tap-publication.ts republish --tap <tap checkout>`) renders each channel's cask at its current target and never writes `infinitary-updates.json`.
  It refuses a tap with no valid targets file, a target with no cask or a cask with no target, and a cask that installs anything but its channel's target - another version, other bytes or another download - because republishing never changes what a person installs.
  A cask that is already current writes nothing, so a repeated run is safe.
- **Downloads first.**
  `scripts/publish-tap.sh republish` fetches every target's download back without a credential and checks it against the target's checksum and the release's `.sha256` sidecar, then style-checks the casks with `brew style --except-cops=Cask/InstallSteps` and pushes one tap commit, `chore: republish firstmate-3000 casks`, with the same write boundary as a publication.
- **When it runs.**
  On every push to main that changes a file the casks are written from (the workflow's `paths`), and on demand; only main writes the tap, so merging such a change republishes both casks.
  A dry run (`gh workflow run republish-casks.yml --ref <ref> -f dry_run=true`) writes the casks it would commit in a scratch clone of the tap, keeps them on the run as the `tap-republish-rehearsal` artifact and pushes nothing; `scripts/publish-tap.sh republish-rehearsal` does the same from a working copy.
  Its optional `mac_runner` input selects a temporary runner for that dry run without changing `MAC_RUNNER`; publication ignores the override.
- **After an older publication.**
  A stable promoted from an alpha cut before a generator change writes that alpha's older casks for the channels it moves; republish on demand after it.

## The old-cask switch

People who installed Firstmate 3000 keep running the command they know, `brew update && brew upgrade --cask firstmate-3000` or `firstmate-3000@alpha`, and one of those updates installs Infinitary in its place (the captain's choice on FI3-1729; FI3-1780 steps 10, 13 and 14).
A Homebrew upgrade quits and removes the app the installed cask names and installs whatever app the new version names, so a Firstmate 3000 cask can carry Infinitary.
An installed Firstmate 3000 reads only Firstmate 3000's tap: its strict schema-1 update file, and only releases tagged `firstmate-3000-v<version>` or `firstmate-3000-alpha-v<version>` there ("Update channels").
So the switch publishes Infinitary under exactly those names.

- **Which channels switch.**
  `packaging/old-cask-switch.json` lists them: `{"schemaVersion": 1, "channels": [...]}`, read by the resolver from the workflow's own commit.
  It lists none until the captain's step 13 adds `alpha` and step 14 adds `stable`; from then on every Infinitary release of a listed channel switches that cask too.
- **What a switched release does.**
  After Infinitary's own tap commit, the release puts the same zip and Linux files on Firstmate 3000's tap, `kunchenguid/homebrew-tap`, under `firstmate-3000-v<version>` or `firstmate-3000-alpha-v<version>`, fetches them back without a credential, and moves that tap's casks, `firstmate-3000-updates.json` and `firstmate-3000-builds.json` in one commit (`scripts/publish-tap.sh` with `NAMES=firstmate`, `scripts/tap-publication.ts --names firstmate`).
  The token is `OLD_TAP_TOKEN`, never Infinitary's tap's own.
  The files keep their schema, so every installed Firstmate 3000 reads them.
- **What the switched casks install.**
  `firstmate-3000` and `firstmate-3000@alpha` install `Infinitary.app` and quit `com.getinfinitary.infinitary`; Homebrew quits and removes `Firstmate 3000.app` by the bundle the installed cask names.
  Their install step writes the channel marker into `~/Library/Application Support/infinitary/update-channel.json` with `"cameThroughOldCask": true`; Infinitary's first launch then moves the older folder in and keeps that marker (`docs/saved-data-compatibility.md`, "The one-time move").
- **What the switched app reads.**
  An installation whose marker says it came through the old cask reads Firstmate 3000's tap and names that cask's command, so it is offered only what the command it uses installs (`resolveUpdateTap`, `src/core/update/updateChannels.ts`).
  A Linux installation always reads Infinitary's own builds file: the app installs its own updates there, and Infinitary's packages replace, conflict with and provide `firstmate-3000` (`docs/linux-packages.md`).
- **A rehearsal writes it anyway.**
  Every dry run also writes, in a scratch clone of Firstmate 3000's tap read without a credential, the casks and update files a switched release of its channel would commit, and keeps them on the run beside Infinitary's (`old-cask-switch/` in the `tap-rehearsal` artifact).
- **Republishing stays Infinitary's.**
  `republish-casks.yml` writes Infinitary's tap only, and only from Infinitary's own repository's main; Firstmate 3000's casks move only with a switched release.

## Cutting an alpha

One release task cuts an alpha from one release candidate, checked once (captain, FI3-1057).
The release crewmate watches its accepted run with the short read described under "Promoting an alpha".
It never waits for main's own checks, which cancel each other as merges land: the release run checks the candidate itself.

1. **Review.**
   The release crewmate reviews the notes on its own branch, off main (`docs/release-notes.md` "Who writes what"), and adds there any missing note, exclusion or published release's record the check asks for.
2. **Commit and push.**
   It commits the review on that branch and pushes it.
   That commit is the candidate: main's code plus changes under `release-notes/` only.
3. **Dispatch.**
   `gh workflow run release.yml --ref main -f channel=alpha -f candidate=<the commit's full id>`.
   Merges that land on main meanwhile wait for the next alpha; nobody re-reads notes or follows main.
4. **Publish.**
   The run checks the notes, runs every lane on the candidate, signs and publishes; the private tag `v<version>` names the candidate and keeps it.
5. **Record.**
   On the same branch, the crewmate pins the release's record with `node scripts/release-notes.ts manifest --version <v> --write`, which pins the record of past releases again with it, and commits both.
6. **One pull request.**
   It opens one pull request that brings the review and the record to main.

A note the review adds names the change it describes in `covers`, so the note belongs to the same releases after the pull request is squashed onto main.

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
   It starts nothing until the captain picks, and his picks, lead first, are the run's `highlights`.
2. **Start.**
   `gh workflow run release.yml --ref main -f channel=stable -f promote=<alpha version> -f highlights=<lead>,<second>,<third>` (for example `0.1.31-alpha.40`, and the picked changes' entry ids).
   The resolver refuses unless the alpha has a private tag `v<alpha>`, its numeric core is newer than the latest stable, and it carries a feat, fix or breaking change since that stable.
   It also refuses a live stable without highlights, and highlights that are not one to three different entry ids.
   The resolve job then refuses unless the alpha's release run passed every lane in its latest attempt ("Full alpha checks, inherited stable checks").
3. **Release.**
   The run builds the alpha tag's own commit as the alpha's numeric core, `X.Y.Z`, signs and publishes it, and tags `vX.Y.Z` on that same commit.
   Its notes job writes the picks into the stable's catalog as its only highlights, in order, and clears every other rank (`docs/release-notes.md` "The release check").
   That step runs the tooling of the workflow's own commit, because the alpha's commit may predate it; the alpha's own `verify-package` then checks the result.
   It refuses a lead with no hero picture, a pick from outside the changes since the last stable, and a count of picks other than its slots: three, or one per change when there are fewer.
   The words of every change and `release-notes/` stay the alpha's.
   If a gate fails nothing publishes; dispatching the same promotion again keeps whatever that version already published.
   The public notes name the promoted alpha, and the private release names the picks.
4. **Record.**
   The stable's record rides with the next alpha's review commit, which the notes check asks for.
   It keeps the picks, as the stable's private release names them: `node scripts/release-notes.ts manifest --version <X.Y.Z> --highlights <picks> --write`.
   Pinning a promoted stable without `--highlights` is refused.

The next alpha is numbered from the new stable tag ("The signed channel workflow").
A stable rehearsal (`release.yml -f channel=stable -f dry_run=true`) promotes an alpha the same way, or builds the dispatched commit as the next stable when it names none, and publishes nothing.
It may leave `highlights` empty to keep the alpha reviews' ranks.

## Activating the channels

What "a release" means (captain, FI3-279 question 4, answered alpha): **a request for "a release" that names no channel means alpha**; "a stable release" names stable.
The workflow's own default stays stable for backward compatibility - a dispatch without a channel means stable, and a stable without `promote` is refused - so an operator always translates the request into an explicit channel: `-f channel=alpha` for "a release", `-f channel=stable` for "a stable release".

The channels went live on 2026-10-01 with the bootstrap stable **0.1.25** (FI3-364) and the first alpha **0.1.26-alpha.12** (FI3-360).
That stable is the minimum protected stable, newer than 0.1.24.

A routine release changes nothing in the project but its notes, keeps its evidence on its card, and closes when its one pull request merges ("Cutting an alpha").
When the first mate has the release re-verify crew filings older than the last release against the main line, the review's report names each key it checked, that key's fate (still needed, or covered by which key and evidence), and the keys it left unchecked; the Firstmate drops only what the review found covered (`docs/task-graph.md`, "What gets filed, and what closes it").

To cut a release, follow "Cutting an alpha": `gh workflow run release.yml --ref main -f channel=alpha -f candidate=<commit>`.
To cut a stable release, promote an alpha ("Promoting an alpha"); there is no release pull request.
"Promote the current alpha" is the captain's wording for a promotion.
To retry a failed stable, dispatch the same promotion again; it keeps whatever that version already published.
A failed alpha is retried with the run's "Re-run failed jobs", which keeps its version, or superseded by a new request.

## The alpha notice

`packaging/alpha-notice.txt` is the one home.
It reads on the cask's caveats at install time and on every public release's notes.
A change to it is a change to what every alpha user is told, so it is a normal reviewed change, never an edit in the tap.
Since 2026-09-22 it discloses Diagnostics - the events, the random install ID and its reset - and the opt-out; `tests/release-contract.test.ts` pins those phrases, so none can drop out of the notice while Diagnostics ships.

## Versions

The alpha ships as 0.x and the public beta stays 0.x (captain decision 2026-09-21); there is no 1.0.0 at the beta gate.
A breaking change takes the next minor, never the next major, so every release stays on the 0.x line.
The tag stays bare (`vX.Y.Z`, never a component prefix) and the cask's version is read off it.

Versions live in tags alone ("The signed channel workflow"): an alpha is the newest stable tag's next patch or minor, numbered by the workflow run, and a stable is its alpha's numeric core.
A repository that starts again from one commit has no tags of its own; it numbers from the record of past releases instead, above every version either channel published before it, and never tags an archived version (`docs/release-notes.md` "A fresh history").
`package.json`'s version and `CHANGELOG.md` stopped changing at stable 0.1.30; do not hand-edit either.
Plain merge titles are refused.
A stable with nothing to release is the captain's call.

Which release first carried a change is read from its commit, never from a date: `git merge-base --is-ancestor <commit> v<version>` answers it for each fetched tag, and a stable carries exactly what its alpha's commit does.
An installed app's version is the logical one in the `package.json` inside its `app.asar` (the running app's `app.getVersion()`); Get Info and `Info.plist` show only the numeric core ("Two version identities" above).
The build that showed a given card is in that card's observations (`card_observations.build`, `docs/card-evidence.md`).

## Operator steps (the captain's, once)

1. Make sure the product repository carries the repository secret `HOMEBREW_TAP_TOKEN` (Contents read and write on `infinitary-labs/homebrew-tap`; it both publishes the release there and pushes the cask), `OLD_TAP_TOKEN` (the same on `kunchenguid/homebrew-tap`, for the old-cask switch: a fine-grained token cannot span both owners) and the five Apple secrets of `docs/architecture.md` section 10.
   No repository is created.
   `tests/release-contract.test.ts` pins the names.
2. Before a channel's release stages first run for real, or after they change, rehearse them on `main`: `gh workflow run release.yml --ref main -f channel=<stable|alpha> -f dry_run=true` (with `-f candidate=<commit>` or `-f promote=<alpha>` to rehearse what a live run resolves) runs the channel's verify lanes, packages and signs, runs the signed-app and launch gates, notarizes and staples, builds the distribution zip with its Gatekeeper and launch gates, computes the checksum and writes and style-checks the casks and update targets it would commit, in a scratch clone of the tap - and publishes nothing (no tag, no release on either repository, no tap commit; `tests/release-contract.test.ts` "the signed channel workflow" pins which steps a rehearsal runs).
3. Stable: promote an alpha ("Promoting an alpha"); `release.yml` runs the stable profile, signs, notarizes, publishes the private release and the tap's `infinitary-v<version>` release, fetches the public one back without a token, and writes the casks and update targets.
   Alpha: cut it from its candidate ("Cutting an alpha").
   After it publishes, the release crewmate pins that release's record on the candidate's branch and opens one pull request.

## Before the public beta

A checklist the beta gate walks, each item dated when it was added.
An item is done when its result is recorded where it names; it is never ticked here.

- [ ] **Re-read Anthropic's pages on the Claude seat** (added 2026-09-26, the owner's Q8 a on W1: the Claude seat ships in every build, and the beta re-reads the terms).
  Read the Claude Agent SDK overview, Anthropic's legal and usage page, and the Help Center's usage-limits note again.
  Record the reading as a new dated entry under "The terms" in `docs/architecture.md` §16.1 - never an edit of an older one - and confirm the Claude seat still ships, or escalate to the captain before the beta.

## Evidence

- `tests/release-contract.test.ts` "the private alpha": the generator refuses a private, foreign or other-release URL, the homepage and URL are the public tap's, the caveats are the notice verbatim (folded), the workflow publishes the app-prefixed release on the tap and fetches back without a token, and - wherever Homebrew is installed, so on every macOS run - the generated cask passes `brew style --except-cops=Cask/InstallSteps`.
- `release.yml` publishes the public copy and the gates on that copy are the proof a community install works.
- Casks and update targets: `src/core/update/tapPublication.test.ts` pins both casks, the marker step, the caveats, every refused input and the writer's forward-only rules over shuffled publication orders; `tests/release-contract.test.ts` runs `generate-cask.sh` for both channels and `brew style --except-cops=Cask/InstallSteps` on both casks; `tests/cask-consumers.test.ts` (macOS with Homebrew) taps the CLI's output into a scratch clone of the installed Homebrew - its own prefix, HOME, trust store and Applications folder, offline, the stand-in app's own bundle id - and installs, refuses, upgrades and switches through alpha, stable handed to alpha, the stable switch and back, checking the marker, the seeded saved work and the app's own update reader at each stage.
- The signed channel workflow: `tests/release-contract.test.ts` "resolving a release" runs `scripts/resolve-release.sh` on stand-in clones - a candidate on main, a notes-only candidate off it and a refused code change, alpha numbering from the newest stable tag, a fresh history numbered from its record of past releases, a promotion on the alpha's own commit, and every refusal - and "the signed channel workflow" evaluates both workflows through GitHub's own expression evaluator - both alpha lanes, the inherited or refused stable evidence and fail-closed signing conditions, a signing job that starts at the build, the concurrency groups, which steps a rehearsal and a live release of each channel run and which hold a publication token - and (on macOS) the launch gate's refusal of wrong bundle fields; `tests/release-publication.test.ts` runs `scripts/publish-tap.sh` against a stand-in tap for activation, the transition floor, alpha-only and both-channel publications, a late older stable, retries, refusals that leave the tap untouched, a push race and a rehearsal, and `scripts/publish-release-asset.sh` against a stand-in `gh` for creation, adoption of a published record, refusal of different public bytes and a mismatched tag or sidecar, and a stable that leaves the tap's latest badge where it was, even when GitHub moves it anyway; `tests/e2e/phase0-guardrails.spec.ts` runs the launch gate's version probe against the running app.
- Republishing the casks: `src/core/update/tapPublication.test.ts` "republishing the casks" pins both casks rewritten at their targets, a reviewed notice carried to both, a second run that writes nothing and every refusal; `tests/release-publication.test.ts` "republishing the casks on the tap" runs `scripts/publish-tap.sh republish` against a stand-in tap and a stand-in `curl` - one tap commit with the targets file untouched, every download and sidecar fetched once with no credential, other bytes, a disagreeing sidecar, a missing download and a cask that installs another version refused with the tap untouched, a push race and a rehearsal; `tests/release-contract.test.ts` "the cask republication workflow" evaluates `republish-casks.yml`'s triggers and which steps a live run on main and a dry run anywhere take, and which hold the tap token; `tests/cask-consumers.test.ts` has a held stable refuse the casks an older generator wrote (on Homebrew before 6.0.15) and upgrade once the CLI republished them at the same targets.
- Update channels: `src/core/update/{semver,updateChannels,updateChecker}.test.ts` pin precedence, the marker fallback, target validation, per-channel offers, the rollout reader and failure handling; `tests/release-contract.test.ts` "update indicator alignment" ties the stable command and target to the cask the generator writes; `src/renderer/src/app/UpdateIndicator.test.tsx` pins the panel's wording; `tests/e2e/update-channels.spec.ts` runs the real app against a stand-in tap for alpha to alpha, through the update indicator to the release page, and for a Mac controlling a newer Infinitary on another Mac (pictures go to the run's own results folder).
- The old-cask switch: `src/core/update/tapPublication.test.ts` "Firstmate 3000's casks after the old-cask switch" pins the cask that installs Infinitary under the old token with its marker, and the old update file moved to releases an installed Firstmate 3000 accepts; `src/core/update/updateChecker.test.ts` keeps an installation that came through the old cask on that tap and command; `tests/release-publication.test.ts` runs `scripts/publish-tap.sh` with `NAMES=firstmate`; `tests/release-contract.test.ts` pins the switch file, the resolver's names and the order of the switch's steps.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.
The update reader described here as listing the tap's releases is now the stable rollout fallback; "Update channels" above is current.

- The private alpha (roadmap 1.2, captain decisions 2026-09-21; `docs/alpha.md` is the one home): `brew install --cask kunchenguid/tap/firstmate-3000` from the captain's EXISTING public tap while the product repository stays private through the beta gate.
  Homebrew fetches a cask's URL unauthenticated, so the artifact is published as a release on the PUBLIC tap itself (`release.yml`, `TAP_REPO`, token `HOMEBREW_TAP_TOKEN`, never `GITHUB_TOKEN`; no separate releases repository) under the app-prefixed tag `firstmate-3000-v<version>` because the tap is shared - the product repository keeps its bare `v` tag and its private release the same artifact as the record; `scripts/generate-cask.sh` REFUSES a download URL anywhere but that release (the private product repository above all), the workflow fetches the public asset back with `curl` and no token and runs the signed-app and launch gates on that copy before `brew style --except-cops=Cask/InstallSteps` reads the cask and the tap is updated, and `updateChecker.ts` lists the tap's releases and reads only `firstmate-3000-v` tags - never the shared tap's `/releases/latest`.
  The cask token is `firstmate-3000`, never the codename; the one-paragraph alpha notice is `packaging/alpha-notice.txt`, the cask's caveats and every public release's notes, and it discloses Diagnostics - the events, the random install ID and its reset - and its opt-out (a reviewed change, pinned by the release contract).
  `tests/release-contract.test.ts` "the private alpha" pins all of it and runs `brew style --except-cops=Cask/InstallSteps` wherever Homebrew is installed.

### Checking older Homebrew consumers

`INFINITARY_CASK_HOMEBREW_VERSIONS=5.1.13,5.1.14,6.0.14,6.0.15,current pnpm test tests/cask-consumers.test.ts` runs both journeys on each version: the install, upgrade and channel-switch journey, and the upgrade through casks republished at their targets.
The source Homebrew repository must already contain those tags and their matching vendored Ruby versions; the test checks them out only in its scratch clone and never fetches or updates the source.
For archived versions with different Ruby requirements, run each version separately with `INFINITARY_CASK_HOMEBREW_REPOSITORY=<prepared-repository>` pointing at an offline-ready Homebrew copy for that tag.
Without that variable the test uses the installed version.
Every version runs with `HOMEBREW_DEVELOPER=1`, so current Homebrew also proves the deprecated block is not evaluated.
