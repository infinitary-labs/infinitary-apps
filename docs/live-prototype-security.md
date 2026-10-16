# Live-prototype sandbox security review

The checklist for the agent-authored-HTML surface (decision D-9).
Re-run this review whenever `prototypeSrcdoc.ts`, `PrototypeBody.tsx`, the frame bridge (`src/shared/plugins/bridge.ts`), the frame document builder (`src/shared/plugins/frameDocument.ts`), the frame scheme (`src/main/frames/`), the frame watchdog (`FrameController`), the frame realm's lib or runtime (`scripts/frame-lib.ts`, `src/renderer/src/frameRealm/`), or the frame CSP changes.
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
  The one live vector the sanitizer never touched: a card's own script could call `inf.action(id)` for an action carrying a `settle merge` and merge its own PR at mount, before the captain had read the card.
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
  It sends nothing: the worst a body can do is put words in front of the captain, who reads them in the box before anything leaves, as with text he pastes.
  No `window.infinitary`, no parent DOM, no storage, no network, no top-level navigation, no popups, no forms.

## The frame realm (one plugin vehicle, Phase A item 4)

The captain's A1a, reviewed here as the plan requires: a panel the captain ADDED from elsewhere - someone else's code, the first the app runs - is drawn in a sandboxed frame that loads React, the JSX runtime, the design library and a small runtime from the shell, and reaches its data only through the host.
The app's own Tasks and Activity panels run the same way, as ordinary panel folders on the same API (`docs/ui-plugins.md`, "The app's own panels are ordinary folders"): the main build compiles them into the lib (`builtin/<id>/panel.mjs` and its card views), pinned like every other lib file, and the frame grants them no gesture an added panel could not be granted.
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
   `app-frame://panel-<id>/` answers only the `.mjs` files the registry read and hashed when it mounted that panel - bytes held in memory, so a file written to the cache afterwards reaches no frame - and the registry asks the core for the graph by id and version, which answers only for a panel it serves right now at exactly that version (`PersonalExtensions.installedPanelDir`): never a removed panel's, a stale version, the captain's own panels, or anything while the switch is off.
2. Client side.
   The document's inline import map (itself admitted by hash) carries `integrity` for every lib file and every one of the mount's files, and the boot script element carries its own; Chromium refuses a module whose bytes differ (verified in Electron 43 during the build).

**What an added panel can reach.**
Exactly the bridge: the reads and the views it was consented (the controller's `read_not_declared` and the read executor's `ReadGrant`, both from the consent record), its own store slice (`FrameMountSpec.store`, bound by the host from its id - a request naming another slice is rewritten to its own), its own cards on the stack, and nothing else.
Its gestures are declared from what it was granted (`framePanelActions`; `docs/ui-plugins.md`, "A panel's cards"), and the host checks each value like any input from a frame:

- The card actions every panel has (`cards.emit`, `cards.close`, `cards.open`) put up, take down and list that panel's own cards, each drawn by its own card view and changing nothing else; a card's own page also keeps its place (`card.keep`, at most 4,096 bytes on its stack entry, gone at Hide).
- A panel granted `tasks.board` points (`point.openTask`, `point.openRecord`, `point.peekTask`, `point.showCard`, `point.aim`), only at a task or a waiting card that board lists, or a closed task its own granted `tasks.search` found: it opens a record, brings a card forward, rests the crew summary beside its own page or the row it names in a card's, or aims the captain's next message while its own card is shown.
  It reads nothing more by pointing, and letting go of an aim, which moves nothing, needs no click.
- A panel the captain agreed may move his tasks - its consent card says so in its own line, and an update that adds it asks again - runs `tasks.run`, one of the task record's six moves through `inf:task:run` and its write-time checks, named on the task's record as coming from that panel.
  Merge and discard are never moves.
- Its own page speaks to its rail (`rail.summarize`, `rail.show`): words in its own collapsed header, and whether it shows at all when its presence is its code's.

A card it puts up comes to the front, and opening, bringing forward, aiming and moving count, only while its frame holds the window's focus, which only the captain's click or key gives it (`whenFrameHoldsFocus`); otherwise a card waits behind the one he is reading and the rest does nothing, so a script can neither take the stage from him, aim his words, nor move his work.
Any other action id is refused (`action_not_declared`).
Its view state is the count of presses of its own header buttons, with how the latest came, and of F6's focus asks (`asks`), the task ids of the records he has open and the shown entry's task when it reads the board (`view`), whether it is collapsed, and, in a card's frame, that card's data, revision and kept place.
The bridge keeps the first of these pushes, `inf.birthState`, so the page counts presses from its birth; it reads nothing the page was not already pushed, and `FRAME_BRIDGE_SHA256` moved with it.
`inf.fetch` is refused (`capability_not_granted`; `net` is refused at install anyway), and it has no server code (a tree holding `server.ts` is refused at install and at every scan).
No `window.infinitary`, no parent DOM, no storage, no network, no top-level navigation, no popups, no forms, no `eval`.

A card view is part of the same pinned graph: `cards/<view>.mjs`, compiled and hashed with the panel at install, mounted at a host of its own exactly as a panel is, with the card's id in its config and its data pushed as view state.
A panel's own stylesheet is part of it too: `board.css.mjs`, a module whose default export is the file's text, pinned like any other file of the graph; the page puts it in a `<style>` (the policy's `style-src 'unsafe-inline'`), and it loads nothing.
Only the shown card has a frame, so a panel's cards waiting their turn hold no process and count against no cap.

**Isolation.**
Each panel mount is its own host, so its own site and renderer process, like a scripted card; a runaway panel wedges only itself.
The frame watchdog is armed for an added panel: it is torn down to "This panel stopped responding." with a Retry, and its served document goes with it.

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
  Where the pointer never crossed the page (frames that touch, a pointer already resting on the frame clicked into, Tab from one frame straight into the next), a script may still take focus back in the task right after its frame lost it; the shell then gives focus back to the frame the captain moved to, unless a click or key of his holds the page again by then.
  Residual: on that path, a script that keeps its frame's thread busy until the captain has clicked or typed again, and only then takes focus back, keeps it.
- Frame CSP: `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '<bridge hash>'` plus, for a mount that runs scripts, that mount's own script hashes.
  The bridge hash permits exactly the injected bridge (v2: actions, reads, fetch, theme, resize, links, drafts, pictures, demos, task keys, watchdog pong, focus notices).
  A card body's own inline script runs only on the mount path above, by the hash the host computed; on srcdoc nothing of the body's executes.
  Every network-capable source (connect, media, frame, worker) remains at none; `font-src` admits only the shell's own scheme, which serves the vendored typefaces in-process, and `img-src` only `data:`, which names no host, and that same scheme, whose `images` host serves only verified card pictures (`containment.test.ts` pins both).
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
