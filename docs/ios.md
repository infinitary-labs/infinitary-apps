# Infinitary on iPhone and iPad

The native SwiftUI app lives in `ios/Infinitary/`, supports iPhone and iPad from iOS 18, and reads a Mac through the published connection contract.
Its name is Infinitary, its bundle identifier is `com.getinfinitary.infinitary`, and its Xcode development team is `9T2J7MNUP9`.
This is the join-and-read foundation of the accepted phone plan, not a separate first mate or a place that runs work.
The phone shows Cards and Activity read-only; it does not run card HTML, scripts, actions or replies, and has no Talk or Tasks controls.
The version-dispatched TestFlight workflow and the square app icon support internal delivery; App Store distribution, background notifications, the character and a side-by-side iPad layout remain separate work.
The visual rules live in the design skill's `components/devices/PhoneView.prompt.md`.

## Joining and trust

Settings → Devices → **A phone** on the Mac opens a locally generated QR code, the same one-use computer link, Copy link and Stop it.
Every build of the Mac app offers **A phone**, installed and development alike (`docs/devices.md`, "Settings -> Devices").
The panel explains that the phone app comes from TestFlight for now, only to the people asked to test it, and is not in the App Store yet.
A phone can scan that code, paste its link or open an `infinitary://join` link, then confirms the address of the Mac it is joining.
Nearby browses `_infinitary._tcp` and opens the scanner; an announcement supplies a possible address, never a key or permission.
The Mac announces while a usable direct computer invitation is open as well as while a phone is on its list, so first-phone discovery works.
Camera and Local Network permissions have separate explanations; a camera refusal offers pasting rather than reading the clipboard automatically.

`InfinitaryKit` owns strict link parsing, the device identity, pinned transport and the read-only session.
`PhoneIdentity` creates a P-256 signing key and a self-signed certificate, with Apple's `swift-certificates` package supplying the certificate encoder.
The private key and certificate live in this app's iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and synchronization disabled, not in iCloud, a shared group or the Secure Enclave.
If the key exists without its certificate, the app issues a certificate for that same key rather than rotating or abandoning the identity.
The certificate's public key hashes to the same SHA-256 SPKI pin the Mac owns (`docs/devices.md`, "Keys").
The Mac's identity is that pin, not the self-signed certificate's name or dates.

`PinnedTransport` uses an ephemeral URLSession, TLS 1.3, the phone's client identity and the exact saved or scanned server pin, with no cookies, credential store, proxy configuration, cache or redirects.
Pairing has short request deadlines; the socket uses a separate configuration whose deadlines outlast its heartbeat, not the pairing POST's timeouts.
A join sends the invitation's kind and `system: "ios"`; the Mac returns HTTP 201 and kind `view` regardless of that invitation's computer kind.
Only DNS and connection failures that prove no connection opened try the next advertised address.
A timeout or missing reply never repeats a pairing request: the Mac may already have spent its code.
An explicit `paired` refusal leaves a fresh invitation unspent, so that one confirmed invitation may use `again` once to recover the same phone identity.
A wrong pin never sends the invitation to that address or replaces the saved pin.

The only saved app record is `JoinedMac.json`: public Mac addresses, pin, device identifier and name.
It has file protection and is excluded from backup; no invitation code, card, feed line or cursor is saved there.
The Keychain identity survives relaunch, Leave and local Forget; it is never replaced because the network is unavailable.
Protected identity and saved-Mac reads start on activation, not prewarm, and a failed read is retried on activation or joining with a visible explanation if it still fails.
A saved-Mac read suggests unlocking only for `CocoaError(.fileReadNoPermission)` or unavailable protected data; other temporary read failures retain the record and offer another attempt.
An undecodable record, invalid pin or invalid address discards only the saved Mac, retains the phone's identity, explains the local reset and allows a fresh confirmed link.

## Reading and returning

The session sends a view hello and its current in-memory epoch/sequence cursor, and asks only `inf:cards:list` and `inf:feed:recent`.
Card bodies are never rendered or executed; the list shows titles and attribution.
Activity shows the newest line first and uses the Mac's feed wording, not a second event-to-words implementation.
The native contract constants are generated from `docs/contract.json` with `node scripts/generate-phone-contract.ts`.
`pnpm generate:contract` updates them together, and `pnpm check` refuses stale native constants or theme values.
Generation also verifies the required card fields (`id`, `title`, `author`) and feed fields (`kind`, `text`, `at`), including the pushed card snapshot.

A return consumes numbered replay pushes, or reads fresh snapshots after a reload welcome.
Both initial snapshots must arrive before the app says **In reach**.
A card push supplies the new snapshot directly and supersedes any older initial read still in flight.
Only a closed list of non-streaming events that can change the feed requests a coalesced feed refresh; assistant and thinking deltas cause no reads.
The feed owner exports `FEED_EVENT_TYPES`, with its authoring switch checked exhaustively against that list, and the contract generator derives the Swift `FeedChange` enum from it.
A gap in numbering drops the cursor and reconnects rather than silently losing updates.
Successful frames and pongs update the last-heard time; bounded handshake, welcome, read, Leave and heartbeat waits cut a stalled connection.
The watchdog starts before sending hello and cancels the transport too, so a stalled TLS handshake does not inherit the socket's longer lifetime.
The app keeps only its in-memory view while out of reach and shows its last-heard time.
Background cancels the old connection generation, and activation starts it again; an inactive scene such as Control Center does not disconnect.
A late callback from an old connection cannot clear or overwrite a newer connection.
Nearby addresses may be tried with the original pin, and only an authenticated address is saved as preferred.

Leave is available in reach and asks for confirmation, sends the connection's Leave frame, waits for removal and forgets the saved Mac.
Out of reach, **Forget this Mac** asks for confirmation and clears the saved Mac and pin locally without claiming the Mac removed the phone.
A removal close or repeated authenticated refusal clears cards and feed, forgets the Mac, and offers joining with a new link.
A failed address with no HTTP response does not erase an earlier authenticated refusal; a welcome or a different HTTP response does.
Neither reconnection nor discovery queues or retries a mutation.

## Installing on a phone

The captain installs Infinitary through TestFlight, not Xcode.
Once a build is in internal testing, Apple emails each tester in the app's internal group an invitation.
On the phone, the tester opens Apple's TestFlight app with the Apple Account in that group, accepts the invitation and installs Infinitary; automatic distribution offers each later build there too.
The phone and Mac need a network route to one another and a Mac build that accepts `system: "ios"`.
Open **A phone** in the Mac app's Devices settings, scan or paste its link in the phone app, and confirm that Mac.
The phone should name the Mac and show In reach, its Cards and Activity.
TestFlight installation, camera scanning and the real Local Network prompt are the captain's checks on a physical phone.
Someone working on the phone app can still run it on their own iPhone or iPad from `ios/Infinitary/Infinitary.xcodeproj` with the Infinitary scheme and their own development sign-in.
Release signing runs only in the separately dispatched TestFlight workflow below.

## TestFlight releases

`.github/workflows/ios-release.yml` is dispatched from merged `main` with a numeric phone `version`, such as `0.1.0`.
A branch dispatch is refused before Apple is contacted.
Every job checks out the same full source commit recorded by the dispatch; the phone version is independent of the Mac's version and does not edit a version file or create a desktop release tag.
The build number is the workflow run number followed by `.1`, such as `42.1`; validation refuses a run beyond 9999 rather than exceeding Apple's four-digit first component.
The Mac job refuses release-job reruns immediately after Node setup, before dependency installation or either exclusive simulator lease; the upload command checks again before Xcode runs.
GitHub can preserve an earlier resolve job's outputs while advancing another job's attempt, and an unclear upload must not be renumbered or resubmitted.
A status-only request remains safe to rerun because it never uploads.
A fresh dispatch creates another build, not a retry of a prior upload.

The Linux preflight reads App Store Connect with the existing `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and base64-encoded `APP_STORE_CONNECT_API_KEY` secrets.
It requires exactly the app record named **Infinitary** for `com.getinfinitary.infinitary`, the registered bundle identifier, and an internal TestFlight group with automatic distribution and a configured, non-revoked tester.
Apple's identifier filters can return prefix matches; the preflight selects exact identifiers before requiring one match.
Apple sends the TestFlight invitation only after a build is available, so `NOT_INVITED` and `INVITED` are valid preflight states, not proof of installation ([Apple's internal-testing instructions](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)).
These preflight reads use GET only; they create no app record or tester and change no account permissions.
It signs short-lived requests in memory, refuses redirects or pagination to another host, and prints neither credentials nor tester identities.
A successful read proves app access, not permission to manage signing; Xcode checks that authority during the archive.
A configured tester somewhere in the group is not proof that the captain accepted an invitation or installed the app.

The captain's one-time Apple setup is:

1. In Apple Developer → Certificates, Identifiers & Profiles → Identifiers, register the explicit identifier `com.getinfinitary.infinitary` for team `9T2J7MNUP9` if it does not exist.
2. In App Store Connect → Apps → + → New App, choose iOS, name **Infinitary**, a primary language, the registered identifier, a stable SKU such as `infinitary-ios` and Full Access.
   An existing record must have that name and identifier, and the API key must have access to it.
3. In that app's TestFlight tab, press + beside Internal Testing to create a group, or select one, enable automatic distribution, and add the captain with Invite Testers.
   Accept its TestFlight invitation once the first build is available; that acceptance is not an upload prerequisite.
   A missing eligible tester is managed through App Store Connect → Users and Access, not by this workflow.
4. Keep the three existing repository secrets set to a team key authorized for the app and Xcode automatic signing.
   The private-key secret contains base64 of the downloaded `.p8` file, never a value pasted into a task or a command argument.

After preflight, the existing disposable iPhone and iPad gates run on `MAC_RUNNER`, falling back only to `mini-mac`.
Either failure prevents archive and upload; iPad still runs after an iPhone failure unless cancelled.
The release job shares the `mac-mini-phone` queue, and each device gate and the release command use the existing exclusive command lease while desktop jobs retain their parallel queues.
The job allows the native lane's 165 minutes, which include waiting behind local phone gates that took the entry lock first, plus 60 minutes for release work; this changes no test deadline.
Install-time checks use a scratch HOME and an empty local-signing directory, as in `phone.yml`.

`scripts/release-phone.sh` uses ordinary Xcode automatic signing on the existing Mac runner with the same Apple team and API key as SSHHIP.
This CI path is captain-approved; it is not permission for a crewmate to sign locally or inspect the person's keychains.
There are no explicit `security`, Keychain or `codesign` commands; Xcode may reuse an existing development certificate rather than create one.
After a confirmed upload, `scripts/phone-certificates.ts` lists safe cleanup candidates inside the release command's existing exclusive lease.
Only a runner named `mini-mac` or starting `mini-mac-` may select candidates, and an archive without a signing fingerprint selects nothing.
It protects every SHA-1 signing identity printed by archive and export, including nested targets, rather than just the last identity.
It reads all certificate pages through the existing host-checked App Store Connect reader, with a ten-page bound; malformed or incomplete listings fail closed.
A candidate must be a `DEVELOPMENT` certificate whose X.509 subject common name is exactly `Apple Development: Created via API (<this release key ID>)`, whose fingerprint is not protected, and whose X.509 `notBefore` is strictly more than 24 hours old.
The key ID in that naming convention is an inference from INF-259, not an Apple creator field; an unrecognised name is always kept.
Apple supplies no certificate creation date, so cleanup never sorts on `createdDate` or expiration.
The release entry point is list-only with no revocation input or environment switch: the first real candidate list appears in the job log and summary for the captain to read.
Revocation stays off until the captain reviews that list and a separate reviewed code change wires the revocation callback.
A listing failure leaves the accepted upload receipt intact and never retries upload.
This changes only Infinitary; SSHHIP and Eddie's Wallet have separate cleanup implementations.
The key is written with mode 0600 inside this invocation's owned mode-0700 temporary folder and supplied to Xcode by file path.
The uploader receives that exact file through `--p8-file-path`, bypassing its earlier working-directory and HOME search locations rather than relying on the last-searched `API_PRIVATE_KEYS_DIR`.
Archive, derived data, export and key cleanup run on exit, with an `always()` cleanup for the known invocation path; local verification uses only unsigned simulator runs and unsigned packaging rehearsals.
A force-killed job can interrupt cleanup, so the final cleanup and runner's temporary-directory lifecycle both matter.
The archive gate reads the built app's name, bundle identifier, version, build, iOS platform, compiled icon, all four iPad orientations and encryption declaration before export.
`ios/ExportOptions.plist` selects automatic App Store Connect export and disables automatic version/build renumbering.
Exactly one exported IPA is accepted for a single upload attempt; no upload is automatically retried.

The `phone-release-<version>-<build>` artifact keeps native results and a non-secret upload receipt, not keys, signed archives or unredacted signing logs.
An `attempted` receipt means the outcome is unknown; `accepted` means the uploader accepted it for processing, not that it reached a phone.
The final Linux job reads the exact marketing-version/build pair until Apple reports it in internal beta testing, for up to 60 readings separated by 30 seconds.
Rejected, expired or unknown states fail explicitly, and export-compliance holds name Apple's required action rather than uploading again.
A processing timeout or uncertain upload is checked by dispatching the same workflow with `version` and `check_build` set to the existing build number.
That mode performs only Apple reads, runs no Mac job and never uploads.
Apple's internal-testing state means testers can install the build, not that a phone has; a tester's installation through TestFlight is that check, and no Xcode installation is required of the captain.

## Disposable verification

`pnpm test:phone --evidence <absolute-folder-outside-the-project>` takes the same exclusive lease as CI's native gate, waiting behind pull-request journeys and CI phone gates, then runs the foundation's native gate on a Mac with Xcode, Swift 6.1 or newer, and an iOS 18 or newer simulator runtime.
Add `--ipad` for the iPad Pro 11-inch (M4); the default uses an iPhone 16.
Add `--demo`, with FFmpeg installed, to keep a real-speed reconnect/catch-up recording and its poster beside the test results.
The recording crops the top of the phone view around the connection state and first two cards; it retains real speed and holds the final frame for two seconds.
The runner creates and deletes its own simulator, scratch HOME, real-core home, mock provider, data and keys, never borrows or erases a person's simulator, and saves logs and the result bundle outside the working copy.
The test home uses the real stores, dispatcher, pairing and TLS connection, with sample cards, feed lines and a task; its control interface listens only on loopback behind a fresh per-run token.
The simulator-only `INFINITARY_ISOLATED_PHONE_TEST` environment value disables real Bonjour browsing, so an offline fixture never causes attempts against a person's discovered Macs; physical discovery remains a captain check.
It first verifies the independent published-contract client can join and read the sample card.
The native journey covers a wrong Mac pin, joining, cards and feed, identity across relaunch, out-of-reach state, catch-up after a home restart, background/foreground replay, Leave, local Forget and Removed.
The home records read and connection counts across streaming, pushed card revisions and an idle period longer than both pairing deadlines.
The journey also checks Control Center and removal while away with an owned endpoint that stalls TLS between authenticated refusals.
The launcher truncates the actual saved Mac only inside its owned simulator's app container; the same journey captures the damaged-record explanation and joins again with a fresh confirmed link.
Each journey starts from its own fresh home and simulator; the Xcode scheme's `PHONE_TEST_HOME` setting names that home's private control interface.
Native package tests exercise the Mac-produced link and certificate fixture and certificate/public-key compatibility without using a Mac Keychain.
App-hosted tests repair a missing certificate in the disposable simulator's own Keychain and inject protected-data read failures to check retry and the joining explanation.
They refuse to run on a physical device, and the iOS identity API itself refuses creation on macOS.

Unsigned simulator tests need an application identifier to use the simulator's own Keychain.
`SimulatorTests.xcconfig` disables signing and injects `Simulator.entitlements` into the app's simulator-only `__TEXT,__entitlements` section through the linker.
This is simulator metadata, not a signature: no `security` or `codesign` command, signing identity, profile, certificate lookup or keychain search-list change is involved.
Normal device builds use Xcode's own signing settings and do not include this test configuration.
The runner waits for simulator boot completion before launching tests and uses one test worker.

For interactive local development, `node scripts/phone-test-home.ts <output-json-outside-the-project>` keeps the same disposable real-core home open until interrupted.
The output names its control address and scratch root, and is private to that run.
`phone.yml` runs this same gate on iPhone and iPad for pull requests touching `ios/` or the phone-contract generator and its shape guard.
The gate's own setup also selects it: `phone.yml`, `scripts/test-phone.ts`, `tests/helpers/phoneHome.ts`, `scripts/phone-test-home.ts`, `scripts/affected-phone.ts`, its command-lease helper `scripts/with-mac-check.py` and its replacement helper `scripts/replaced-phone-runs.ts`.
Shared modules, connection/device code, general packages and the lockfile alone do not select it; a changed generated Swift file does, unless it changes only its `public static let version` line, which includes a new first number: the phone and the computer come from the same pull request, so they always agree on it, and `docs/contract.json` alone never selects the gate.
Every pull request still checks on Linux that the generated file is current, through `pnpm check` (`node scripts/generate-phone-contract.ts --check`).
Its Linux chooser reads the full git comparison with `scripts/affected-phone.ts`; an unreadable comparison runs the gate, and an unrelated change explicitly skips the native job.
The native job uses `MAC_RUNNER`, falling back to the `mini-mac` label rather than a paid hosted Mac, and retains result bundles, logs and connection readings as `phone-results`.
Its package install also uses a scratch HOME and an empty local-signing directory, so the install-time signature check never reads this Mac's signing material.
A newer push never waits behind its pull request's older phone run: `phone.yml` has no run-level concurrency group.
Its `cancel-replaced` job cancels the pull request's older phone runs whose native job has not started a device gate, so a replaced version gives up its place in the Mac mini's line (`scripts/replaced-phone-runs.ts`).
A device gate that already started is never cancelled; it finishes and deletes its own simulator.
No simulator exists right before either gate, so there a replaced version cancels its own run instead of starting the gate; a failed reading of the pull request runs the gate.
That check also stops a manual rerun of a replaced version, which no newer run cancels, about a minute after it reaches the Mac mini.
Only native jobs share the repository-wide `mac-mini-phone` concurrency group, with `queue: max` and cancellation disabled at the job level; GitHub keeps up to 100 pending phone jobs.
Desktop jobs from different pull requests have no common job-level concurrency group, so they can run side by side.
On the Mac, `scripts/with-mac-check.py` gives the desktop build/test command a shared kernel file lease and each native device gate an exclusive one.
The `test:phone` package script takes that lease around `scripts/test-phone.ts`, and the script never takes it, because CI already wraps the script and a nested exclusive lease waits forever; the script also swaps `HOME` for a scratch home before anything else runs.
The runner slots and a crewmate's `pnpm test:phone` use the same account and `$HOME/Library/Caches/infinitary-ci/checks.lock`; active desktop commands finish before a phone enters, and a waiting phone prevents new desktops passing it.
The helper replaces itself with the command and retains the lease descriptor, so command exit or cancellation releases it without stale markers or a daemon; lock files are never unlinked.
Phone gates can yield to desktop work between iPhone and iPad.
The native job's 165-minute limit allows 45 minutes for both device gates, 105 across admission waits and 15 for setup, cleanup and evidence upload; it changes no test deadline.
The admission allowance covers the CI job waiting behind active desktop journeys (60 minutes) plus two local phone gates (45 minutes) that took the entry lock first.
Setup, evidence upload, the choosers and Linux jobs remain independent.
Neither device's failure is ignored, and iPad still runs after an iPhone failure unless the job was cancelled or a newer push replaced its version.
This pull-request lane neither signs a physical-device build nor publishes one; `ios-release.yml` runs the same native gates before its separately dispatched TestFlight upload.
Mac-side checks remain the project's normal gate and affected Devices journeys.

## Generated and bundled assets

The phone's `Assets.xcassets/AppIcon.appiconset` contains a flat, opaque 1024-pixel render of the existing design asset `.claude/skills/infinitary-design/assets/app-icon.svg`.
Unlike the desktop package icon, it has no inset or baked-in corner mask; iOS supplies its own shape.
`scripts/render-phone-icon.mjs` renders that source through a hidden Electron window and writes an RGB PNG with no alpha channel, as Apple requires.
To regenerate it, create an empty temporary folder outside the project, set `HOME`, `CFFIXED_USER_HOME` and `INFINITARY_ICON_HOME` to that folder, set `INFINITARY_LOCAL_CODESIGN_DIR` to an empty child of it, then run `node_modules/.bin/electron scripts/render-phone-icon.mjs`.
The renderer never launches the product or reads its saved data.
The app bundles BoringSSL as a dependency of `swift-certificates`, which builds the phone's self-signed sign-in certificate using a CryptoKit P-256 key.
Connections use iOS `URLSession` TLS in `PinnedTransport`; bundled BoringSSL does not provide the app's TLS transport.
`ITSAppUsesNonExemptEncryption` remains false for this sign-in and secure-connection use; revisit the declaration whenever the cryptography or its uses change.
The release-tool tests exercise version validation, Apple readiness and processing reads, the workflow's actual conditions, and archive/export/upload through disposable stand-in commands.
They run in the existing Linux PR cohorts; no secret or signing access is needed.
Set `INFINITARY_PHONE_RELEASE_EVIDENCE` to a folder outside the project to retain their non-secret command transcripts; the stand-in uploader's success is never proof of a real Apple upload.

`node scripts/generate-phone-theme.ts` copies light/dark values, spacing and radii from the design skill into adaptive native colors and lengths.
The native TTF fonts are format-only conversions of the skill's Latin Space Grotesk and JetBrains Mono WOFF2 assets, retaining their original names and outlines.
To regenerate them with FontTools and Brotli installed in a disposable Python environment, load each WOFF2 with `fontTools.ttLib.TTFont`, set `flavor = None`, and save it to the matching file under `InfinitaryApp/Fonts/`.
The app includes their SIL Open Font License notice and the Apple packages' license and notice files.
Swift package versions and revisions are pinned in the package and Xcode workspace lockfiles.
