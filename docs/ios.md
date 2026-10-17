# Infinitary on iPhone and iPad

The native SwiftUI app lives in `ios/Infinitary/`, supports iPhone and iPad from iOS 18, and reads a Mac through the published connection contract.
Its name is Infinitary, its bundle identifier is `com.getinfinitary.infinitary`, and its Xcode development team is `9T2J7MNUP9`.
This is the join-and-read foundation of the accepted phone plan, not a separate first mate or a place that runs work.
The phone shows Cards and Activity read-only; it does not run card HTML, scripts, actions or replies, and has no Talk or Tasks controls.
TestFlight, App Store distribution, the app icon, background notifications, the character and a side-by-side iPad layout belong to later work.
The visual rules live in the design skill's `components/devices/PhoneView.prompt.md`.

## Joining and trust

Settings → Devices → **A phone** on the Mac opens a locally generated QR code, the same one-use computer link, Copy link and Stop it.
A packaged build leaves **A phone** out until the phone app is on TestFlight, so only a development build of the Mac app offers it (`docs/devices.md`, "Settings -> Devices").
The panel explains that the phone app is installed from Xcode for now.
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

## Xcode installation

The captain opens `ios/Infinitary/Infinitary.xcodeproj`, chooses the Infinitary scheme and their iPhone or iPad, and runs it with their own development sign-in.
The phone and Mac need a network route to one another and a Mac build that accepts `system: "ios"`.
Open **A phone** in the Devices settings of a development build of the Mac app (an installed build leaves it out until TestFlight), scan or paste its link in the phone app, and confirm that Mac.
The phone should name the Mac and show In reach, its Cards and Activity.
Physical-device signing, installation, camera scanning and the real Local Network prompt are the captain's checks, never unattended signing work.

## Disposable verification

`pnpm test:phone --evidence <absolute-folder-outside-the-project>` runs the foundation's native gate on a Mac with Xcode, Swift 6.1 or newer, and an iOS 18 or newer simulator runtime.
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
`phone.yml` runs this same gate on iPhone and iPad for pull requests touching `ios/`, `docs/contract.json` or the phone-contract generator and its shape guard.
The gate's own setup also selects it: `phone.yml`, `scripts/test-phone.ts`, `tests/helpers/phoneHome.ts`, `scripts/phone-test-home.ts`, `scripts/affected-phone.ts` and its command-lease helper `scripts/with-mac-check.py`.
Shared modules, connection/device code, general packages and the lockfile alone do not select it; a changed generated Swift file does.
Its Linux chooser reads the full git comparison with `scripts/affected-phone.ts`; an unreadable comparison runs the gate, and an unrelated change explicitly skips the native job.
The native job uses `MAC_RUNNER`, falling back to the `mini-mac` label rather than a paid hosted Mac, and retains result bundles, logs and connection readings as `phone-results`.
Its package install also uses a scratch HOME and an empty local-signing directory, so the install-time signature check never reads this Mac's signing material.
A newer push waits for the running native gate to finish and remove its own simulators; GitHub replaces only an older pending run for that same pull request.
Only native jobs share the repository-wide `mac-mini-phone` concurrency group, with `queue: max` and cancellation disabled at the job level; GitHub keeps up to 100 pending phone jobs.
Desktop jobs from different pull requests have no common job-level concurrency group, so they can run side by side.
On the Mac, `scripts/with-mac-check.py` gives the desktop build/test command a shared kernel file lease and each native device gate an exclusive one.
The runner slots use the same account and `$HOME/Library/Caches/infinitary-ci/checks.lock`; active desktop commands finish before a phone enters, and a waiting phone prevents new desktops passing it.
The helper replaces itself with the command and retains the lease descriptor, so command exit or cancellation releases it without stale markers or a daemon; lock files are never unlinked.
Phone gates can yield to desktop work between iPhone and iPad.
The native job's 120-minute limit allows 45 minutes for both device gates, 60 across admission waits and 15 for setup, cleanup and evidence upload; it changes no test deadline.
Setup, evidence upload, the choosers and Linux jobs remain independent.
Neither device's failure is ignored, and iPad still runs after an iPhone failure unless the job was cancelled.
Phone release workflows belong to the accepted plan's TestFlight piece; this lane neither signs a physical-device build nor publishes one.
Mac-side checks remain the project's normal gate and affected Devices journeys.

## Generated and bundled assets

`node scripts/generate-phone-theme.ts` copies light/dark values, spacing and radii from the design skill into adaptive native colors and lengths.
The native TTF fonts are format-only conversions of the skill's Latin Space Grotesk and JetBrains Mono WOFF2 assets, retaining their original names and outlines.
To regenerate them with FontTools and Brotli installed in a disposable Python environment, load each WOFF2 with `fontTools.ttLib.TTFont`, set `flavor = None`, and save it to the matching file under `InfinitaryApp/Fonts/`.
The app includes their SIL Open Font License notice and the Apple packages' license and notice files.
Swift package versions and revisions are pinned in the package and Xcode workspace lockfiles.
