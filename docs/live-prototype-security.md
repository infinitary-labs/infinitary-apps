# Live-prototype sandbox security review

The checklist for the agent-authored-HTML surface (decision D-9).
Re-run this review whenever `prototypeSrcdoc.ts`, `PrototypeBody.tsx`, the frame bridge (`src/shared/plugins/frameScript.ts`, its messages in `src/shared/plugins/bridge.ts`), the frame document builder (`src/shared/plugins/frameDocument.ts`), the frame scheme (`src/main/frames/`), the frame watchdog (`FrameController`), the frame realm's lib or runtime (`scripts/frame-lib.ts`, `src/renderer/src/frameRealm/`), the project-font check (`src/core/fontFormat.ts`, `src/core/pi/fontFaces.ts`, the font probe in `src/main/mediaProbe.ts`), or the frame CSP changes.
The sandbox token list, the focus policy and the frame CSP are one shared definition (`src/shared/plugins/containment.ts`, UI plugin system phases 0 and 1, `docs/ui-plugins.md`); a change there is a change here.
Template mounts share the sandbox, CSP sources, bridge validation, and served-document vehicle.
Their script contract differs: a plugin runs only its single `template.script`, while a card mount hash-pins each inline script in its markup.
Card mounts also use a host and capacity pool of their own.

The `live-prototype` card kind is retired; a working preview is now simply a decision whose body brings its own style sheet, canvas, or a script outside every figure (`docs/card-authoring.md`, "The preview is the decision").
A script inside a figure only moves that figure, and its body is still prose; it rides the same scripted vehicle.
Nothing in the containment model moved with it - same sandbox, same CSP, same bridge, same two vehicles - so this review reads "live prototype" as "a card body" throughout.

## There is no sanitizer

A card body is rendered VERBATIM.
The allowlists - tags, attributes, value shapes, CSS declarations, the two profiles - were removed by the captain's decision of 2026-09-15 (direction C).

The boundary is, and always was, three things:

- the `<iframe sandbox="allow-scripts">`, never `allow-same-origin`;
- the frame CSP, `default-src 'none'`, where every script runs by hash;
- the host's validation of every bridge message.

A sanitizer could never have been load-bearing: a body may carry its own inline script (WI-16), which rewrites the DOM and sets any style at run time, so a rule that removed a declaration from static markup stopped nothing an attacker would do.

What survives from before: the sandbox, the CSP, the bridge, the host's validation, the 64KB body cap at `emit_card`, the shape lint (`src/core/pi/cardLint.ts` - a SHAPE gate, never a safety one), and `plainTextBody` for a legacy body that is prose rather than markup.
Tokens, helper classes and on-brand prose are now an authoring PREFERENCE that the prompts ask for, not a rule enforced by deletion - the source of every past breakage.
### What the removal added, in the same change

- **Effect-bearing actions are host chrome's alone.**
  The one live vector the sanitizer never touched: a card's own script could call `inf.action(id)` for an action carrying a merge effect and merge its own PR at mount, before the captain had read the card.
  The host now declares only the card's effect-FREE actions to the frame (`bridgeActionIds` in `src/renderer/src/cards/bridgeActions.ts`), so the bridge refuses the rest with `action_not_declared`.
  The core also checks the current card at dispatch time and refuses an effect-bearing action from a frame, so an in-place revision cannot reopen the path through a stale declaration.
  A settle, an `open`, or a host op happens only when the captain clicks the footer button React renders (`tests/e2e/card-effect-gate.spec.ts`).
- **`img-src data: app-frame:`.**
  A body may carry its own image inline - `<img src="data:...">`, `<svg><image href="data:...">`.
  A `data:` URI names no host and opens no network path, and the 64KB body cap bounds its size.
  The one other source is the shell's own frame scheme, for pictures by reference (card pictures, phase 2; the fonts precedent): its `images` host serves only the host's copy of a picture it verified in a crewmate's working copy, by a name the core minted (`<taskId>-<32 hex>.<ext>`, parsed by `@shared/cardPictures`) - no path segments, no listing, nothing outside `crewmates/<taskId>/cards/`.
  It opens no network path either, and a body that names another picture's URL reaches only a picture the captain already has.
  Every other image source stays refused, and `containment.test.ts` pins both.

## Agent scripts in card bodies (WI-16)

Captain ruling D3, round two (2026-09-14): "just allow scripts in the cards to maximize interactivity in there".
This section is that change's security review, folded into the same PR as the plan requires; there is no separate review phase.
What changed is where a script-bearing body is served, not what the frame may do: the sandbox tokens and every CSP directive are the ones below, and `containment.test.ts` still walks its ledger unchanged.

- Vehicle.
  A body containing `<script>` is not rendered through srcdoc (it would inherit the app CSP, which admits no agent hash).
  The host serves it as a mount instead, and the markup goes out UNCHANGED: the registry parses it once with htmlparser2, hashes every inline `<script>` that has no `src`, and pins those hashes into that mount's own CSP (`inlineScripts` in `src/main/frames/frameMounts.ts`).
  A `<script src>` stays in the document and never loads - nothing hashed it and `default-src 'none'` refuses the fetch.
  On the srcdoc vehicle the policy pins the bridge alone, so a script that arrives there runs never.
- Policy.
  The host serves the document with `frameCsp([...hashes])`, the existing seam template mounts use: `default-src 'none'`, no connect, media, frame, or worker source, `font-src app-frame:` and `img-src data: app-frame:` only, and `script-src` = the bridge hash plus that card's own script hashes.
  A script injected at run time has no hash and never executes (e2e).
  The bridge is the only host-owned script a frame carries: the `fm.viz` figure helper was deleted with contract v2.5, which took its hash out of every scripted body's `script-src`, and a body that wants a figure hand-writes the SVG.
- Isolation.
  A card mount is served at a host of its own, `app-frame://card-<random id>/` (`FrameMountRegistry`, `CARD_MOUNT_CAP` on its own), not under `mount/`: a site is scheme plus host and the browser shares one renderer process per site, so a card under a common host would share - and could wedge - the process every plugin panel runs in.
  Measured: a `while (true)` card under the shared host froze a sibling frame, and removing it did not unfreeze the sibling; at its own host the sibling kept painting.
  The id is a random UUID, so no mount can name another's document.
- Held until shown (FI3-871).
  A card's page is born held, so the stage can prepare the next card while the captain reads: the bridge changes each `<script>` element's `type` before the parser runs it, pauses CSS animations with one inline rule (`style-src 'unsafe-inline'` already allows it) and pauses SVG timelines.
  The host's `activate` puts each held script back with the same text, so it runs only by the hash the host pinned, exactly as it would have; the policy has no `'strict-dynamic'`, so a script the bridge inserts gains no trust from the bridge, and on the srcdoc vehicle a released script still runs never.
  The sandbox tokens, every CSP directive and the hashes are unchanged; the bridge gained one host message, `activate`, and a `held` flag on `resize`, and `FRAME_BRIDGE_SHA256` moved with it.
  A prepared page runs none of the card's own code, so a prepared card can make no sound, run no timer and ask nothing of the host before it is shown.
- What a script can reach.
  The same as the bridge: `inf.action(id, value)` for the card's declared ids (undeclared ids refused, values bounded), `inf.onTheme`, `inf.subscribe` against an empty read declaration (always `read_not_declared`), `inf.fetch` (refused, no grant), resize, link, picture, task-key and draft notifications - minus the card's effect-bearing actions, which are never declared to the frame.
- Words for the message box (FI3-1164).
  A `data-inf-draft` button's press posts the `draft` message: one line of at most 500 characters, from the document the frame shows.
  The window takes it only from the card on screen whose frame holds its focus - the captain's own click or key, which a script cannot give - and only while the message box is not held, then puts the words at the start of the box with the caret after them.
  It sends nothing: the worst a body can do is put words in front of the captain, who reads them in the box before anything leaves, as with text the captain pastes.
  No `window.infinitary`, no parent DOM, no storage, no network, no top-level navigation, no popups, no forms.

## Project fonts in previews (INF-128)

The captain's scope of 2026-10-16: "That wording, plus a way for a card to use the project's own font files, which needs a security review."
This section is that review, folded into the same change; its mechanism is `docs/card-authoring.md`, "Fonts by reference".
What changed is one more thing the frame scheme serves, and one narrowing: the sandbox tokens, the mount vehicle's policy, the bridge and its hash, and the app CSP are the ones below.
`font-src app-frame:` already admitted the whole scheme, so a mounted card needed no policy change for the new host.
The srcdoc vehicle's own policy narrows `font-src` to that scheme's `fonts` host (`SRCDOC_FRAME_CSP`), so a body there draws the design system's typefaces and no kept font, even one whose address the vehicle test did not recognize; `containment.test.ts` pins both policies.

**Threat.**
A font file is untrusted bytes: it may come from a project cloned from a stranger, and the crewmate writes the names.
A font file is also code for a parser - the font engines are large, written in memory-unsafe languages, and have been exploited through crafted fonts.

**Layers, outermost first.**

- The host's check at `emit_card`, in bounded, memory-safe TypeScript (`readFont`): a contained regular file of at most 8 MB, a WOFF2, WOFF, TrueType or OpenType font by its own signature, never a collection, its header's stated size equal to the file's, its table directory and tables inside the file.
  The bytes read for the check are the bytes loaded, counted and copied, so nothing changes between the check and the use.
- The host's test load (`createTypefaceProbe`, `src/main/mediaProbe.ts`): all of a card's fonts load as web fonts in one hidden window of its own - sandboxed, no preload, an in-memory session that answers only those files and refuses every permission, download and network request, a policy of `default-src 'none'; font-src` that one host - each within five seconds on a clock of its own, or the card is refused by that font's name with the sanitizer's own words.
  The window is destroyed after each load, however it ends, and is never one of the app's windows.
- The frame scheme's `typefaces` host serves only names the core minted (`<taskId>-<32 hex>.<woff2|woff|ttf|otf>`, parsed by `@shared/cardPictures`), in-process, to GET alone: no path segments, no listing, nothing outside `crewmates/<taskId>/cards/`, nothing that leaves the machine.
- Chromium's OpenType Sanitizer re-parses every web font before the platform's font engine sees it, in the frame as in the probe.
- A body that names a kept font rides the mount vehicle, at a card host of its own, so the font engine reads it in a renderer process of its own, under the frame watchdog.
  A body on the srcdoc vehicle cannot load one at all: its policy admits fonts from the design system's `fonts` host alone.
  The app page runs in one process and the srcdoc cards share another, while each mounted card gets one of its own.

On a Mac, a font the sanitizer passes is drawn by the system's own engine (CoreText); Chrome's memory-safe Fontations engine draws web fonts only on Linux, Android and ChromeOS, and on a Mac only formats the system cannot read (Chrome, "Memory safety for web fonts", March 2025).

**What each layer catches.**
A WOFF2 cut short, or a TrueType font whose table points past its end, is refused by the host's check before any engine sees it; the sanitizer refuses both as well ("Failed to convert WOFF 2.0 font to SFNT", "DSIG: invalid table offset"), and the text falls back in either vehicle.
The test load catches a file whose structure is sound and whose data is not, such as a WOFF2 damaged inside its compressed tables, which `tests/e2e/card-containment.spec.ts` sends and sees refused.

**Residuals.**

- R1, a parser flaw.
  A crafted font that passes the check and the sanitizer could exploit the platform's font engine; precedents are CVE-2020-15999 (FreeType, exploited against Chrome) and CVE-2023-41990 (Apple's font parser, exploited on iOS).
  It stays inside one card's sandboxed renderer process, or the probe's, with no app bridge, storage or network.
  It is the same class of risk card pictures carry through the image decoders, and the defense is the same: keeping the app's Electron current.
- R2, a swapped glyph.
  A font can draw any letter as any shape, so a preview could make its text say something else.
  The author already controls every pixel of its body; the card's own questions and labels keep the app's look, and the host's chrome - the title, the footer buttons, the fact strip, the thread - is another document the font never reaches.
- R3, a stall.
  A pathological font can only stall its own frame: the size caps bound it, its own process holds it, and the watchdog tears a wedged frame down.
- R4, a font's license.
  The copy stays beside the task's pictures until the Settings purge; it never rides the body, SQLite, the cards push or the human-supervision export, which copies pictures only.
- R5, a copied address.
  A body that names another card's `app-frame://typefaces/` address reaches only a font the captain already has, as with pictures.
- R6, a font inside a picture.
  A `data:` SVG image can carry its own `@font-face` with a `data:` font, and the font engine reads that font without `font-src` being asked, in either vehicle: `img-src` admits `data:`, and an image's own fonts answer to no frame policy.
  It predates this change - `img-src data:` came with the captain's 2026-09-15 decision - and neither the host's font check nor the srcdoc vehicle's narrower `font-src` reaches it.
  The boundary there is the real one everywhere: Chromium's sanitizer re-parses that font as it does any web font, and the card's sandboxed renderer process holds whatever it does.
  A mounted card's own script has a second such path: `new FontFace(name, bytes)` takes raw bytes the script holds, and nothing on it asks `font-src`, the host's check (`readFont`) or the host's test load.
  So the sanitizer and the card's own renderer process are the boundary for every font a card draws; the host's check and its test load only show that a font the body names by path is a font that works, and stop nothing a card's own script sets out to load.

**Other computers.**
A crewmate on a computer that runs work has the check and the test load run there, by that computer's own probe, and sends each kept copy home before the card (`inf:work:typeface`), which the home keeps only under that task's own id; a paired view asks the home for a font by its minted name (`inf:cards:typeface`), and its own frame scheme serves the answer, never a path.
The home keeps what that computer sends as it keeps its pictures, trusting the check the paired computer ran; the frame's sanitizer and its process of its own still stand between those bytes and the home's own window.

## Phone cards

Both native WebKit views set `allowsLinkPreview = false`, so system long-press previews cannot load a link outside the card’s script policy.

The phone uses the same card bridge, validators and stylesheet in a generated offline bundle, but WebKit rather than Chromium supplies its web process.
`CardWebHost` owns one nonpersistent WKWebView for the shown card; native SwiftUI owns every effect-bearing footer button, close and reply outside it.
The trusted parent assigns the body as an opaque `sandbox="allow-scripts"` iframe’s `srcdoc`, never as parent markup.
Its broad inline script permission is narrowed by the child’s own `frameCsp` containing the bridge hash and the hashes of only the body’s original inline scripts.
The parent parses those scripts in an inert document and asks native CryptoKit to hash their parsed text; it never grants an external script source, event handler, eval or dynamically invented script.
Both policies refuse network connections, and the child admits only the app’s in-process font and picture scheme plus inline pictures.
Navigation delegates refuse every destination except the initial parent and its srcdoc child, including meta refresh, and deny new windows and media-capture permissions.

WebKit exposes registered message handlers to child frames too, so `frameInfo.isMainFrame` is a mandatory native admission check.
The parent accepts only its iframe’s window, binds its first bridge document and parses the existing shared message and request schemas.
Its native vocabulary is closed: hashes, drawing, form readings, watchdog replies, effect-free card actions, read-only presentation requests, a link, a draft and a task key, never an IPC channel or a caller-chosen action source.
A link, a draft and a picture leave only on the captain's own press in the body; a link must pass `isSafeCardHref` in the parent and a web scheme in native code, and then opens in the device's default browser, never inside the card.
A draft only fills the message box, which sends nothing until the captain does, and a task key opens a record only when it names a task the phone was given.
A settle card's fact strip is drawn by a second host of the same kind, read-only and with no actions.
Native code checks an action against the mounted card again and stamps it `frame`; it cannot become a footer click even if the body writes `chrome` in its message.
The core’s dispatch-time effect check remains independent.
No sign-in, invitation, pinned address, key or filesystem path enters either document.

`CardAssets` answers only bundled runtime/font filenames and the core’s minted picture, project-font and recording names.
Every remote byte comes through the already pinned connection, not WebKit networking, and memory caches have a byte bound.
Recordings arrive in bounded pieces with a stable size and a total cap.
MP4 playback uses AVFoundation with an in-memory resource loader, all external asset references forbidden, and external playback and picture-in-picture disabled.
The player receives no path or network URL; pictures and GIFs use a separate script-free, nonpersistent web view with no native message handler.
A diagram the captain taps (INF-3107) reaches that same view as a picture: the bridge writes the drawing out with no script or event attribute, the parent admits only its own drawing form (`isDrawingSource`) and none from a playable preview, and native code replaces the bundled font addresses it names with the font files themselves before showing it in an `<img>`, which runs no script and loads nothing.
Project fonts and pictures are parsed by WebKit and the system’s parsers in the web process; this is not a claim that WebKit has Chromium’s OpenType Sanitizer or Chromium’s per-site process model.
A native watchdog tears down a nonresponsive web view while the SwiftUI close, pager and footer remain outside that process.
Residuals are a browser/parser flaw, a yielding script that consumes resources while still answering, and authored pixels that lie about their own meaning, as on the desktop.
None gives an authored body permission to press a native effect button.

The native test home carries an ordinary interactive form beside attempted fetch/image exfiltration, parent DOM access, a direct child-to-native message, an effect-bearing action and an injected script.
Its journey checks the boundary result and the real home’s received calls and saved card outcomes; an answer sent on the phone is checked through the home’s past-card and thread readers.
An out-of-reach attempt must add no action after reconnection.

## The frame realm (one plugin vehicle, Phase A item 4)

The captain's A1a, reviewed here as the plan requires: a panel the captain ADDED from elsewhere - someone else's code, the first the app runs - is drawn in a sandboxed frame that loads React, the JSX runtime, the design library and a small runtime from the shell, and reaches its data only through the host.
The app's own Tasks and Activity panels run the same way, as ordinary panel folders on the same API (`docs/ui-plugins.md`, "The app's own panels are ordinary folders"): the main build compiles them into the lib (`builtin/<id>/panel.mjs` and its card views), pinned like every other lib file, and the frame grants them no gesture an added panel could not be granted.
The captain's own panels draw in the same frame too (INF-2205 piece C): no panel code runs in the app's window, and the app's own policy names no panel script source.
This is the one frame whose policy names a script SOURCE rather than a hash, so it is reviewed line by line.

The containment definition (`src/shared/plugins/containment.ts`) is:

- `panelScriptSources(mountHost)` = `app-frame://lib/` and `app-frame://panel-<mount id>/`.
- `panelFrameCsp(inlineHashes, mountHost)`: `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '<bridge hash>' '<import map hash>' app-frame://lib/ app-frame://panel-<mount id>/`.
  Every directive but `script-src` is `frameCsp`'s, character for character; `connect-src`, `frame-src`, `worker-src`, `media-src` and `object-src` stay absent (so `'none'`); there is no `'unsafe-eval'`, no `'unsafe-inline'` for scripts, and no scheme-wide `app-frame:` source.
- Unchanged for every other frame: `FRAME_SANDBOX` (`allow-scripts` alone), `frameCsp` and `FRAME_CSP` (every card body and template mount still runs scripts by hash only), the app's own CSP, `STRUCTURALLY_IMPOSSIBLE`.
- The bridge gained one request verb, `store` (op + key; the slice is the host's to bind), one host message, `store`, and now reports a body's exact height; `FRAME_BRIDGE_SHA256` moved with it.

**Why a source, and why it stays pinned.**
An ES module graph cannot be admitted by hash: `script-src` hashes cover inline scripts, and a static import names a URL.
So the two sources are paths of the shell's own scheme, answered in-process, and each is pinned twice:

1. Server side.
   `app-frame://lib/` answers only a file named in the pins the main build baked in when it built the lib (`scripts/frame-lib.ts` -> `virtual:fm-frame-lib`), and only while that file's bytes still hash to the pin; any other name, a traversal, or drifted bytes is a 404.
   In a packaged app the lib and the pins are both inside the integrity-checked archive.
   `app-frame://panel-<id>/` answers only the `.mjs` files the registry read and hashed when it mounted that panel - bytes held in memory, so a file written to the cache afterwards reaches no frame - and the registry asks the first mate for the graph's files by source, id and version (`inf:plugins:files`), which answers only for a panel of the mount's source it serves right now at exactly that version (`PersonalExtensions.framePanelDir`): never a removed panel's, a stale version, an added panel's graph under the captain's name or the other way round, a crewmate's draft unless the mount asked for that draft and the window is on the first mate's own computer, or anything while the switch is off.
   The answer crosses the connection to a window on another computer as bytes, never a folder's name; the registry holds them under the bounds the first mate's own read keeps (`PANEL_FILE_CAP`, `PANEL_BYTES_CAP`), and refuses files built for another version of the app than its own.
2. Client side.
   The document's inline import map (itself admitted by hash) carries `integrity` for every lib file and every one of the mount's files, and the boot script element carries its own; Chromium refuses a module whose bytes differ (verified in Electron 43 during the build).

**What an added panel can reach.**
Exactly the bridge: the reads and the views it was consented (the controller's `read_not_declared` and the read executor's `ReadGrant`, both from the consent record), its own store slice (`FrameMountSpec.store`, bound by the host from its id - a request naming another slice is rewritten to its own), its own cards on the stack, and nothing else.
Its gestures are declared from what it was granted (`framePanelActions`; `docs/ui-plugins.md`, "A panel's cards"), and the host checks each value like any input from a frame:

- The card actions every panel has (`cards.emit`, `cards.close`, `cards.open`) put up, take down and list that panel's own cards, each drawn by its own card view and changing nothing else; a card's own page also keeps its place (`card.keep`, at most 4,096 bytes on its stack entry, gone at Hide).
- A panel granted `tasks.board` points (`point.openTask`, `point.openRecord`, `point.peekTask`, `point.showCard`, `point.aim`), only at a task or a waiting card that board lists, or a closed task its own granted `tasks.search` found: it opens a record, brings a card forward, rests the crew summary beside its own page or the row it names in a card's, or aims the captain's next message while its own card is shown.
  It reads nothing more by pointing, and letting go of an aim, which moves nothing, needs no click.
- A panel the captain agreed may move the captain's tasks - its consent card says so in its own line, and an update that adds it asks again - runs `tasks.run`, one of the task record's six moves through `inf:task:run` and its write-time checks, named on the task's record as coming from that panel.
  Merge and discard are never moves.
- Its own page speaks to its rail (`rail.summarize`, `rail.show`): words in its own collapsed header, and whether it shows at all when its presence is its code's.

A card it puts up comes to the front, and opening, bringing forward, aiming and moving count, only while its frame holds the window's focus, which only the captain's click or key gives it (`whenFrameHoldsFocus`); otherwise a card waits behind the one the captain is reading and the rest does nothing, so a script can neither take the stage from the captain, aim the captain's words, nor move the captain's work.
Any other action id is refused (`action_not_declared`).
Its view state is the count of presses of its own header buttons, with how the latest came, and of F6's focus asks (`asks`), the task ids of the records the captain has open and the shown entry's task when it reads the board (`view`), whether it is collapsed, and, in a card's frame, that card's data, revision and kept place.
The bridge keeps the first of these pushes, `inf.birthState`, so the page counts presses from its birth; it reads nothing the page was not already pushed, and `FRAME_BRIDGE_SHA256` moved with it.
`inf.fetch` is refused (`capability_not_granted`; `net` is refused at install anyway), and it has no server code (a tree holding `server.ts` is refused at install and at every scan).
No `window.infinitary`, no parent DOM, no storage, no network, no top-level navigation, no popups, no forms, no `eval`.

A card view is part of the same pinned graph: `cards/<view>.mjs`, compiled and hashed with the panel at install, mounted at a host of its own exactly as a panel is, with the card's id in its config and its data pushed as view state.
A panel's own stylesheet is part of it too: `board.css.mjs`, a module whose default export is the file's text, pinned like any other file of the graph; the page puts it in a `<style>` (the policy's `style-src 'unsafe-inline'`), and it loads nothing.
Only the shown card has a frame, so a panel's cards waiting their turn hold no process and count against no cap.

**What one of the captain's own panels adds.**
Its frame is declared everything above that its manifest asks for, and two actions more.
`server.invoke` hands an action's name and input to its own `server.ts` through `inf:plugins:invoke`, which runs in the panel's own process (`PanelRuntimes`); the value is checked like any input and capped at a store value's size, 256 KiB, and a draft's page reaches only its draft's server.
`panel.body` tells the window whether its body drew or stopped and why, which is only the words `place_panel` reads back.
A crewmate's draft is bound apart: its own store slice, set by the host from the mount, cards that reach no stack, and no gesture that ever counts.

**Isolation.**
Each panel mount is its own host, so its own site and renderer process, like a scripted card; a runaway panel wedges only itself.
The frame watchdog is armed for an added panel: it is torn down and its served document goes with it; the panel mounts once more on its own, and a second stop shows "This panel stopped responding." with a Retry.
A page that wedges again at once never answers the four pings in a row that would earn it another reload on its own, so a runaway panel always ends at the Retry.
One that answers four pings and then wedges is mounted again each time, at most once every ten ticks; it gains nothing it lacked, since a page that answers its pings may already keep its own process busy.

**Measured through the real path** (`tests/e2e/installed-panel-containment.spec.ts`): a hostile panel added by talking - fetched from a folder, checked, consented on the host's card - that assembles its URL and the app's API name at run time to get past the install tidy-up, then tries: `fetch`, `sendBeacon`, a WebSocket, an image and an iframe on a live local server, top-level navigation, `window.open`, the parent's DOM, `eval`, `new Function`, `localStorage`, `window.infinitary`, an unpinned lib file, another mount's host, the fonts host and the personal-extension scheme as scripts, an undeclared read, a gesture, the mediated fetch, and another panel's store slice.
Every one is refused; the server counts zero requests; the other slice is untouched and the write landed in its own.
Two controls load (a pinned lib module, an inline image), so a refusal is the boundary, not a broken probe.
A second panel that runs away is torn down while its sibling keeps drawing.
`panelMounts.test.ts` pins the pins (served bytes, 404s, the import map, the policy), `containment.test.ts` the policy's shape.

**Residual.**
The lib's own code (React, the design library) runs in every panel frame; a bug there is a bug in each frame, contained by the same boundary.
The pins protect the lib's integrity, not its correctness.

## Containment model

- Host: `<iframe sandbox="allow-scripts">`, never `allow-same-origin`.
  The frame runs with an opaque origin: no DOM access to the parent, no `window.infinitary` bridge, no storage, no cookies.
- Focus: every frame also carries `allow="focus-without-user-activation 'none'"` (`FRAME_ALLOW`), which Chromium honours because the main process turns on `BlockingFocusWithoutUserActivation` (`docs/ui-plugins.md`, "Focus and the frames").
  A script cannot take focus from the main message, so the captain's typing cannot be pulled into a frame.
  Chromium lets a frame's script take focus for about five seconds after the captain's own click or key inside it, so the shell spends the page's user activation, which spends every frame's, each time focus comes back to the window's own page, while a frame holds focus each time the pointer moves over the page's own content, and each time it sees focus move from one frame to another (`guardFrameActivation`); `tests/e2e/frame-focus.spec.ts` proves it for the main message and for a panel's field.
  Where the pointer never crossed the page (frames that touch, a pointer already resting on the frame clicked into, Tab from one frame straight into the next), a script may still take focus back in the task right after its frame lost it; the shell then gives focus back to the frame the captain moved to, unless a click or key of the captain's holds the page again by then.
  Residual: on that path, a script that keeps its frame's thread busy until the captain has clicked or typed again, and only then takes focus back, keeps it.
- Frame CSP: `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '<bridge hash>'` plus, for a mount that runs scripts, that mount's own script hashes; a card body on the srcdoc vehicle has `font-src app-frame://fonts` instead.
  The bridge hash permits exactly the injected bridge (v2: actions, reads, fetch, theme, resize, links, drafts, pictures, demos, task keys, watchdog pong, focus notices).
  A card body's own inline script runs only on the mount path above, by the hash the host computed; on srcdoc nothing of the body's executes.
  Every network-capable source (connect, media, frame, worker) remains at none; `font-src` admits only the shell's own scheme, which serves the vendored typefaces in-process and, at its `typefaces` host, a preview's checked project fonts, and `img-src` only `data:`, which names no host, and that same scheme, whose `images` host serves only verified card pictures (`containment.test.ts` pins both).
- Bridge channel: postMessage only.
  The parent accepts messages exclusively from the frame's own contentWindow and zod-parses the closed envelope (`FrameController`).
  It clamps resize requests, checks links against the safe external-link policy, shows a clicked picture only when its source is one of the host's own `images` copies exactly as minted or a `data:` PNG, JPEG, GIF or WebP (`viewablePictures`, `src/shared/cardPictures.ts`) - the app page then draws it with a plain `<img>`, which runs nothing, under the app CSP's own `img-src 'self' data: app-frame:` - plays a demo only when its recording is one of the host's own `media` copies that the card's own verified body names (`demoSources`, `isPlayableDemoSource`) with a viewable poster, and starts it at once only when the window holds user activation, which a body's script cannot give - the app page plays it in its own `<video>` under the app CSP's `media-src 'self' app-frame://media`, a card's frame still loading no media - drops any action id the card did not declare, takes a task-key gesture (`rest`, `leave`, `open`) only on a key matching `TASK_KEY_EXACT` that it told that very document - so a body points only at tasks it names, and opening one is the Tasks panel's own open path, with no effect - bounds action values, refuses reads the plugin did not declare, caps subscriptions and in-flight requests per frame, and forwards `fetch` to the core's mediated seam, which refuses every call until a grant is served.

## Checklist

- [x] Escape attempts
  - Parent DOM unreachable: `window.parent.document` throws (e2e-tested, for a srcdoc body and a scripted card mount).
  - No `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads` in the sandbox list.
  - Navigation from inside the frame is sandbox-blocked; the app-level window-open handler denies anything that slips out.
- [x] Network exfiltration
  - `fetch` rejects and `<img src=http…>` never loads (e2e-tested, for card bodies and for a served template mount alike).
    A card's own script that calls `fetch` against a live local server fails, and the server records zero requests (`tests/e2e/card-containment.spec.ts`, its scripted corpus).
  - A run-time-injected `<script>` never executes inside a template or card mount: only the bridge, a plugin mount's single `template.script`, and a card mount's original inline scripts are hash-pinned (e2e-tested for both).
  - No websocket, beacon, or form submission targets resolve (`default-src 'none'`, no `allow-forms`).
- [x] postMessage spoofing
  - Messages from other windows/frames are ignored (source identity check).
  - Malformed payloads are dropped by schema validation.
  - Undeclared action ids are dropped before reaching the orchestrator (unit + e2e tested).
    An agent script calling `inf.action` gets the same check as a `data-inf-action` click - and an effect-bearing action is never declared to the frame at all, so neither can run one.
- [x] Resource exhaustion
  - The frame is destroyed with its card; one frame exists per visible card (the stack shows one card at a time), plus the prepared next card's held page, which runs none of its own code.
    Scripted card mounts are capped separately (`CARD_MOUNT_CAP`), so cards cannot exhaust the template mounts the app's own panels use.
  - A runaway script (`while (true)`, a hot animation loop) wedges only its own renderer process (Isolation, above).
    The frame watchdog in `FrameController`, armed for scripted card mounts, pings the bridge every `FRAME_WATCHDOG_INTERVAL_MS`; a frame that leaves `FRAME_WATCHDOG_MISSES` pings in a row unanswered is torn down, and the card body shows "This card stopped responding." with a Retry.
    A tick at which the main process has not answered the previous tick's question (`inf:frames:alive`) counts nothing, because the frame's answers pass through that process; a page that is stuck on its own is still torn down.
    The clock starts when the host points the iframe at the mount, not at the bridge's `ready`: a script that loops at parse time can wedge its frame before that `ready` reaches the host (observed in the e2e), so a document not born within the same number of intervals is torn down too.
    The iframe is removed and the served document unmounted; the browser reaps the orphaned process on its own.
    A miss is counted only when a tick finds the previous ping unanswered, so a throttled host clock pings less often but never invents a miss.
    A tick while the window is hidden, or while the frame sits in a collapsed or off-rail panel, counts no miss and sends no ping; the streak starts again when the frame is showing, so a hidden page is not torn down for a pause and a visible wedge still is.
    The e2e runs a `while (true)` card on purpose, asserts teardown inside the window, and keeps using the app and a sibling scripted card afterwards.
  - Residual: a script that burns CPU but keeps yielding (a loop chunked over timers still answers pings) is not torn down.
    It stays confined to its own process and to the card's time on screen - its scripts start only once the card is shown, paging away or closing the card removes the frame, and the stack shows one card at a time.
  - Body size - script included - is bounded at the source: the emit_card tool rejects bodies over 64KB before they reach storage or the renderer.
- [x] Demo recordings (docs/card-authoring.md, "Demo recordings")
  - The frame CSP is unchanged: a card body loads no media, and a `<video>` an author writes in one still loads nothing.
    The recording plays only in the picture viewer, host chrome in the app window, whose CSP gained exactly `media-src app-frame://media`; the frame scheme gained the `stream` privilege so that player can read it a range at a time, and its `media` host answers only minted `<taskId>-<32 hex>.mp4` and `.gif` names under the task's `cards/` folder, typed `video/mp4` or `image/gif` with `nosniff`, to GET alone.
    A GIF demo plays as a plain `<img>` in the viewer under the app CSP's existing `img-src app-frame:`, added only once Play is pressed and removed on Stop, at its end and when the window is hidden; the query the viewer adds to start each play from its first frame names no other file, since the host reads only the one path segment.
  - The bridge draws a Play button under a verified demo's poster and posts a `demo` message (the served name, poster, caption, length and whether to play); `FRAME_BRIDGE_SHA256` moved with it.
    The host opens the viewer only from a frame that holds focus, only for a recording the card's body names, and plays it at once only with the window's user activation; anything else opens nothing or rests on the poster.
  - A GIF recording is checked in core alone (`readDemoGif`, `src/core/gifFormat.ts`): every block walked to the trailer that ends the file, every frame's picture data decoded to its last pixel with a bounded table, at most 100 frames and 8 MB, and no loop instruction.
  - An MP4 recording is checked before any card names it: its boxes in core (`readDemoVideo`), then decoded at its start, middle and end in a hidden window of the host's own (`src/main/mediaProbe.ts`) with no preload, so no app bridge, an in-memory session with every permission, download and network request refused and only that one recording answered, and a five-second deadline; the window is destroyed after each probe, however it ends, and is never one of the app's windows (`appWindows`).
- [x] Project fonts (docs/card-authoring.md, "Fonts by reference"; the review above)
  - The mount vehicle's policy is unchanged, and so is the app CSP: `font-src app-frame:` already admitted the scheme.
    The srcdoc vehicle's `font-src` narrows to `app-frame://fonts`, so no kept font loads outside a mounted card (`containment.test.ts`; in the real app, `tests/e2e/card-containment.spec.ts`).
  - A font is checked by its own structure, then loaded in the host's probe, before any card names it; a failure at either refuses the card with what to fix, and nothing is copied (`cardImages.test.ts`, `fontFormat.test.ts`).
  - The `typefaces` host answers only a minted name, typed by its kind with `nosniff` and CORS, to GET alone, and 404 to anything else (`frameMounts.test.ts`).
  - A body naming a kept font rides the mount vehicle, so its font engine runs in a process of its own (`prototypeSrcdoc.test.ts`).
  - In the real app, a preview draws its project's font from the kept copy, a damaged copy is refused at send, and a face the same sheet names by a web address reaches nothing (`tests/e2e/card-containment.spec.ts`).
- [x] The containment corpus
  - Every vector the retired allowlists used to strip runs for real, in both vehicles, against a live local server that counts what arrives: `on*` handlers, `javascript:` URLs, `<img>`, `<iframe>`, `<object>`, `<embed>`, `<link rel=stylesheet>`, `@import`, `<base>`, `<form>`, `<video>`/`<audio>`/`<source>`, `<svg><image>`, `<use>` with an external href, `<set>` rewriting an href, `<foreignObject>` with a frame inside, a `<script src>`, and a script injected at run time.
    None executed, none loaded, and the server recorded zero requests (`tests/e2e/card-containment.spec.ts`).
  - Residual, self-inflicted: a `<meta http-equiv="refresh">` in a body does navigate that frame.
    The app CSP's `frame-src` refuses the destination, so nothing leaves the machine; the card is left showing an error page.
    The blast radius is that one card's own body, the same class of nuisance as a runaway script, and the e2e measures it.
  - Residual, self-inflicted: nested `<use>` references expand geometrically.
    Uncapped now; it can only hang the card's own frame, which the watchdog tears down.
- [x] Content provenance
  - Bodies come only from the task's own crewmate session or the first mate through the emit_card tool, and are never interpreted outside the sandbox (no innerHTML in the app document).

## Desktop annotation comments

Desktop annotation targets name only parts the current card declared for revision navigation, with bounded excerpts and text offsets.
The host admits a pick only from the frame holding focus and draws the comment popover outside the authored document.
Only the host's reply send delivers queued comments; the frame receives target identities and highlight state, never those comments.

## Not-typing key offers

The bridge's one-way `key` message offers a key, never an action or command id.
It waits until the body's handlers finish and offers only a trusted, unused, non-composing press outside typing controls.
The window accepts the current frame document only while that frame holds focus, without the gesture grace used for pointer actions.
The main process must have witnessed the exact native press in that same focused frame under the same installed map, consumes it once, and resolves only that map's not-typing bindings.
The trusted mount sets each frame's UUID name when creating the element, before its first navigation, and passes it with the offer; Electron's native focused frame must match at both the press and the offer, so a frame cannot borrow a key pressed earlier in another document.
Blur, navigation, recording and the next native press discard an earlier witness.
A frame cannot create an unwitnessed command, replay a consumed key or use another frame's focus.
Answer, Done and Decline bindings remain available inside focused card content, including plain and function keys without Command or Control; Keyboard settings warns when recording these keys but does not refuse them.
Residual: a deliberately constructed card can hide its typing control from the bridge or misrepresent whether it used a witnessed native press.
If that press matches an installed not-typing answer, Done or Decline binding, typing inside the disguised field can run that command, including Merge when it is the card's recommended choice.
The recording warning is advice, not a security boundary, and there is no additional confirmation when the key runs.
This still requires the person's matching native press in that same focused frame; a card cannot manufacture a press or borrow one from another frame.
The message adds no frame permission, network access or host action declaration; sandbox tokens and CSP sources stay unchanged, and the bridge hash is repinned with its script.
