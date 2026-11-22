# The renderer: hot paths and the character

Renderer-side rules that keep the character and the card stack cheap and correct.
The crew orbit is `docs/crew-orbits.md`.

## Card body sizing

`ResponseCard` owns the outer scroll surface; the body frame follows the full height reported by the shared bridge.
Its `overflow-y: auto` uses `scrollbar-gutter: stable` so a width-consuming scrollbar cannot change the frame width when overflow appears or disappears.
Otherwise a fluid drawing can shrink enough to remove overflow, widen again, and repeat the height-report cycle indefinitely.
`overflow: overlay` is not a width guarantee: Chromium computes it to `auto`.
`tests/browser/card-resize.test.tsx` exercises this threshold in the real card frame, with the page drawing scrollbars as the window does.
The threshold moves whenever the card's cap or chrome does, so the test reads the cap with its drawing overflowing and gives the drawing the proportions that fit the body with the scrollbar's width taken but not without it.
It checks the settled body sits there, then grows and shrinks the body to verify sizing and single-surface scrolling still work.

`HtmlCardBody` owns the card's vertical `--space-1` inset outside the frame, while `cardStylesheet` keeps horizontal padding and uses `display: flow-root` to retain child margins in the measured body.
Padding inside an auto-sized viewport makes a `min-height:100vh` child report the current viewport height plus that padding on every resize, growing indefinitely.
Both static srcdoc and scripted card mounts share the external inset; the shared bridge, plugin/panel stylesheets and authored markup are unchanged.
`tests/browser/card-viewport-height.test.tsx` shows the static vehicle and `tests/e2e/card-viewport-height.spec.ts` emits the scripted one through the real UI; each checks the frame stops resizing with all its content inside, and verifies subsequent growth, outer scrolling and shrinkage.
This removes the host's additive feedback, not intentionally self-expanding author CSS such as `calc(100vh + 10px)`.

A static body's frame keeps its first document until that document has loaded, then takes every later body at once (`SrcdocCardBody`).
A settle card's fact strip never takes a later document: it keeps its first and takes each refresh in place (`inPlace`, `docs/ui-plugins.md` "Bridge v2").
A sandboxed frame runs isolated in a process of its own, and Chromium leaves a srcdoc swapped in before the frame's first navigation finishes without layout: the document is born, its body measures 0 high, the frame never reports a drawing, and no later srcdoc revives it.
A standalone Electron probe broke 12 of 35 such swaps made 0-50 ms after insertion, none on a frame without `sandbox` and none on a frame already loaded; waiting for the first `load` broke none.
It is reached when a card's body changes just after its frame mounts, as when opening the thread beside a lone card remounts the body and an instant revision follows (`tests/e2e/card-threads.spec.ts`, the first-mate-card reply).

## Task record and content-panel sizing

`tests/e2e/frame-scrollbar-threshold.spec.ts` independently probes the other auto-height `FrameMount` surfaces with width-consuming 15px scrollbars in isolated Electron windows.
The task record uses its real text and disclosures on either side of its normal card-height cap: the shared ResponseCard scrolling body reserves a stable gutter, so geometry and host height writes settle without a frame-width change.
No drawing is injected into that text-only surface.

A content-sized installed panel with a fluid drawing reproduced the width/height loop at the rail's measured cap.
`SidePanelChrome` reserves a stable gutter only for `content` bodies, keeping the frame width unchanged as overflow comes and goes; `fill` panels keep their existing policy.
The probe uses whole-pixel drawing heights to isolate the outer scrollbar from fractional document-viewport rounding, then verifies growth, outer scrolling and shrinkage through the production bridge.
Passive per-paint geometry, resize reports, host height writes and pictures are saved with each threshold; an unchanged surface must have no geometry changes or height writes across the final 120 paints.
There is no debounce, resize cap or bridge change.

`tests/e2e/panel-fractional-height.spec.ts` separately covers an installed panel with an unrounded, intrinsic-aspect-ratio SVG.
A fractional document can retain an inner scrollbar and narrow the drawing even when integer `scrollHeight` equals `clientHeight`; rounding the host height alone does not remove that width-dependent fixed point.
Auto-height panel documents therefore leave vertical scrolling to the host from birth (`panelStylesheet(true)`), and `FrameMount` rounds the reported height up to fit the complete fractional content in the pixel-rounded viewport.
Fill panel documents keep their own scroll policy.
The real-UI probe checks document/drawing width, fractional content fit, stable geometry, growth, outer scrolling to the endpoint, shrinkage and both themes; a separate fill-panel control proves genuine document overflow still scrolls to its endpoint.
The original before/after measurements and pictures were local evidence and are not committed.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- Live mic RMS is a module ref (`src/renderer/src/voice/liveVoiceLevel.ts`), not Zustand.
  Streaming card bodies are subscribed only by `CardLayer` in `src/renderer/src/app/stage/CardLayer.tsx`, so they do not re-render `Firstmate` or `VoiceInput`.
  The composer's growth reaches the stage as the CSS variable `--prompt-rise`, never through the store, and the stage subscribes only to whether there is a draft, so typing never re-renders it (`docs/composer.md`).
  Each key's spin kick is read from the store by the character's own drawing frame (`Firstmate`'s `kick` as a reader), not passed down as a prop (INF-1073).
  `tests/browser/typing-stage.test.tsx` holds this by count, never by time: the browser's call counters say how often `HomeMate` and `Firstmate` ran while a sentence was typed, so a busy machine cannot fail it.
  Stack visibility is `reconcileStack` in `src/renderer/src/app/stack.ts`: arrivals keep local selection, project focus holds other projects back, and every snapshot applies the card owner's exact released-update seen marks, with this window's own reported sightings drawn over them as read until the owner's mark comes back (the intent table's `seen`, `src/shared/intents.ts`).
  Reading, elapsed time and paging never hide notes; only ordinary lifecycle actions remove them.
  The card layer (`CardLayer`) reports a sighting after its shown document draws in a foreground window, and reconnect waits for fresh state before reporting again.
  The pager's new count includes the shown update until this window reports it drawn; arrow dots still locate only unread updates before and after it.
  An older home without `card-current-update-seen` keeps the legacy offer request and local unread fallback; `tests/e2e/stack-visibility.spec.ts` and `card-current-seen.spec.ts` cover retention, news and multiple views.
- The character (captain-approved spec, `firstmate/data/fm3000-character-animation-prototypes-s1/report.md`): `src/renderer/src/character/machine.ts` is an explicit input-reconciled state machine - base states idle|listening|working, one-shot emotes (greet/celebrate/ponder/confused/fidget pool: roll, yawn, orbit, the five sky fidgets, the three 6s warps and a 5.6s pretend black hole), and a `busy` parameter that carries the ember INDEPENDENTLY of state (heat is deliberately not in the state targets - listening mid-turn runs hot and cools in place).
  Attention (voice or text presence) always wins and cuts emotes short; emotes fire only from idle/working and return home through busy.
  A turn starting, or the captain sending a message, never cuts an emote: it plays to its end as the ember eases in, then returns to working, and the sky fidgets' traced figures take the wires' ember too.
  The listening shapeshift keeps two counter-rotating hexagons - the old inner square's vertices sink away by captain's call, so the flat form no longer matches the app icon's three rings.
  Fleet moments reach the character via `emoteSignal.ts` (task_landed → celebrate; turn_failed / task_finished-failed → confused; a card landing unseen → the notice pulse, `requestCharacterNotice` + `notice.ts`, which is NOT an emote and changes no machine state), a module-ref side channel like liveVoiceLevel - never store state.
  The token flicker (captain's board verdict 2026-09-23, `character/flicker.ts`) rides the same kind of channel: every usage-bearing `turn_end` (per request on Pi, per turn on Claude) flickers the character that spent it - `crewSignal.ts` routes the first mate session id to the character's queue and a task id to its orbit member - filament on the wires, `glowSpill` whispering into the halo, log-mapped over `FLICKER_TUNING` (the captain's exact parameters).
  With no flicker playing every painter runs its resting arithmetic unchanged, so the resting character is bit-identical to the pre-flicker one; how a flicker draws is judged by eye.
  `machine.test.ts` pins the captain-verified behaviors; don't regress them without a new captain call.
  Reply emotes (captain's board verdict 2026-09-22, `fm-homes/mini-default/data/fm3000-emote-prototypes-s1/report.md`) are nod/salute/tick/tuck/aww in `replies.ts`, listed once in `src/shared/emotes.ts`: `FirstmateAgent.replyEmote` fires nod, tuck and tick itself for a captain turn's delivered steer, kept note and applied personalize (never on an operational or scheduled wake), the `emote` tool offers all five, and the machine holds a reply requested while busy and plays it as the turn ends - one per turn, dropped if attention or another emote holds the character then.
  Nothing is written above the character: an emote's words reach the window only as the reply line beside the captain's message, when the turn that read it chooses them (`docs/composer.md` "The last turn").
  The sky fidgets (the captain's picks from the eleven-fidget prototype review, 2026-09-29) are `src/renderer/src/character/constellations.ts` (Orion and the Big Dipper: J2000 star positions laid out as a chart, north up and east left, the figure tracing itself line by line), `saturn.ts` (the listening hexagons as the A and B rings with the Cassini division, the square as the globe's belt, the far ring half under the globe and the near half over it), `galaxy.ts` (two logarithmic arms, the eyes in the bulge; the spin turns the angle only, never the radius - `galaxy.test.ts` pins the prototype's bug) and `algol.ts` (the eyes as the eclipsing pair, the whole light dipping at each eclipse); `sky.ts` holds what they share, the black hole's envelope first of all.
  Each keeps the black hole's shape - the same envelope, the same 16 vertices moved by it with the wires fading by each vertex's progress, under- and over-layers around the crisp geometry - and the black hole stays LAST in `FIDGET_DURATION_MS` because the pool draws by key order (`machine.test.ts` pins the order).
  The captain kept the stars in the character's own light (no ember on Betelgeuse) and left out the Dipper's pointer line to Polaris.
  The pretend-black-hole fidget's geometry is `src/renderer/src/character/blackhole.ts` (captain's pick from the three-treatment review, `firstmate/data/fm3000-blackhole-emote-proto-s1/report.md`, 2026-09-05): one inclined accretion disk whose far side is lensed over the shadow, Doppler-beamed, with escaping quanta as an explicitly stylized Hawking cue - the physics-vs-license notes in its header are part of the design, keep them honest.
  It paints an under-layer (halo, shadow, rim) before the wires and an over-layer after, so occlusion is by construction; while it plays, the crew race their orbits (`crew/rush.ts`, `docs/crew-orbits.md` "The black hole's rush"), keyed off the envelope's own schedule (`BH_SCHEDULE`); the emote's envelope, gaze and squint are the shipped ones and the eyes keep their own look over the pointer (PR 60's natural priority).
  The warps (captain's ask, INF-1750: "i want this fidget animation to look like the whole crew is traveling through space at warp speed like through a wormhole"; the captain chose all three prototype treatments with "add all 3 actually") are `src/renderer/src/character/warp.ts`: the tunnel (looking down the wormhole, rings pouring out from behind the eyes, stars stretched into streaks), the sphere (the first mate opening into a round wormhole the crew dive through) and the corkscrew (a side view of an hourglass wormhole with the crew in a spiral line through its throat).
  All three share one envelope and one schedule (`WARP_SCHEDULE`: spool, jump, cruise, exit, settle) and the captain's settings from the prototype card (`WARP`: 6 s, warp speed 1×, 120 stars); they sit in `FIDGET_DURATION_MS` just before the black hole.
  The first mate's own carriage (spin, scale, squint, the corkscrew's lean, the sphere's rim of vertices) is drawn in `firstmatePainter.ts` from `warpPose`; the backdrop (stars, tunnel, hourglass, the jump and exit rings) is painted on the crew's far canvas so it reaches the crew's 560 px square and passes behind the character; the crew's ride is `crew/warp.ts` (`docs/crew-orbits.md` "The warps").
  The phone draws the same warps from the generated settings, schedule, travel table and stars (`CharacterWarp.swift`).
  `FirstmateMachine.requestEmote(name, now, variant)` and `pinEmote` exist for tests and review pages only - the product never forces a fidget; the character's reduced-motion promise is held by `tests/e2e/last-turn.spec.ts` (a whole turn with no state change), while how each fidget draws is judged by eye.
  A theme switch (the `theme` prop) re-reads the colors on the next frame; the reduced-motion still, which has no next frame, is drawn again from its last frame's own inputs, so the same picture returns in the new theme's colors and the machine never steps - a switch the first mate makes mid-turn cannot leave the still showing work that has ended (`tests/e2e/still-character.spec.ts`).
  A new pixel ratio - the size control's zoom, or another display - leaves the size prop alone, so the moving loop refits the canvas on its next frame, and the still is drawn again the same way at the new sharpness instead of stretched (`onPixelRatioChange` in `src/renderer/src/character/pixelRatio.ts`, a `resolution` media query re-armed at each change, which the crew ring shares, `docs/crew-orbits.md`).
  The crystal is the SECOND parameter (captain's Crystal pick, `fm-homes/mini-default/data/fm3000-consult-anim-proto-s1/report.md`, 2026-09-14): `MachineInputs.crystalActive` rides beside `busy`, the machine never transitions on it, and the first mate's painter (`firstmatePainter.ts`) eases it in only while working to fold the tesseract into the hexagonal bipyramid of `src/renderer/src/character/crystal.ts` - cool-white light, ember banked at half in the eyes and cores, `CR` is the captain's tuning.
  Its one driver, the first mate session's open `consult` calls, went with the consult feature in `15a1ac9` (2026-09-15), so nothing raises it today; the geometry is kept for the next parameter that earns it.
  Folding is the THIRD parameter (captain's Cinch pick, INF-3011): `firstmate_state` carries an optional `folding` while the first mate shortens its conversation, the store keeps it beside `firstmateBusy` with a count of the shortenings begun (`firstmateFoldStarts`), and `Firstmate.tsx` takes both as props, gated by the working state like the crystal, so the machine carries `folding` and never transitions on it.
  Pi relays the shortening as its `compact_context` progress (`piEvents.ts`); Claude's client says it in `system/status` messages (`compacting`, then a status with a `compact_result`), which `claudeRollingSession.ts` turns into the same progress, and a `compact_boundary` with neither becomes a start and an end at once; the first mate agent broadcasts each edge as a `firstmate_state`.
  `src/renderer/src/character/cinch.ts` owns the look - the envelope (`cinchFrame`: throw and draw tight over `inMs`, a pump on `rhythmS` while it holds, a spring back past its size over `outMs`), the motes, the ring and `CINCH`, the captain's settings - and its `CinchClock` begins a cinch on each new start, so one heard only ending plays the start and the end back to back.
  The phone draws the same look from the same numbers (`CharacterCinch.swift`, `cinch` in the generated scene data, its frames checked against the desktop's own readings in `PhoneCinchTraces.generated.json`); `tests/e2e/character-cinch.spec.ts` watches the character draw in during a held shortening on the Claude seat.
- The stage clock (`src/renderer/src/character/stageClock.ts`, FI3-398) is the one time source for the home character and its crew: both animation loops call `stageClock.advance(frameTime)` and paint from the stage time it returns, and anything the stage will animate is stamped with `stageNow()` - never `performance.now()` or the raw frame time, or it would run ahead of a slowed stage.
  `CrewOrbit.tsx` is the one writer of `stageClock.target` (1, a tenth inside the formation's zone, 0 on a crewmate; `docs/crew-orbits.md` "Slowing near the pointer and the crewmate summary").
  Two things stay on real time on purpose: the theme re-read timers, and the first mate's eyes (`drawFrame`'s `eyeDt` drives the blink, the gaze spring and the pointer's pull), which keep blinking and following the pointer through a complete pause.
  At rate 1 stage time equals the frame time bit for bit, so a stage nobody has slowed paints exactly as before.
- The first mate's working-state glow deliberately diverges from the design skill's `components/mate/Firstmate.jsx` mock (which also predates the eyes and emotes - the app is the character's reference implementation now): the mock sets `ctx.shadowBlur` per primitive, the app composites one blurred mask per character (`src/renderer/src/character/glow.ts`).
  Same picture, 4-13x cheaper, plus a dpr fix - Canvas2D measures `shadowBlur` in device pixels and ignores the CTM, so glow width must carry an explicit `* dpr`.
  Do not "re-port the mock verbatim" over it.
  Derivation and fidelity measurements: `firstmate/data/fm3000-neon-halo-proto-s1/report.md`.
  The pipeline's first two executions cost 5-10x a warm run (offscreen allocation + Skia blur warmup), so `drawFrame` warms it once on the character's first idle frame (`warmNeonHalo`, erased by the same frame's clear) instead of paying that mid-morph on the first idle->working transition; `glow.test.ts` pins that every warmup stage runs for real.

### Stage entrances

Each stack entry on the stage is a `StageEntry` keyed by its mount (`stageSlots.ts`), inside the measured shell, leaving the pager and geometry outside it.
Entrance eligibility is captured at birth: the initial cards read is static, and only an entry born shown on an otherwise empty stage takes the arrival - a fade, a 12px rise and a growth from 98% over `--dur-arrive` (420ms) - and its body's first-draw fade.
A replacement never takes an entrance; it moves (below).
Revisions and responsive updates do not remount an entry.
Reply history predating the document is static; new message ids reveal once per document, even when a hidden card returns.
Working rows reveal on subsequent appearances.
Closing and busy/disabled state never wait for motion, and the shared reduced-motion duration token cuts entrances.
Task-pane motion is deliberately not added: FI3-309/310 supersedes that layout with a record entry in the same card stack.

### Replacement presentation and the prepared successor

FI3-596's approved rendering, with FI3-711's next-card rule and FI3-871's held preparation.
The stage keeps its ordinary pair of documents mounted (`stageSlots.ts`, a pure reducer with its own tests), plus a populated Info document only during the same task’s tab visit:

- **Shown**: the selected entry, in flow; the shell measures only it.
- **Prepared successor** (`warm`): the entry a close would bring up - `dismissalSuccessor`, the same action-specific `departureIndex` rule the stack uses, never the next arrow - drawn invisibly at its own final width once its thread history is read, with only its body (no chrome), inert and hidden from assistive technology.
  Hide on a task record or past card prepares the first live card, even if already read; ordinary departure prepares the first unread card, falling back to the live card after the shown one, then the one before it, then a held entry.
  Any ordinary ready card is prepared, with a script or without: its page is born held (below), so nothing of its own runs before it is shown.
  Task records and past cards are read when shown, since opening a record marks its filing opened, and a card still being written waits until it is ready.
  Nothing is prepared behind a hidden window, and preparing marks nothing read, folds no rail and moves nothing on screen.
- **Leaving drawing** (`outgoing`): the entry that was on screen, kept inert and hidden from assistive technology in exactly the box it was shown in through its move; paging and replacements may hold it until the selected entry gets ready.

When the shown entry changes, a prepared successor is promoted in place: the same frame and document, never moved in the DOM or rebuilt (slots keep their birth order, because moving an iframe reloads it).
A task’s populated Info document can also stay parked while its Crewmate or Browser tab is selected (`docs/task-card-tabs.md`).
That document remains invisible, inert and in birth order, with live subscriptions; leaving the task releases it.
Any other destination mounts afresh.
Paging and replacements retain the leaving drawing while the selected card gets ready, with a shield taking clicks meant for the held drawing.
A card that leaves the stack starts its drop immediately, independently of the next body’s readiness; choices, confirmed closes and withdrawals share this path.
An unready successor stays invisible and unavailable to interaction until its body draws or its wait ends (below), then fades in; retiring a departed drawing never reveals empty chrome.
Decorative peeks belong inside each entry drawing (`CardPeeks`), sharing its opacity, transform and lifetime; the stack envelope owns only placement and the pager, never a separately painted border.
The incoming drawing owns the peeks' one-place lift, so a pending successor cannot leave them visible after a departure.
The selected card is ready when its current document drew at its width (`FrameController.onDrawn`), or shows a usable error or Retry.
Its document is the one its body frame draws: a settle card's body less the host's fact strip, which draws in a frame of its own above the buttons (`drawnBody`, `stage/entryView.ts`).
The host rewrites that strip as its facts come in, such as the lines a change adds and the checks' ages, so a new fact leaves the drawn body current and never holds the card's seen report (`useSeenReport`) waiting for a drawing that does not come.
A height a frame's page reads before the frame's width reaches it, at width 0, is not taken (`FrameController`): a page in a process of its own can lay out there first, every word on a line of its own, as a card's fact strip does on Linux.
Taking that height would grow the strip to thousands of pixels and flash a scrollbar that narrows the card under every frame's drawing, so the strip's drawing would wait for its page to follow the card's width there and back (INF-4619).
A drawing reported while the frame is briefly at another width, as when a scrollbar comes and goes on Linux, waits and counts once the frame is back at that width; a newer report or a new document replaces it (`cards/drawnAtWidth.ts`).
A wait that never becomes ready ends after the frame watchdog's budget, counted from the selection, and the entry appears as it is, never counted as ready: a paging or replacement hold, and a successor whose departed drawing has already dropped away.
The stylesheet narrows a lone card at once when a panel docks or the window shrinks (`STAGE_CEILING`), before the stage's own layout catches up, so a body can draw at its new width under a key that still names the old one.
Its drawing counts once the stage's layout names the same document and the shown entry is laid out as wide as when the body drew.
A task record is ready once its own record has loaded and its body frame has drawn once, or it could not be read (`RecordCard`, INF-510).
Opened on an empty stage it stays unseen until then (`selectSlots`' `waits`), so it appears once at the height it keeps.
While waiting for readiness, the unseen incoming entry lays out at its natural height, both on an empty stage and when replacing a card.
The shell still holds the previous drawing’s rectangle, but does not constrain the incoming entry to that height: a body frame below the held scroller’s visible edge would get no drawing frames and could not report readiness.
A record whose frame never reports appears as it is when the hold ends.
A prepared page with a script that drew held is ready only once the card is shown, its scripts ran and it reported its drawing again.
Readiness and the shell's natural height read laid-out sizes, so a card still scaling into place (the arrival, a card coming forward) counts at its own width and height.
A ready entry appears by one move, and the next successor is prepared once the leaving drawing has retired and the incoming reveal and the height easing have both finished.
An interrupted reveal releases its pending completion when it is cancelled, so returning to the drawing still held can settle without waiting for a finish event that will never arrive.
The next selection interrupts the reveal of the one it leaves even when the leaving drawing has already retired, as after a close, whose drop is shorter than the next card's coming forward (INF-1154).
`cards/stageMoves.ts` decides the move once, when the drawing starts to leave, and plays it (design skill CardStack): an arrow pressed on the drawing's card slides both 32px with the arrow over `--dur-page` (300ms); a card that left the stack drops away over `--dur-quick` (200ms), with a ready next card coming forward from the stack's edge and the peeks moving up one place; anything else crossfades over `--dur-fast` (160ms).
A prepared card that drew held comes forward the same way, starting when it is ready rather than with the drop (`playIncoming`); a next card that was not prepared, or had not drawn, fades in when it is ready.
At an outgoing animation’s finish, React removes or parks its drawing synchronously before the filled effect is cancelled, so no connected outgoing drawing regains its original opacity or transform.
The cancellation still releases the effect before a retained Info document returns.
When the stack empties, the layer stays mounted until the last drawing has dropped away (`CardLayer`'s `onEmptied`); a card arriving meanwhile retires that drawing at once.
The drawing of a card that left the stack is never shown again: put up again before the entry that took its place is ready, the card retires that drawing and is born afresh, so Hide lets its place go (a panel card's `kept`, a record's open question).
Rapid paging never queues: an entry that never appeared is dropped, the drawing on screen stays, and going back to a drawing nothing has replaced yet shows it again as it is; once a replacement has appeared, every selection mounts afresh.
A prepared or leaving body raises no action, link, picture or interaction, and the answers its form posts become the card's saved draft only once it is shown.
The shell shares one focus fallback: when no usable focused control remains (removed, disabled, hidden or inert), focus goes straight to the available main prompt, never by way of incoming card controls or another pager arrow.
A live control keeps focus, including the read-only reply field through a lone-card send.
Settings and the first-launch gate do not recover to an absent or disabled prompt; returning home or enabling the prompt makes the fallback available again.

`useCardPresentation` owns the shell height.
Initial thread history resolves before a body is born, so a card/pair is not born at a provisional width.
Stage widths and folded rails resolve without easing; widths never tween.
The shell stays at the previous height, bounded by current chrome and the stage envelope, until the shown entry is ready, then eases height only over the shared 360ms with the glide (`--ease-out`) and a fixed centre.
An entry revealed by expiry follows the held shell again while its body is pending, rather than keeping its unseen natural layout, so later body growth cannot move a control during a pointer press.
The easing ends when its animation finishes, even before the deadline the shell read from the page's clock: the animation's clock can start a frame earlier, and the shown card settles then, so the next successor is prepared (INF-624).
A press on the card holds it still until the release, so the control under the pointer stays under it, then settles at once.
That holds while the height eases and when it would jump with no easing, as a task record's does when its live facts change after it appears.
The pager stays below the maximum-height envelope; its cap reserves a separate lane for the last turn above the input, so neither intercepts the other's controls.
Reduced motion makes every move and the easing cuts.

A live card, its thread and its one field share one surface (`CardSurface`): a grid whose columns change when the thread opens, closes or moves, while the card, its body document and its scroll surface stay the same elements.
The field moves between the card, above its buttons, and the thread's foot; its draft and attachments live in the shell by the card's id, and it carries the focus across the move (`ReplyRow`).
Opening the thread under a lone card therefore keeps what the captain did in the body - a preview's state, an open disclosure, scrolling, drafts and attachments.
A beside thread preserves the body's drawn witness when its document, theme and column width are unchanged; an in-place thread keeps a separate drawing identity.
This lets an actually drawn final answer clear its exact-update new mark without paging away and back.

The bridge's per-document identity and `initialize` handshake put theme, width and form state ahead of DOM readiness, fonts and two drawing frames.
`FrameController.onDrawn` is the reusable first-draw seam for cards and other frame surfaces; birth and provisional/zero resize reports are not drawing.
Stale documents are rejected.
Resize reports remain intrinsic, coalesced per paint, with immediate ceil height and the existing 48px floor; none consume animated shell height.
Live DOM changes and frame interaction cancel geometry, while passive initial corrections use only the original deadline's remainder.
Natural measurement temporarily releases the shell constraint before paint, then restores scrolling.
Same-entry growth, drafts and controls remain instant.
Resize/drag/focus, reduced motion and error/Retry also remain usable.

How a replacement draws is judged by eye and by recordings; the journeys through it (paging, a reply draft kept across paging and a card-body disclosure in `tests/browser/phase4-cards.test.tsx`; the shared minus, the next-card rule and a lone card's reply keeping its body in `stage-reveals.spec.ts`) are end-to-end and browser tests, and `stageSlots.test.ts` and `stackActions.test.ts` own the lifecycle and selection ordering.
Shared e2e helpers read the shown entry (`tests/e2e/stack.ts` `SHOWN_ENTRY`): a prepared or leaving entry is never "the card".

### Held preparation

FI3-871's design: the stage prepares the next card ahead without letting any of its own behavior start unseen.
A card's page, in either vehicle, is born held (`buildFrameDocument`'s `held`, read by the bridge in `src/shared/plugins/frameHoldScript.ts`); a panel's page never is.
Held, the page loads its markup, styles, fonts, pictures, theme, width and task links and draws, while each `<script>` it carries, every CSS animation and every SVG timeline waits.
The bridge holds a script before the parser runs it, through a mutation record the parser delivers first, and keeps the served markup and every hash as they were.
When the stage shows the card, `FrameController.activate` sends one `activate`; a card nobody prepared is activated as its page is born.
The page then releases once its markup is read: the scripts go back in order under the same hash and run, a `DOMContentLoaded` or `load` listener they add runs once, the animations resume, and the form starts, so its baseline is what the body shows after its scripts.
It reports its drawing at once rather than on its next frame, because a hidden frame's frames are throttled, and its first two frames after the release settle the drawing rather than count as a live change.
So scripts behave like `defer` in every card, prepared or not.

The bounds stay where they were: one prepared card, chosen by the same rule; the ordinary document pair plus the same-task parked Info document; a closed card leaves at once; a new version, width or theme prepares afresh (the draw key); a hidden window drops the prepared page; the watchdog runs from the mount.
A prepared page that was refused or stopped is not shown as such: shown, the card mounts afresh, and Retry belongs to that mount.
A prepared scripted card costs one more idle renderer process while it waits.
Not held: animated GIF and WebP pictures, `<marquee>`, and `@starting-style` entrances.
A slow synchronous start still costs its time after the click.

`tests/e2e/stage-reveals.spec.ts` shows a prepared scripted card doing nothing before it is shown and starting on the same page once it is, and a card whose own script fills its settings closing without asking; `tests/browser/stage-reveals-plain-next.test.tsx` shows a plain card's animation waiting the same way; `frameController.test.ts` owns the activation order.

### Timing marks

The stage leaves User Timing marks in the window's own performance timeline (`cards/stageMarks.ts`); they stay on this Mac.
Each selection that replaces a shown card leaves one `stage:select` mark whose detail names the card and one outcome: `hit`, or the reason it missed - `other-card`, `not-drawn`, `stale`, `slot-busy`, `settling`, `held-view`, `streaming`, `window-hidden`, `thread-pending`, `in-place`, `mount-failed` or `none`.
Milestones follow as marks of their own, each naming its slot: `stage:promote` or `stage:mount`, `stage:born`, `stage:drawn` (held when the page waits), `stage:activated`, `stage:visible` and `stage:settled`.
The timeline keeps the last 200 selections' marks and then starts over.

### In-place reveals

`design/reveals.css` is shared by the shell, card/template frames and panel frames.
Disclosure bodies, Projects policies and Tasks groups reveal once per open with opacity and a 4 px settle down from the header over `--dur-fast`; initially open groups are static and close unmounts immediately.
Settings sections are keyed by tab id and fade on post-boot entry and replacement; tab color eases without moving the underline.
State and controls never wait for animation.

Activity captures the first snapshot's keys.
Only later rows born after the frame document fade in (opacity only); old rows brought into a retained window and initial snapshots stay static.
Row identity, bottom pinning, `feed:render` and `now:render` work accounting remain unchanged.
Rail mounts capture boot eligibility before asynchronous content arrives, then fade their frame once at initialized `onDrawn`, never on data/theme pushes.
A user reopening a dock may reveal its new document.
Card first draw retains its stage-owned policy.

Native `details::details-content` transitions in the shared stylesheet cover bare text as well as elements, including record bodies, without rewriting markup or author scripts.
Initially open markup has no previous style and is static.
Only opening has a transition; closing cuts content visibility.
Content visibility itself never transitions, so an opened body's controls take focus at once: a transition to it would hold the body hidden until the fade draws its first frame, and a key pressed right after opening would miss them.
`tests/renderer/detailsReveal.spec.ts` owns that rule.
The reduced-motion tokens cut in-place drift and details transitions; the existing opacity-only frame first-draw opt-in uses `--dur-fade`.

## Solid cards and task-record stack

FI3-309’s accepted answers replace the gutter pane with shell-held `records` (one per task), projected into `visibleStack` before persisted cards.
Opening focuses the task at the front immediately; navigation, arrivals and unread tracking share the same index.
Hide/Esc removes only the shown record; stage clicks do nothing.
`RecordCard` uses `ResponseCard` with the record chrome and lifecycle footer, regular sizing/drag and the ordinary scroller, no thread/reply.
Tasks pushes all open ids as selected-row view state; record row anchors and pane geometry are retired (a rested row's box rides the separate `peek` gesture for its summary, `docs/crew-orbits.md`).
A turn carries only the shown entry’s task id or card id, never both.
No wire, storage or bridge change.

Past cards (FI3-579 piece 2) are the same kind of shell-held entry: `records` also holds `{ pastCardId }`, one per saved card, projected into `visibleStack` (`past:<id>`) beside task records and closed by the same Hide/Esc (`closeRecord`, `closePastCard`).
`openPastCard` is the one opener.
The shared show-card door reaches it: `inf:cards:show` (catalog action `show-card`) returns an open card to the stack, or for a closed card broadcasts `past_card_shown` (`window.infinitary.cards.showPast`, `inf:cards:show-past`, takes the closed-card half alone), and `applyEvent` calls `openPastCard`, so the first mate and the shell's own gestures (the record's Cards row, `RecordCard`'s `open-card` frame action, takes the same door; the filter's caller arrives with a later piece) open the same entry and live-card focus is untouched.
`PastCard.tsx` reads the closed card once (`inf:cards:past`, a pure read of `CardStore.past`: the version the stage last showed, how it ended, the submitted answers, the thread) and draws it through `HtmlCardBody` with `declaredActionIds` empty and the form `readOnly`, so the frame fills the saved answers and disables every control, present and added later, except a demo's Play button, which only opens the viewer; the footer shows the offered actions disabled with the chosen one marked and, under them, what the card's field sent with the choice (its words, each note drawn as a sent reply draws it, and the pictures by name, from `PastCard.carried`), and the thread column has no reply row.
Only the shown entry supplies the turn hint, as `pastCardId`; the core adds one `about` line saying the card is history.
Nothing is stored, no effect is reachable, and a past card never becomes a card.

The reply note (INF-1103, `docs/composer.md` "The reply note") is one more shell-held entry: `records` holds at most one `{ replyNote }`, the captain's message and the first mate's reply words as they stood when it opened, projected as `reply-note` and drawn by `ReplyNote.tsx` through `ResponseCard` as a plain-text note with no actions or reply row.
`openReplyNote` is its one opener, from the reply line's click and the `firstmate.reply` command, and Hide/Esc closes it through `closeRecord`; it supplies no turn hint, and nothing about it is stored or sent.

Both effect-token homes paint `--bg-2`, no blur, `--line-1` and the previous shadow; peeks also drop their old element opacity, which would otherwise make even opaque paint translucent.
The record reports its initialized draw to the shared presentation shell and lets its frame take the full intrinsic height, leaving ResponseCard as the only scroller.
Frames and the picture viewer are unchanged.
`HomeMate` fades the whole mounted character frame (orbit and labels included) to opacity zero and delayed visibility hidden over `--dur-slow`, and back without a visibility delay; reduced motion snaps.
Stack presence is independent of recording phase.
Animation loops, state machines and agents continue underneath, at full speed (a hidden frame never slows or pauses the stage); the pager is the notice while hidden.
After the fade, those loops skip canvas drawing and the per-frame name placement until the character is shown again.
A canvas that holds no picture yet, because it mounted behind the stack (coming back from Settings, say) or its backing was resized there, still draws once (`character/paintHidden.ts`).
The reduced-motion still always draws, because it has no next frame to catch up on when the character shows again.
The state name on the character stays current, because it is the signal, not the paint.

## Maximized cards (FI3-1133)

The shown card's size control (the design skill's `components/cards/ResponseCard.prompt.md`, "Maximize") makes it nearly fill the app's window, and the window itself does not change.
Which entry is maximized is the card layer's own state in `stage/CardLayer.tsx` (`MaximizedAt`, `src/renderer/src/cards/cardMaximize.ts`): the entry and the main message's focus request it was maximized under.
Each newly shown entry starts from `appearance.defaultCardSize`; Usual retains the host's width, Wide and Full widen it through `openingCardWidth`, and Maximized seeds that entry's maximized state before it paints.
A manual maximize or restore lasts for that visit only, including revisions, and a request to focus the main message restores it.
Paging, the layer remounting after Settings, and restarting start from the saved default again; the default is persisted, never the per-visit override.
With Keep cards maximized on (`appearance.keepCardsMaximized`), `toggleSize` also saves the size it chose as `appearance.cardsMaximized`, and the layer seeds every newly shown entry maximized while that is true, so a maximize or restore (the button, Escape or the command) carries to every card until the next one.
The prepared successor uses that same default so its document draws at its destination width.
`entryView` places a maximized entry with `maximizedPlacement` (`cardGeometry.ts`): the window's width less 32px, and an open thread beside it at its own width rule.
The layer then hangs 16px under the top bar instead of centring on `STAGE_TOP`, and sets `--card-max-height` (the window less the top bar, 32px of air and the pager's 40px lane) for everything inside it, so every card's cap (`CARD_MAX_HEIGHT`) and the task browser's page room read it; the shown entry also sets `--card-floor`, which its outer surface's floor (`cardFloor`) reads, so a short card fills the room.
`html[data-card-maximized]` (with `data-rails-folded`, so the stage is the whole window) hides the rails and the main message (`design/styles.css`), which keep running with their state.
The entry, its frame, its answers and its reply stay mounted: only the layer's style and the entry's widths change, the presentation shell's safety key counts the change so its height lands without easing, and the stage's lift transition is off for the drawing a change of size lands in.
`holdReadingAnchor` keeps the body's reading place while its frame reflows at the new width.
The keyboard side is `docs/keyboard.md` ("Cards and frames").

## Whole-window size (FI3-489)

Settings → Appearance offers Size at 100, 110, 125 and 150%.
It zooms the whole window, including frames, drawings and spacing, rather than multiplying type tokens.
The core's appearance row owns it; missing on older records means 100%.
Cmd+/Cmd− (Ctrl on other platforms) and the View menu move through the same choices, bounded at either end; Cmd0 / Actual Size returns to 100%.
Every way of choosing it - the picker, those keys, the View menu, command search and the first mate - is the `window-size` catalog action (`src/shared/actions.ts`) on `inf:settings:appearance:set`, so it leaves an operation and a feed line naming who made it: one for each change the first mate makes, and one for a run of the captain's steps, from the size it started at to the size it settled at (`docs/orchestrator-contract.md`, "Settled runs").
The keys, the menu and command search share one queue of steps (`Shell.size`, `sizeCommands` in `main/windowSize.ts`) and send each through the window's one door, `Shell.dispatch`, as the picker's choice goes: this Mac's core as the captain, or this Mac's own look while it controls another (`docs/view.md`).
Each step starts from the size the one before it saved, so a held key still climbs.
`main/windowSize.ts` applies the saved choice before paint and after navigation.
The picker shows a choice at once, as every appearance control does, and the window zooms once the core has saved it; a refused choice shows the saved size again, with the reason beside Size (`src/renderer/src/app/appearance.ts`).
The character checks its backing against current device sharpness each frame without restarting its pose.
Regular cards use the existing temporary rail fold whenever expanded side panels leave too little room for their requested width.
The main message folds them the same way, with no card up too, where they would leave it too narrow ("Docked rails and the input's room").
A collapsed panel header takes no card room, so it never causes a fold.
Window minimums and the thread's separate placement ladder are unchanged.

`window-size.spec.ts` exercises all four choices, regular-card room at the normal and minimum window, the collapsed panel headers kept clear of the main message, the main message usable between two expanded panels, a lone expanded panel kept clear of it, live canvas backing, other appearance writes, menu and shortcut synchronization, each change's feed line, the first mate's change when asked, and restart persistence using throwaway data.

### Short windows

A short page leaves a card little to read.
A 1280 × 720 screen, common on small laptops and remote desktops, leaves the window about 650px, and a larger size makes the page shorter still: at 150% a 1200 × 800 window is 533px tall to the page, and the smallest window 427px.
The stage's vertical layout is fixed pixels, so the room under them went to the card first: its body shrank to a line, and its buttons and title were cut off.
`--stage-squeeze` (`design/styles.css`) is how far the page falls short of 864px, up to the 144px of air the stage can spare: 864px is the lowest page that gives a 720px page all of it.
The air gives way in proportion, all of it together: the 46px between the top bar and the stack (`--stage-yield-top`), the 14px between the pager and the last turn (`--stage-yield-lane`), and 84 of the 96px under the input (`--prompt-floor`).
The card's cap (`CARD_MAX_HEIGHT`), the input's foot and the stage's centre (`STAGE_TOP`) read those variables, so a card keeps the room it has in an 864px page down to a 720px one (a 1280 × 720 window, or 125% in a 1440 × 900 one), and below that gives way only as much as the page does.
The input's foot sits at the same place with a card up or not, so it comes down in a short page on the home screen too.
This short-window adjustment moves nothing at 864px and taller.
The notices under the input publish their height (`--prompt-notices`, written by `HomePrompt`'s `usePromptFoot`, `app/promptFoot.ts`), and the input's foot never comes down past what they need, so a notice is never cut off; whenever a notice needs more than the reserved space, the input and the card make room for it.
`promptShellMax` keeps its own arithmetic: the air given back only moves the input's top further from the first mate's frame, so its bound stays safe.

Below that, the card itself gives way, and only its reading space does.
`ResponseCard` holds the title, the revised line and the body in one middle scroller (`data-card-middle`) between the head and the rows under it.
The body yields first, as before; when the middle cannot hold the title and the body's box together, the title scrolls up out of the body's way rather than the buttons being cut.
The middle is a reversed column, so it starts scrolled to its end with the body in sight, and `order` keeps the title on top and the reading order as written.
That matters beyond looks: Chromium does not render a sandboxed frame that is out of sight, so a body clipped out of view never reported its drawing, and the stage held the previous card for the full hold limit before showing this one undrawn.
The middle's own scrollbar is hidden so it takes no width from the frame; the body's bar shows there is more.
A card too short even for its head and the rows under it scrolls as a whole rather than cutting them off: at 150% in the smallest window, while a notice takes room or under several rows of chrome.
`cardPresentation` counts the head, the title, the revised line and the rows as chrome and observes them, never the middle itself.
`window-size.spec.ts` ("a card in a short window keeps its reading room and every control") checks that a card first shown at 150% in the smallest window draws with its controls whole, that a 1280 × 720 window gives the card the room it has at 1280 × 864, that at 1280 × 650 and at 150% in a 1200 × 800 window the card gives way only as much as the page with its title and controls whole, and that a notice under the input stays on screen.

The Crewmate tab follows the same rule through `RecordPaneChrome`'s optional `data-record-middle`: its title, tabs and transcript scroll together below the pinned top row.
The transcript shrinks to its one-line floor first, then the title and tabs give way, leaving the status line and whole message box in sight.
The reversed middle disables scroll anchoring so Chromium does not keep the title visible as the input grows.
Its heading clips the tab underline, and keyboard focus scrolls the tabs back into view.
`useFootRoom` reserves only the pinned top row; the foot trims its bottom padding to `--space-2`, and the whole-card scroll remains the last resort below that.

### Collapsed headers under the input

A collapsed side panel at a rail's foot keeps its header on the rail and takes no card room, so on a narrow page the input shares columns with the Activity and Tasks headers.
Where the input's foot comes down to their top it would be drawn over them: in a short page (a narrow window under 864px tall, such as 1100 × 720 or the smallest window, or a short window at a larger size), or over a stack of collapsed headers at any size.
`usePromptFoot` (`app/promptFoot.ts`, in `HomePrompt`) measures the collapsed panels at a rail's foot that share columns with the input, each only within its rail so a folded rail counts for nothing, and publishes how high the highest reaches above the floor as `--prompt-panels`.
A rail that already ends above the input, because it holds an expanded panel ("Expanded panels beside the input"), has no header at its foot for the input to stand on, so its collapsed panels count for nothing either.
With no card up, `--prompt-floor` is the larger of that and `--prompt-floor-base`, the foot the window and the notices give, so the input stands on the headers, and the card's cap and the stage's centre follow it as they do for a notice.
While a card is up (`data-card-stack-open`) the floor stays at `--prompt-floor-base`, so the card keeps the room the short-window rule gives it.
The headers the input would stand on then step aside: while `--prompt-panels` is above that base the hook marks the document (`data-prompt-on-panels`), and the collapsed panels at the rails' feet are hidden in place, keeping their boxes and running pages, skipped by F6, and back when the last card goes.
The mark reads only the headers' boxes and the base, never the floor it decided, so a header stepping aside cannot undo it.
A foot the headers lift takes the composer's growth down with it (`promptShellMax` less the lift), so the input's top still stops at the first mate's frame; the two floors are registered lengths (`@property`) so the hook reads them back in px.
`window-size.spec.ts` ("keeps the collapsed panel headers clear of the main message") checks at every Size, in a 1200 × 800 and the smallest window, that each drawn collapsed header shares no area with the input's box, with no card up and with a regular card up, and that the card stays clear of the input.

### Docked rails and the input's room

The input is `min(560px, 100vw - occupied rails - 32px)` wide (`PROMPT_WIDTH`, `HomePrompt.tsx`), centred on the window under the first mate.
With Activity and Tasks both expanded, the smallest window at 100% leaves it 328px, which is what the design is drawn for: every hint has a form that fits its one line beside Add files (`docs/composer.md`).
A larger Size makes the page narrower than that window, and between the rails the input would shrink with it: to 241px at 110% in the smallest window, 136px at 125%, and 21px at 150%, where Add files no longer fits.
With no card up no card folds the rails, so the input would keep only the room between them.
`PromptRoom` (in `HomePrompt`) reads what the docked rails ask for (`useShellLayout`, `--rail-docked-*`), never what they take, and `promptFoldsRails` (`app/promptGeometry.ts`) says whether they would leave the input under `PROMPT_MIN_WIDTH`, 328px.
Then the rails fold as they do for a card, through the same mark (`data-rails-folded`, `design/styles.css`): they give their width back, keep their panels and running pages, and come back when a wider window or a smaller Size gives the room back.
The mark has one writer, `foldRails` (`app/shellLayout.ts`), which holds it while either the card layer or `PromptRoom` needs it, so a card leaving never unfolds rails the input still needs folded.
Reading the ask, not the effective width, keeps the fold from undoing itself; saved panel choices never change.
At 100% it never folds, since the smallest window leaves exactly 328px; with both panels expanded it folds at 110% in a window under 1,056px wide, at 125% under 1,200px, and at 150% under 1,440px, and with one panel expanded only at 150% under 990px.
With no card up there is nothing to give up for the room, so no Show panels edge tab shows.
Whenever it folds, any card would have folded the rails too, since no card is narrower than 480px, so a card coming up or going changes nothing.
A folded rail's panels are out of sight, so they are out of reach too: the rail turns `visibility: hidden` once its slide ends, so F6 and Tab skip them (`docs/keyboard.md`, "Parts of the window"), and shows them again at once as it opens.
`window-size.spec.ts` ("keeps the main message usable between two expanded side panels") checks at every Size, in the smallest, a 1080 × 720 and a 1200 × 800 window, with both panels expanded and no card up, that the input lies in the window, Add files is whole inside it, the hint its empty field shows fits that field's one line, and no drawn side panel shares area with it.

### Expanded panels beside the input

The input is centred on the window, and its width leaves room for the rails on both sides together, so with one rail docked it reaches across into that rail's columns on a narrow page.
An expanded panel stands on its rail's floor, so there it would run under the input.
`usePromptFoot` marks each rail with an expanded panel whose columns the input shares, with `--space-4` of air to either side, as `data-rail-lifted`; a folded rail is drawn nowhere and shares nothing.
With a 300px rail that is a page narrower than 1,192px (twice the rail, the 560px input and the air): a window under 1,192px wide at 100%, about 1,311px at 110%, 1,490px at 125% and 1,788px at 150%.
A marked rail ends `--space-4` above the input's top, less the last turn's whole 108px lane (`LAST_TURN_LANE`): its bottom padding is `--prompt-floor` plus `--prompt-height`, the lane and the air (`design/styles.css`).
The lane is kept whether a turn shows or not, so a message coming or fading never moves the panel.
The padding eases with the rail's own transition, a cut under reduced motion, so a resize that brings the mark moves the panel smoothly; the composer's growth, published alone as `--prompt-growth`, is the rail's bottom margin, which no transition eases, so the panel moves with each new line at once.
The input keeps its width and place, and nothing folds that did not fold before.
Where the input already clears a rail, nothing changes.
A card changes nothing either: no card is narrower than the input's 560px, so a card folds the rails wherever the input would share their columns ("Whole-window size"), and its room and place are what they were.
The mark reads only columns, which the rail ending higher leaves alone, and a marked rail's collapsed headers lift nothing, so the mark cannot undo itself.
A window only narrowed moves the input across the rails without resizing either, so the hook also listens for the window's resize.

A panel the rail makes shorter keeps its page at full height and scrolls its body from the top, as any panel with less room than its page asks does: Tasks keeps its first group, waiting on you, in sight.
A panel whose manifest says `newestLast` (Activity) reads newest last, so the window keeps its end in sight (`SidePanelChrome`): the panel's body lays out from its end (`column-reverse`) and its page keeps its height.
When the window gives the panel less room than its page asks, the body shows the page's end and scrolls up to the rest, so the newest line stays in view with no scroll request from the page.
A reader who scrolled the list away keeps their place.
`window-size.spec.ts` ("keeps a lone expanded side panel clear of the main message") checks at every Size, in the smallest, a 1080 × 720, a 1200 × 800 and a 1440 × 900 window, with Activity and then Tasks expanded alone and no card up, that a drawn panel shares no area with the input, the last turn above it or the notices under it, and that Activity's newest line lies whole inside its panel's body.
