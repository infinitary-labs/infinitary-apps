# Infinitary on iPhone and iPad

The native SwiftUI app lives in `ios/Infinitary/`, supports iPhone and iPad from iOS 18, and reads a Mac through the published connection contract.
Its name is Infinitary, its bundle identifier is `com.getinfinitary.infinitary`, and its Xcode development team is `9T2J7MNUP9`.
The phone is a view of the Mac, not a separate first mate or a place that runs work.
It shows interactive Cards, Activity and Tasks, sends the captain's messages and photos, and lets the captain start, continue, steer and interrupt work on the Mac.
The version-dispatched TestFlight workflow and the square app icon support internal delivery; App Store distribution and background notifications remain separate work.
The visual rules live in the design skill's `components/devices/PhoneView.prompt.md`.

## Joining and trust

Settings → Devices → **A phone** on the Mac opens a locally generated QR code, the same one-use computer link, Copy link and Stop it.
Every build of the Mac app offers **A phone**, installed and development alike (`docs/devices.md`, "Settings -> Devices").
The panel explains that the phone app comes from TestFlight for now, only to the people asked to test it, and is not in the App Store yet.
A phone can scan that code, paste its link or open an `infinitary://join` link, then confirms the address of the Mac it is joining.
Its first screen welcomes the person in the Mac's first-launch words, “Welcome aboard Infinitary”, with Nearby as one plain line, Scan the code prominent and Paste its link a plain secondary.
Nearby browses `_infinitary._tcp` and opens the scanner; an announcement supplies a possible address, never a key or permission.
The Mac announces while a usable direct computer invitation is open as well as while a phone is on its list, so first-phone discovery works.
Camera and Local Network permissions have separate explanations; a camera refusal offers pasting rather than reading the clipboard automatically.

`InfinitaryKit` owns strict link parsing, the device identity, pinned transport and the view session (`ReadOnlySession`, the foundation’s original type).
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

The session sends a view hello and its current in-memory epoch/sequence cursor, then reads cards, Activity, the task board and the last turn.
The generated `PhoneRequest` limits the additional requests to the published view channels and derives their read/change distinction and message limits from the contract.
Activity shows the newest line first and uses the Mac's feed wording, not a second event-to-words implementation.
The native contract constants are generated from `docs/contract.json` with `node scripts/generate-phone-contract.ts`.
`pnpm generate:contract` updates them together, and `pnpm check` refuses stale native constants, theme values or bundled card code and fonts.
Generation also verifies the required native fields in cards, Activity, task boards, records, search, last turns and crewmate transcripts, including the pushed card and task snapshots.
The shown card reads its thread once and follows numbered `inf:cards:thread` pushes; a newer push supersedes an older thread read.
Its card requests are a closed enum generated from the published contract, not a channel an HTML body chooses.

A return consumes numbered replay pushes, or reads fresh snapshots after a reload welcome.
All four initial snapshots must arrive before the app says **In reach**.
A card or task-board push supplies the new snapshot directly and supersedes any older initial read still in flight.
A task-board delta requests a coalesced full board, the published resynchronization path, rather than duplicating the Mac’s delta application logic.
Only a closed list of non-streaming events that can change the feed requests a coalesced feed refresh; assistant and thinking deltas cause no reads.
The feed owner exports `FEED_EVENT_TYPES`, with its authoring switch checked exhaustively against that list, and the contract generator derives the Swift `FeedChange` enum from it.
A gap in numbering drops the cursor and reconnects rather than silently losing updates.
Successful frames and pongs update the last-heard time; bounded handshake, welcome, read, Leave and heartbeat waits cut a stalled connection.
The watchdog starts before sending hello and cancels the transport too, so a stalled TLS handshake does not inherit the socket's longer lifetime.
The app keeps only its in-memory view while out of reach and shows its last-heard time.
Out of reach is said once, by the reach line under the computer's name; the message capsule and a card's reply row dim, and `changesOffLine` puts the Mac's own words (`changesOffWords`, `src/renderer/src/devices/viewWords.ts`) under the message box.
`ReadOnlySession.returns` counts the times the computer came back in reach after a failed attempt, so the app can mark a return without mistaking the ordinary reconnection when it opens for one.
Background cancels the old connection generation, and activation starts it again; an inactive scene such as Control Center does not disconnect.
A late callback from an old connection cannot clear or overwrite a newer connection.
Nearby addresses may be tried with the original pin, and only an authenticated address is saved as preferred.

Leave is available in reach and asks for confirmation, sends the connection's Leave frame, waits for removal and forgets the saved Mac.
Out of reach, **Forget this computer** asks for confirmation and clears the saved Mac and pin locally without claiming the Mac removed the phone.
Both choices live in the computer-details sheet, opened by the top-right computer button or Command-I; neither is an always-visible destructive toolbar action.
A removal close or repeated authenticated refusal clears cards and feed, forgets the Mac, and offers joining with a new link on a screen shaped like the first one, with one prominent Join again.
A failed address with no HTTP response does not erase an earlier authenticated refusal; a welcome or a different HTTP response does.
Neither reconnection nor discovery queues or retries a mutation.

## Cards on the phone

`PhoneCards(session:)` is the card-stage integration point: it fills its available column without adding navigation, a toolbar or the app's message box.
It keeps one shown card with a next-card peek and a lower pager of two chevrons around the count, whose menu lists the current titles, then a Minimized section and then a Past cards section.
With no current card the stage shows the character alone, as the Mac does, and the chevrons and count hide, leaving a lone menu named Past cards only while minimized or past cards exist.
The stack follows the Mac's: a card minimized on any Mac leaves the phone's stack, count and badge, and opening it from the Minimized section sends `inf:cards:minimize` with `false`, which brings it back on every Mac too.
A card is one framed surface that fits the stage: its head stays at the top, its choices stay at its foot, and the body, attachments, thread and reply row scroll between them in one native scroller.
The body's web view never scrolls, zooms or adds insets of its own; it takes its content's height inside that scroller, so there is only one scroll and nothing runs past the card's rounded frame.
On a short stage, such as an iPhone on its side, where the pinned head and choices would take more room than the body keeps, the whole card scrolls in that one scroller instead.
The session keeps which offers the stage drew while the person could see it, so the Cards tab's badge counts unread cards and the next chevron's dot marks an unread card ahead.
Swiping the native head pages cards without capturing the body's horizontal form and canvas gestures.
Ordinary arrivals keep the shown card in place; a new `holdsPlace` card comes forward, and a departure chooses an unread card before the first card.
Form and reply drafts live only in memory and survive paging.
Native controls own the title, attribution, close, footer choices and reply field; a body cannot draw over or press them.
The footer choices are the Mac's row (`PhoneChoiceStyle` in `PhoneChoiceRow`): rounded rectangles with 16-point words, drawn about 37 points tall inside a 44-point touch area, each keeping its own width at the trailing edge and wrapping onto another line when they do not fit.
As on the Mac (`footerGroups`), the default is drawn last, filled with the accent; a danger choice has a red outline and the rest a hairline outline.
The answered count sits in mono at the start of the first line, and a hairline sits above the row while the body runs on beneath it.
A card carrying the host-validated `reviewTaskId` shows Review finding above its title, and first mate cards about tasks name their task in the existing meta line.
A footer press collects a fresh form reading through the computer’s shared bridge, including question definitions and staged settings, and sends the mounted offer and lifecycle with its own interaction id.
If the body has already failed, a later deliberate press may use its last observed draft, marked `fallback` with `no-fresh-reading` rather than fresh question evidence.
A timeout on the current press still refuses it; a body that never supplied a reading keeps choices unavailable rather than inventing answers.
The default choice waits for every required question; other choices carry the current answers.
The core still owns refusals, effects and closing, and a refusal leaves the card and draft in place.
Body and footer choices share one native pending gate, and an accepted choice remains locked until its card leaves.
Reply admission counts UTF-16 units against `PhoneLimits.reply`, generated from the published request’s text limit.
A shown, drawn card reports seen only while the phone is active and the Mac is in reach.
A reply sends its words and current settings to the card’s author, keeps the thread’s messages as plain text and makes no closing choice.
A lone or marked card stays; an ordinary reply with another card declares its departure to the core.
Settings and browser doors name the computer where they must be used and send no action.
The host’s saved-sign-in choice needs no local browser page and is sent like any other choice.
The phone keeps recently closed cards in memory through `inf:cards:past` and also opens a past card the Mac points to with `past_card_shown`.
A past card has its last-seen body, saved answers, inert choices with the chosen one marked, its thread and Hide; it has no reply or mutation path.
Its ending words are generated from `src/shared/pastCard.ts`, so the captain, first mate and crewmate keep their own attribution, alongside withdrawn, taken-down and duplicate endings.
An evidence actor of `frame` is projected to the card’s typed author for those words; the stored ending stays unchanged.
The same read accepts older past-card ids; the current Tasks record does not expose its cards.

`CardWebHost` gives the shown body a nonpersistent WKWebView containing an opaque `sandbox="allow-scripts"` frame.
The bundled parent uses the actual shared frame bridge, form readers, schemas, stylesheet and typefaces, generated by `node scripts/generate-phone-cards.ts`; no second form implementation exists in Swift.
Each inline body script runs by its hash under `default-src 'none'`, with only local font and picture sources; event handlers, external scripts, fetch, forms, popups and navigation gain no permission.
Native WebKit messages are admitted from the trusted main frame alone, never from the body’s child frame.
The parent checks source identity, document identity, shared message schemas and declared action ids; native code checks effect-free action ids again and stamps every such request as `frame`, never `chrome`.
The native footer is the only path to an effect-bearing action.
A native watchdog removes a body that stops answering without removing its native controls, and offers Retry.
The watchdog counts only while the body is on screen, loaded and in front, since WebKit pauses a card behind another tab or in the background, and any answer since its last look counts, however slow.
A native collection timeout also releases a waiting footer or reply when the web process cannot run its own timer.
`CardAssets` serves bundled fonts and minted picture, project-font and recording names through the pinned connection; it never opens an arbitrary URL or filesystem path.
It asks through `ReadOnlySession.read`, which waits until the computer is in reach and asks again after a reconnect, so a card drawn from the first cards read, before the other first reads answer, still gets its pictures.
A separate script-free, nonpersistent web view shows pictures and GIFs, with no native message handler.
Both web views disable system link previews as well as refusing navigation.
MP4 recordings use the native player, whose resource loader serves only bounded bytes read through the pinned connection and writes nothing to disk.
The asset refuses all external references, and the player disables external playback and picture-in-picture.
Assets and drafts are memory-only and are cleared when their owner goes away.
An out-of-reach session refuses changes; a lost reply has an unknown result and is never retried or queued across reconnection.
The phone containment review is in `docs/live-prototype-security.md`, “Phone cards”.

## Native shell and component ownership

`PhoneWorkspace` supplies a stage, an optional Tasks view and an optional composer, with no draft or record state of its own.
The composition installs `PhoneCards(session:)`, `PhoneTasks(session:)` and `MessageComposer(session:)` together.
The composer stays mounted once, preserving its own text and photo state across tab and orientation changes; the shell never copies it into a tab or layout branch.
The card with its pager, the message box, Tasks and Activity share one centred reading column, `PhoneColumn`, 560 points with its gutters, so on an iPad the message box lines up with the card above it.
On an iPhone on its side (compact height) the card gets the height: the title row is one line, the computer's name and then its reach, and the last turn and the notice wait until it is upright.
There `AnyLayout` puts the removable photo strip beside the message capsule, retaining one field and its complete draft.
The field displays up to two lines there, the controls retain 44-point targets, and warnings remain full-length; portrait and iPad keep the stacked arrangement.
The native journey requires a completely visible card heading and scrolls real body text and an action into full view, not merely a retained draft above the tabs.
Card and task owners keep their selected records and replies.
`PhoneMessageContext` carries only the shown current or past card, the Cards tab’s visibility and the open task record into the composer; hidden cards and dismissed records supply no hint.
One content-sized footer floats over the tab container above the measured native bar, and each tab's room ends at the footer's measured top; no native bar height is guessed.
Only a tab bar attached to the same window contributes clearance; the iPad's top tabs leave a detached legacy bar whose stale frame must not move the footer.
No panel sits behind it: the last turn is two bare lines over the message capsule, which is native glass on iOS 26 and the field's fill and hairline on iOS 18.
On iOS 26 each tab reserves that height as a safe-area bar with the system's hard scroll edge, a nearly opaque foot, so rows never show through the last turn or the capsule; on iOS 18 the page color fades in behind it.
On iOS 26 the tab bar recedes while a card or list scrolls down and returns on the way back up, and the footer follows the bar it is measured against.
A receded bar keeps the full bar's bottom inset, so each tab sets that inset aside and reserves its own measured room down to the footer, and a card grows into the room the footer leaves.
The Cards tab's bar does not recede while the stage is empty, so a bar receded on a card comes back once the last card closes.
While the keyboard is open, a leading Done button in the persistent native navigation bar and the Hide keyboard command (Shift-Command-K) dismiss it without sending or clearing the draft, making the tabs reachable after typing.
The dismissal command does not belong to the keyboard’s transient accessory view.
The system tab accessory is fixed-height and cannot contain the composer’s turn, photo and error rows, so those rows stay in the growing footer instead.
The tabs read Cards, Tasks and Activity, in that order.
The iPad's wide landscape workspace places a sidebar beside the stage, with Tasks and Activity as a segmented pair at its top, opening on Tasks, each scrolling alone, and puts the composer at the stage's foot.
Portrait or narrow multitasking returns to tabs; layout measurement excludes the keyboard.
`PhoneActivity` reads the computer's wording and optional task key, shows its kind dot and relative mono age, and orders newest first on both devices.
The task key sits inline before the words at micro size, as on the Mac's feed line.
It exposes the full local timestamp to accessibility.
`PhoneSymbol` supplies native outline template images for the system's tinted chrome.
`PhoneStyle` holds the shared looks: `phoneTitle` draws a sheet's title inline in Space Grotesk, the `.phone` field style is the app's field, and `phoneSheetSurface` leaves a sheet on the system's glass on iOS 26 and puts it on the panel color with a hairline at its edge on iOS 18.
The message capsule's glass takes corners concentric with the screen's.
It also holds `SensoryFeedback.phone`, the one soft tap played when the computer accepts a message, a card's answer or reply, or a task's start, continue, interrupt or steer, and when `returns` counts the computer back; a page turn plays none.
Join, Leave and Forget ask in alerts, which keep the cancel choice in view; on iOS 26 a confirmation dialog becomes a popover that hides it, and the Join request has no button to anchor to.

`PhoneCharacter` draws the Mac's character in a native Canvas with the numbers of the Mac's own character code (`src/renderer/src/character`), so the two move alike.
At rest the tesseract drifts slowly and the eyes blink every few seconds and wander; listening breathes as two counter-rotating hexagons; working speeds up with the Mac's ember, shimmer and halo, with white-hot cores.
It plays two of the Mac's emotes and no others: the greeting, on the first character a person sees after the app opens or joins a computer (`CharacterCues.greetOnNextSight`), and the nod.
A turn that starts mid-greeting lets the greeting play on as the ember eases in, then the character works, as on the Mac.
A character that leaves mid-greeting, such as the empty stage a join shows before its cards arrive, hands the greeting on to the next one shown.
The nod plays when the Mac's first mate reacts to a reply with one (`firstmate_emote`), held until that turn ends as on the Mac; a reaction replayed while reconnecting is not played, and a character off screen does not keep one for later.
The wire and halo boosts come from the design skill's tokens through `scripts/generate-phone-theme.ts`, like its colours.
Its timeline is capped at 30 frames per second, paused when hidden or backgrounded, and still under Reduce Motion, with no emote.
Its accessibility value stays the state the conversation owner supplies; an emote never changes it.
The join stage uses idle; the empty stage follows the Mac's published busy event for working and idle, with the snapshot and listening limits described under “Disposable verification”.
No crew count or joining time is invented: the current connection supplies neither, so those facts stay absent.
Joining still confirms the link's computer address, not a name obtained before authenticating that computer.
The details sheet names the connected view's ability to answer cards, send messages and control tasks, or explains read-only access when the Mac requires an update.

## Talk and tasks

The message box keeps the captain’s last message and the first mate’s reply above its native multiline field.
Its component owns messages and photos; the shared shell places it at the foot above the tabs.
A send carries the visible entry’s `visibleCardId`, `pastCardId` or `taskId` through the published conversation request as a hint, never as the message’s topic.
The native multiline field uses the keyboard’s own dictation; Infinitary adds no speech model or microphone permission.
Photos uses the system library picker, converts selected images to orientation-correct JPEG thumbnails up to 2,048 pixels, and bounds each attachment and turn by the published limits.
Selected photos appear as removable chips; messages and photos remain in memory until a confirmed send clears them.
Command-Return sends from either message field; native controls retain hardware-keyboard focus, VoiceOver and Dynamic Type.

The Tasks tab combines a filter of the live board with the Mac’s earlier-task search.
Its five groups and their labels come from `src/shared/nowPanel.ts`, generated as a finite native lookup so the phone does not own another grouping rule.
The phone keeps active parent trees together, hides dropped rows and closed ordinary operations from the groups, and keeps them searchable.
Each group's header is a micro uppercase label with its count, as on the Mac.
Waiting on you, Working and Queued start expanded; Backlog and Done start collapsed, with counts and keyboard-reachable disclosure buttons.
Each row is one line: status mark, key, title and then the project, with the newest task first inside each group and dividers inset past the mark.
The search waits above the list until the list is pulled down from its top, as the Mac's waits behind its icon.
Find a task (Shift-Command-F, the Mac's key) opens it with the caret in the field; Close search, or Escape on an empty field, puts it away.
VoiceOver cannot pull past the top of a list, so the search is always shown while it runs.
A record shows the goal, captain’s words, progress, latest report, model and timeline; its Crewmate section reads the redacted session and live words from their Mac owners.
The timeline's events sit on a hairline rail in caption size, each time right-aligned.
The open record refreshes once a second, as the desktop transcript does, and no hidden record polls.
Start and Continue come only from the Mac’s `moves`; Steer and Interrupt use the existing captain-owned task channels, never a phone worker.
Interrupt stops a running turn and keeps its task idle and steerable; Continue is offered only when the Mac marks a task Interrupted, such as after recovery.
The record's actions sit at its foot in a card's footer row: Start or Continue filled with the accent, and Interrupt outlined beside it.
The crewmate message box above them is a capsule whose arrow sends the steer.
Tool results open on demand through their published read.
Task cards, browser pages and rich transcript pictures remain outside this piece.

A mutation requires both **In reach** and the welcome’s `full` access.
Every request has one connection-bound response and a bounded wait; a disconnect, timeout or unreadable mutation response explains that its outcome is unconfirmed.
The phone retains the draft, asks the captain to check the Mac, and never queues or retries a mutation after reconnecting.
A native draft, last turn, task and transcript are never written to the phone’s saved connection file.

A new card or an answered reply raises an in-app notice while the app is open, after reading the Mac’s Notifications switch.
The notice is a pill at the top of every tab, interactive glass on iOS 26, a New card or Reply label and the card's title; a tap opens that card on the Cards tab, and a swipe dismisses it.
It sits under the iPad's tabs, over the stage beside the landscape sidebar, and waits while an iPhone is on its side.
A reply notice leaves after five seconds unless VoiceOver is running; a new-card notice stays until its card is read or the pill is swiped, and no pill points at the card already on the stage.
The first snapshot and a reload seed the notice history without announcing old cards; a body-only revision is not new news.
Background stops the connection and clears the notice; there is no background notification service or push relay.

## Installing on a phone

The captain installs Infinitary through TestFlight, not Xcode.
Once a build is in internal testing, Apple emails each tester in the app's internal group an invitation.
On the phone, the tester opens Apple's TestFlight app with the Apple Account in that group, accepts the invitation and installs Infinitary; automatic distribution offers each later build there too.
The phone and Mac need a network route to one another and a Mac build that accepts `system: "ios"`.
Open **A phone** in the Mac app's Devices settings, scan or paste its link in the phone app, and confirm that Mac.
The phone should name the Mac and show In reach, its Cards, Activity and Tasks.
Type a message or use keyboard dictation, attach a library photo, and confirm the last turn on the Mac.
Open a task’s record to start or continue it, and its Crewmate section to steer or interrupt its running turn.
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

After preflight, the existing disposable iPhone and iPad gates run on `REAL_MAC_RUNNER` when it is set, otherwise on `MAC_RUNNER`, falling back only to `mini-mac`.
Xcode signs the upload with the captain's certificates, so the job asks for the real Mac, never a virtual one (`docs/testing.md`, "The real Mac's place").
Either failure prevents archive and upload; iPad still runs after an iPhone failure unless cancelled.
The release job waits in a line of its own, `ios-testflight`, apart from the phone checks, and each device gate and the release command use the existing exclusive command lease while desktop jobs retain their parallel queues.
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
On a computer in CI mode (`infinitary.checks = ci`, `docs/testing.md` "Where the heavy checks run") it refuses before it waits and names `phone.yml` on request instead.
Add `--ipad` for the iPad Pro 11-inch (M4); the default uses an iPhone 16.
Add `--both` to run the checks and build once, then the iPhone and the iPad side by side; the evidence folder then holds the shared logs and an `iphone` and an `ipad` folder.
The native journey is four tests in `PhoneJourney`, its parts: `join` (join and recover), `talk` (talk and tasks), `cards`, and `rest`, which runs the character and past choices with the app-hosted tests and any test no other part names (`scripts/phone-test-plan.ts`).
Each part on each device is its own gate with its own simulator and test home, and `--simulators` (default 6) sets how many run at once; they start longest part first, each part on the iPad before the iPhone.
A part's results are in its own folder, inside the device's folder with `--both`, and `--part` runs only the named parts.
A `--both` run of every part writes each part's minutes on each device to `part-times.json` in the evidence folder, which a pull request's phone check reads to keep within its budget.
The build is `xcodebuild build-for-testing` for any simulator, and each part runs `test-without-building` from a copy of the built test plan that names its own test home and selects its tests.
No part stops another, and any part failing fails the gate.
A part that chooses a library photo (`talk` and `rest`) starts its tests only after the simulator's Photos says it has opened its shared-with-you library, because Photos hands over no chosen photo before then.
With simulators booting side by side that took up to six minutes after boot, so the part waits while its home gets ready, and fails if Photos has not opened it fifteen minutes after boot.
The part keeps that wait's own log output in `photos-stream.log`, and when the wait fails it also keeps the simulator's app and Photos log since boot with its command logs, before deleting the simulator.
Add `--demo`, with FFmpeg installed, to keep real-speed reconnect, card, character and task-start recordings with their posters beside the test results.
The reconnect recording crops the top of the phone view around the connection state and card; the card recordings keep the full native view.
Each retains real speed and holds the final frame for five seconds, within a fifteen-second cap.
The runner creates and deletes its own simulator, scratch HOME, real-core home, mock provider, data and keys, never borrows or erases a person's simulator, and saves logs and the result bundle outside the working copy.
The test home uses the real stores, dispatcher, pairing and TLS connection, with sample cards, feed lines and a task; its control interface listens only on loopback behind a fresh per-run token.
The simulator-only `INFINITARY_ISOLATED_PHONE_TEST` environment value disables real Bonjour browsing, so an offline fixture never causes attempts against a person's discovered Macs; physical discovery remains a captain check.
It first verifies the independent published-contract client can join and read the sample card.
The join part covers a wrong Mac pin, joining, cards and feed, identity across relaunch, out-of-reach state, catch-up after a home restart, background/foreground replay, Leave, local Forget and Removed.
Every other part first joins its own home, and reaches the state the single journey had reached before it: the talk part puts the hero card on the stage and relaunches the app.
The cards part drives forms, staged settings across paging, footer and body choices, the saved answer on the real home, close, threads and replies, pictures, a picture card drawn while the phone is still reaching after a reconnect, completed recording playback, seen, past cards, Mac-only doors and out-of-reach refusal without replay.
It checks both immediate script stalls and a stall during answer collection, and captures both appearances and the largest standard Dynamic Type size.
A scripted card attempts network access, parent access, direct native messages, injected scripts and a footer effect; the test home records whether any forbidden request reaches it.
The runner keeps the card interaction recording separately from the reconnect recording when `--demo` is selected.

It also photographs join, Cards, Activity, the empty stage and details in both appearances, checks the largest standard Dynamic Type size, opens details by keyboard, and checks the iPad's landscape sidebar, its Tasks and Activity pair opening on Tasks and return to portrait.
Every native journey launch goes through `launchPhoneApp`, which renews the owned simulator's keyboard log subscription and waits for its startup before launching the app.
A live subscription is not proof that it still supplies registrations after relaunch; the new subscription starts with no cached witnesses and observes both launch and the home's keyboard attachment.
The runner joins the old output streams before appending the new subscription's gzip member, keeping all registrations in order.
Hardware chords go through `pressPhoneKey`, which asks the test home for backboardd's acknowledgement of that chord's registration for the current app process, then sends the chord once.
UIKit publishes an app's key commands to backboardd only while a hardware keyboard is attached when its deferred update runs after the next Core Animation commit, so for that wait the home attaches one to its owned simulator by setting the simulator-wide attached state `UIDevice` reads, the value backboardd itself writes when a keyboard connects, and detaches it again however the wait ends.
XCTest's virtual keyboard connects and disconnects within a millisecond of each key press, so a priming press only races that publication, and once a press has detached it no app process launched afterwards publishes at launch.
The native runner observes only its own simulator, and the isolated test home returns the acknowledgement to the key driver.
Subscription renewal happens only at the explicit launch boundary, never as a timeout retry or a second key press.
An evidence-writer failure stops the observer, rejects readiness and waits for both output streams before simulator cleanup.
An app-side command list is not that acknowledgement; a missing witness fails before sending the chord, without a delay, another priming attempt or a repeated chord.
For Return, the driver checks the router's carriage-return registration but supplies newline to XCTest: Xcode 26.4 emits the physical Return key for newline and no key for its Return constant.
The talk part checks that Command-Return restores the field's observed empty value and writes exactly one captain message to the real home.
The talk part exercises details, keyboard dismissal, both card-paging shortcuts and Send as first chords after relaunch, retaining the original button and draft assertions.
The composed journey verifies keyboard dismissal and computer details after relaunch without changing its retained-text and retained-photo assertions.
It also checks that the card and Tasks start and end where the message box does, the reading column.
The fixture's display controls only change the launcher-owned simulator, never a developer's device or this Mac's appearance.
App-hosted shell tests render each native character's still pose, play the greeting and the held reply nod through the character's machine, and read Activity from the real test home; the native journey also verifies the computer-authored task key.
The empty-stage character consumes the Mac's `firstmate_state.busy` event, the same conversation-state owner as the desktop, and the journey holds and completes a real first-mate turn through the mock provider to verify working and idle.
A stopped or lost connection clears the busy reading; the published connection has no initial busy snapshot, so a fresh session stays idle until a busy event arrives.
Native keyboard dictation exposes no listening signal: the phone never infers listening from focus or typing, and the listening drawing is not a live conversation state.
Native hero pictures use the same crop in both themes from the simulator's full-resolution attachments; the desktop-only `heroShot` cannot capture a SwiftUI view.

The talk part chooses a project-owned picture from the disposable photo library, types a message, and checks the real Mac’s captain actor, image bytes and last turn.
It pulls the task search down, closes it, opens it again by Find a task's key, then searches and starts an on-request task, checks that the real Mac ran it, and interrupts its turn.
The fixture then gives that real task’s saved workspace and session the Interrupted state used by recovery; the phone continues it and sends a steer that the held mock-provider turn actually reads.
The fixture uses Pi with the mock provider’s Anthropic message format, matching its held-turn script; no Claude client or provider account is involved.
It also checks that the foreground notice sits under the iPad's tabs and over its landscape stage, waits on an iPhone on its side beside a one-line title row, and opens its own card, retained offline drafts, an unconfirmed response with no automatic repeat, and a future-major home that allows reading but refuses changes.
The home records read and connection counts across streaming, pushed card revisions and an idle period longer than both pairing deadlines.
The journey also checks Control Center and removal while away with an owned endpoint that stalls TLS between authenticated refusals.
The launcher truncates the actual saved Mac only inside its owned simulator's app container; the same journey captures the damaged-record explanation and joins again with a fresh confirmed link.
Each part starts from its own fresh home and simulator; the Xcode scheme's `PHONE_TEST_HOME` setting names that home's private control interface.
Native package tests exercise the Mac-produced link and certificate fixture and certificate/public-key compatibility without using a Mac Keychain.
App-hosted tests repair a missing certificate in the disposable simulator's own Keychain and inject protected-data read failures to check retry and the joining explanation.
They refuse to run on a physical device, and the iOS identity API itself refuses creation on macOS.

Unsigned simulator tests need an application identifier to use the simulator's own Keychain.
`SimulatorTests.xcconfig` disables signing and injects `Simulator.entitlements` into the app's simulator-only `__TEXT,__entitlements` section through the linker.
This is simulator metadata, not a signature: no `security` or `codesign` command, signing identity, profile, certificate lookup or keychain search-list change is involved.
Normal device builds use Xcode's own signing settings and do not include this test configuration.
The runner waits for simulator boot completion before launching tests and uses one test worker per simulator.

For interactive local development, `node scripts/phone-test-home.ts <output-json-outside-the-project>` keeps the same disposable real-core home open until interrupted.
The output names its control address and scratch root, and is private to that run.
`phone.yml` runs this same gate with `--both` for pull requests touching `ios/` or the phone-card or phone-contract generator and the contract shape guard.
The gate's own setup also selects it: `phone.yml`, `scripts/test-phone.ts`, `tests/helpers/phoneHome.ts`, `tests/helpers/phoneKeyboard.ts`, its command-lease helper `scripts/with-mac-check.py`, its check runner `scripts/phone-checks.ts` and its test plan helper `scripts/phone-test-plan.ts`.
Setup the gate never runs does not: `scripts/affected-phone.ts`, `scripts/replaced-phone-runs.ts`, `scripts/phone-test-home.ts`, and the virtual Mac scripts `scripts/virtual-mac/phone.sh`, `phone-job.sh` and `vm.sh` while `PHONE_VIRTUAL_MAC` is unset.
A pull request's gate runs only the parts the change reaches that fit a six-minute budget, closest first, with every part whose UI test code changed even past it; the nightly check of `main` runs every part (`docs/testing.md`, "The phone parts a pull request runs").
Shared modules, connection/device code, general packages and the lockfile alone do not select it; a changed generated Swift file does, unless it changes only its `public static let version` line, which includes a new first number: the phone and the computer come from the same pull request, so they always agree on it, and `docs/contract.json` alone never selects the gate.
Every pull request still checks on Linux that the generated file is current, through `pnpm check` (`node scripts/generate-phone-contract.ts --check`).
Its Linux chooser reads the full git comparison with `scripts/affected-phone.ts`; an unreadable comparison runs the gate, and an unrelated change explicitly skips the native job.
A run on request (`workflow_dispatch`, such as the nightly check of `main`) skips the chooser and runs every part on both devices, then keeps each part's minutes as `part-times.json` in `phone-logs`; it has no pull request, so nothing replaces or cancels it, and it starts no release step (`docs/testing.md`, "The phone check on request").
Inside a gate, a failed generator check or Swift package test is reported and the simulator tests still run (`scripts/phone-checks.ts`).
The native job uses `VIRTUAL_MAC_RUNNER` when it is set, otherwise `MAC_RUNNER`, falling back to the `mini-mac` label rather than a paid hosted Mac, and retains result bundles, logs and connection readings as `phone-results`.
It also uploads command logs separately as `phone-logs`, so an Xcode failure can be read without downloading screenshot-heavy result bundles.
A failed part adds to its command logs what the app, its card pages and Photos logged on its simulator, and names its failing lines in the job log.
It also keeps, in a log of its own, what the simulator's system logged from the part's first test: SpringBoard, backboardd, the accessibility server, the keyboard and the test runner, which answer XCUITest's check for interrupting elements.
Its package install also uses a scratch HOME and an empty local-signing directory, so the install-time signature check never reads this Mac's signing material.
A newer push never waits behind its pull request's older phone run: `phone.yml` has no run-level concurrency group.
Its `cancel-replaced` job cancels the pull request's older phone runs whose native job has not started its device gate, so a replaced version gives up its place in the Mac mini's line (`scripts/replaced-phone-runs.ts`).
A device gate that already started is never cancelled; it finishes and deletes its own simulators.
No simulator exists right before the gate, so there a replaced version cancels its own run instead of starting the gate; a failed reading of the pull request runs the gate.
That check also stops a manual rerun of a replaced version, which no newer run cancels, about a minute after it reaches the Mac mini.
It stops the run of a pull request that merged or closed while the run waited in the phone line the same way, so a merged pull request never holds that line for a device gate; the nightly check of `main` checks what merged.
On the Mac mini's own runners, native jobs share the repository-wide `mac-mini-phone` concurrency group, with `queue: max` and cancellation disabled at the job level; GitHub keeps up to 100 pending phone jobs.
A job on the placement service's virtual-Mac label takes a group of its own instead, so phone checks run side by side, one per free virtual place ("A phone check the placement service puts in a virtual Mac").
Desktop jobs from different pull requests have no common job-level concurrency group, so they can run side by side.
On the Mac, `scripts/with-mac-check.py` gives the desktop build/test command a shared kernel file lease and the native device gate an exclusive one, taken once for both devices; a gate inside a virtual Mac takes none ("A phone check the placement service puts in a virtual Mac").
The `test:phone` package script takes that lease around `scripts/test-phone.ts`, and the script never takes it, because CI already wraps the script and a nested exclusive lease waits forever; the script also swaps `HOME` for a scratch home before anything else runs.
The runner slots and a crewmate's `pnpm test:phone` use the same account and `$HOME/Library/Caches/infinitary-ci/checks.lock`; active desktop commands finish before a phone enters, and a waiting phone prevents new desktops passing it.
The helper holds the lease as the command's parent and never passes it on, so it ends when the command exits, even if the command leaves background processes running; lock files are never unlinked.
A waiting check prints that it waits and who holds the lease, and takes the lease back from a holder whose command ended, a dead holder's command or a command past its `--max-hold` limit (`docs/testing.md`, "Native phone checks on the pull request").
No desktop work runs between the iPhone and the iPad: the one gate holds the lease for both.
The native job's 165-minute limit allows 45 minutes for the device gate, 105 across admission waits and 15 for setup, cleanup and evidence upload; it changes no test deadline.
The admission allowance covers the CI job waiting behind active desktop journeys (60 minutes) plus two local phone gates (45 minutes) that took the entry lock first.
Setup, evidence upload, the choosers and Linux jobs remain independent.
Neither device's failure is ignored: their parts run side by side, none stops another, and any failing fails the gate.
This pull-request lane neither signs a physical-device build nor publishes one; `ios-release.yml` runs the same native gates before its separately dispatched TestFlight upload.
Mac-side checks remain the project's normal gate and affected Devices journeys.

### The phone check in a virtual Mac

The repository variable `PHONE_VIRTUAL_MAC` moves the pull request's two device gates off the Mac mini and into a fresh virtual Mac cloned from the lane's image (`docs/testing.md`, "A virtual Mac as a runner").
Unset or empty, `native-phone` runs exactly as described above.
Set, the job runs on the phone check's own runner, labelled `mini-mac-vm`, which takes no Mac mini slot, and it installs no packages on the Mac itself.
`scripts/virtual-mac/phone.sh start` deletes a clone an earlier check left, clones `infinitary-lane` as `infinitary-lane-phone`, starts it with the pull request's committed version and installs its packages inside it.
The version rides in as a `git archive` of the checkout, because a pull request's checkout is shallow and a bundle of it cannot be fetched into an empty clone.
The gate step then runs `phone.sh gate iphone ipad`, which runs `scripts/test-phone.ts --both --simulators 2` inside the clone, two simulators at a time for its 6 CPUs and 16 GB, and copies each device's results into `$RUNNER_TEMP/phone/<device>`, so `phone-results` keeps what the Mac mini's gate keeps, a failed device's included.
The last step, `phone.sh delete`, stops and deletes the clone however the job ends, a cancelled or replaced run's included.
No gate in the virtual Mac takes the Mac check lease, so phone checks wait only for each other, never for journeys (the captain's INF-517 answer on INF-79's rule).
The `mac-mini-phone` queue is what keeps one phone clone running at a time, so with this variable set every phone check takes that shared line whatever `VIRTUAL_MAC_RUNNER` says.
Whatever its value, the gate is the same one step as on the Mac mini, `Read and recover on iPhone and iPad at once`, right after the replacement check.
The script prints in UTC when the virtual Mac started and when each device began and ended.
The image and its base image's download take about 80 GB together in tart's own `~/.tart` on the Mac mini.
Set the variable only once that runner is registered, finds `tart` on its search path and the image is built; otherwise every phone check waits for the runner or fails at its first step.
The Mac mini's idle watchdog counts a running `tart run` process as work for up to three hours, so it does not restart the Mac under a phone check.
While the variable is set, a crewmate's own `pnpm test:phone` stays on the Mac mini under the lease and checks the iPhone alone, leaving both devices to the pull request's phone check; `github_read` of `/repos/{owner}/{repo}/actions/variables` lists the variable when it is set.

### A phone check the placement service puts in a virtual Mac

Once `MAC_RUNNER` names the placement service's label (`docs/testing.md`, "One image for every project"), `native-phone` runs on whichever place the service gives it, usually a fresh virtual Mac of its own.
The gate step asks macOS whether it runs in a virtual Mac (`sysctl -n kern.hv_vmm_present`); there it runs `scripts/test-phone.ts --both --simulators 2` directly and takes no Mac check lease, because no journeys share that Mac (the captain's choice on INF-658: "Move phone checks off the Mac check lock once the virtual Mac runner works").
Two simulators at a time match the virtual Mac's 6 CPUs and 16 GB, as `phone-job.sh` runs them, and INF-621's two complete iPhone and iPad proofs passed in that image.
On the real Mac's place, as on today's Mac mini runners, the gate still takes the exclusive lease, which a crewmate's `pnpm test:phone` and journeys on that Mac share.
Leave `PHONE_VIRTUAL_MAC` unset with the placement service: a job already inside a virtual Mac cannot start another one.

The repository variable `VIRTUAL_MAC_RUNNER`, which `native-phone` reads before `MAC_RUNNER`, names the service's virtual-Mac label, `mini-mac-virtual`, so the phone check never takes the real Mac's place (INF-897).
GitHub hands a scale set's new runner whichever of that set's waiting jobs it picks, not the one the service started it for, so in the scale set the other Mac jobs share, the service's choice does not hold.
Under the virtual-Mac label the phone check shares its scale set only with `old-cask-upgrade.yml`'s check, which runs after a release that switched the old cask, on request, or for a pull request that changes it.
On that label each phone check takes a concurrency group of its own, so phone checks no longer wait in one line: each waits only for a free virtual place, and both virtual places can run phone checks at once (the captain's choice on INF-989: "let both virtual Macs run phone checks at once by ending the one-at-a-time line").
The real Mac never takes that label, so a phone check never takes its place or its Mac check lease.
A runner the service starts for one phone check may take another waiting phone check, or that rarer check in the same set; either is a job that asked for a virtual Mac.
The service gives a free virtual place first to the oldest job that asks for a virtual Mac (`Plan` in dotfiles-private's `pkgs/fm-placer/schedule.go`), so a released phone check starts on the next free virtual place instead of behind every Mac job already waiting.
Unset, the job runs where `MAC_RUNNER` sends it, as before; `tests/phone-ci.test.ts` evaluates the job's runner for each setting.

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
It also writes the void into the `LaunchBackground` color asset that `Info.plist`'s launch screen names, because the system draws that screen before any Swift runs.
The native TTF fonts are format-only conversions of the skill's Latin Space Grotesk and JetBrains Mono WOFF2 assets, retaining their original names and outlines.
To regenerate them with FontTools and Brotli installed in a disposable Python environment, load each WOFF2 with `fontTools.ttLib.TTFont`, set `flavor = None`, and save it to the matching file under `InfinitaryApp/Fonts/`.
The app includes their SIL Open Font License notice and the Apple packages' license and notice files.
Swift package versions and revisions are pinned in the package and Xcode workspace lockfiles.
