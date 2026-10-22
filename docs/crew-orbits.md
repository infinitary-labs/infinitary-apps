# Crew orbital formation

The home character uses the captain's FI3-340 selection for every live work crew roster (working **or** idle).
The inner orbit fills first; the other planes activate only when its capacity is reached.
There is no permanent orbit guide.
Model-name labels are described below; their visibility does not change the formation or motion.
The pointer does: near it the whole stage slows, and on a crewmate it pauses and that crewmate's summary opens ("Slowing near the pointer and the crewmate summary" below).

## Approved configuration

The exact retained captain answer is preserved in `tests/fixtures/crew-orbits/captain-selected-settings.json`, retrieved from FI3-340's captain-selected settings file (not the browser's test capture).
This supersedes the September 22 relative-speed tuning.

| Plane | Radius | Capacity | Tilt | Signed travel | Orientation | Starting phase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Inner | 164 px | 8 | 42° | +8°/s | −24.064227395494573° | 0° |
| Middle | 210 px | 12 | 65° | −20°/s | +21.772396214971284° | 30.36676314193363° |
| Outer | 256 px | 20 | 16° | −4°/s | −40.10704565915762° | 60.73352628386726° |

Positive speed follows the original ring's decreasing angular direction, matching the playground.
Travel is absolute degrees per second, not a multiplier of a Keplerian period; reverse changes orbital travel, not the crewmate's own spin.
Orientations are exactly −0.42, +0.38 and −0.70 radians, starting phases 0, 0.53 and 1.06 radians.
Paths are off and no orbit is highlighted.
Preview playback is not a production accessibility override: reduced motion still paints one settled frame.

The paths are 3D circles with a shared center and distinct radii.
The camera is orthographic; position and depth derive from the same projection.
Differently inclined paths can cross **on screen** without intersecting in 3D.
The chosen unequal speeds are stylized choreography, not circular orbits under one shared gravity field.
The original no-overlap observations in the historical prototype do not apply to this more strongly inclined approved configuration.

## Lifecycle

`crewSignal.ts` constructs the one shared `CrewOrbit` in `adaptive` mode, and the existing home view paints it.
`orbitalPlanes.ts` is the single home of the approved constants and projection.
The explicit `ring` mode remains available for the historical comparison and regression tests; `DEFAULT_ORBIT` is unchanged.

Production uses the selected inner plane even for a small roster; the historical single-ring geometry survives only in explicit `ring` mode.
Geometry, radius and angular slots follow the existing springs.
A settled boot roster is placed on its planes immediately, without re-emitting already active crewmates.
Reduced motion snaps the formation and lifecycle clips to their settled state.

The inner plane fills to eight crew, then middle to twelve, then outer to twenty.
Middle activates at nine total crew; outer at twenty-one.
Beyond forty, overflow continues on the existing least-populated plane (ties favor inner): 41 crew are 9/12/20, 48 are 14/14/20, and 60 are 20/20/20.
These are placement capacities, never limits on tasks or changes to routing.
Every plane keeps its crew evenly spaced: on boot, and again whenever a crewmate joins or leaves it, the plane's members keep their order around the circle and glide (on their existing angle springs) to even slots, rotated as little as possible.
Arrivals enter at the widest vacant angular gap in the first plane below capacity, then the plane re-spaces.
When a member leaves, the oldest member of the next occupied plane glides into the plane, cascading from outer to middle only if needed.
No member changes plane except by that fill; fast threshold bounces do not reverse the move.
The member's plane projection follows a spring, like its existing angle and radius; reduced motion settles it immediately.
Reports, steers, launch trails and first mate cues use the same projected path as the member; home/away departures, failure nudges and working/idle colors are retained.
Crowded glyphs use the approved roughly 25-pixel base; idle crew retain the slow spin and cool light rather than moving beyond the outer canvas boundary.
The far/near canvases also draw members in depth order within each layer.
At the minimum window height the crowded formation scales uniformly to fit above the activity line and input, preserving the angles and relative radii; explicit historical ring mode stays at its original scale.
The fit remains responsive with reduced motion enabled.
A move to a display of another density changes only the pixel ratio, so under reduced motion the ring paints its last settled frame again from its own inputs at the new sharpness, and the crew stay where they stood (`onPixelRatioChange` in `src/renderer/src/character/pixelRatio.ts`, shared with the first mate).
The size control's zoom also changes the window's height in CSS pixels, which restarts the loop and paints the still afresh.

## The spark out to a crewmate

The spark out to a crewmate flies when something sent reaches it, never when a message is only recorded (INF-759).
The core announces it as a `task_event` push with `reached: true` (`announceReach` in `crewSupervisor.ts`), and `applyCrewEvent` draws the spark from it.
A message sparks when its lane row first goes out into a turn (`deliverRows`), so a message held for an account or a computer, or queued behind a turn, sparks when the crewmate takes it, and one delivered again sparks only once.
An interrupt or cancel sparks as it is asked, the first mate's or the captain's Stop alike; a settle sparks before the task closes, except a superseded one, whose successor's start is its spark.
An edit the crewmate never hears also sparks, because its task changed: an `update_task` field edit other than its policies, a withdrawn merge, and a wait added or removed by `link_tasks`; a policy change sparks as its notice lands.
The crewmate's own lane rows, a job's result and a renewed conversation's reason, were sent by nobody and draw nothing.
A crewmate whose task closes while its spark is still flying leaves on the frame after the spark lands (`leaveAfter` in `orbit.ts`); a settled frame lands it at once.

## Multiple work computers

With more than one configured work computer, the home stage keeps the home formation as it is and seats every other computer's crew beside it (the captain's FI3-1519 plan, 2026-10-10, built on the captain's FI3-1406 Home constellation).
The home cluster contains the one first mate; each other computer's crew use an invisible local center.
Spacing, local motion and quiet machine names establish the clusters, without plates, outlines, center markers or crew counts.
A cluster shows its machine name only while it has crew and a computer other than home on the page has crew; an empty cluster never shows one (`ComputerOrbits.labeled`).
The home orbit keeps its original owner, radius, glyph size, motion, expressions, model names and height-fit transform in every scene, including multiple computers.
The first mate stays at its original 300 px size.

**Every cluster is the home formation at half its size** (`CLUSTER_LAYOUT.sizeShare`): the same three planes, tilts, capacities, directions and degrees per second, only scaled, so one 82 px orbit holds up to eight crew, a second at 105 px opens from nine and a third at 128 px from twenty-one, and a cluster grows in steps as home does.
Remote glyphs keep their 23 px (18 px past twelve crew) with home's depth cue, nearer larger.
Model names follow the home rule cluster by cluster, under the same Appearance switch: shown while that cluster has one occupied orbit, hidden once a second opens (`crewModelLabelsVisible` over that cluster's frames); a hidden name stays readable to the keyboard.

**Seats.**
The clusters with crew on the page sit in two wings (`ComputerOrbits.targets`): the first computer in pairing order right of the home formation, the second left, the third right again, stacked top to bottom within a wing and centered on the first mate's height.
A wing stands beyond the home formation's edge - its outer occupied orbit plus half a glyph - by a 40 px gap plus its widest cluster's radius, and stacked clusters keep that gap plus room for a name between them.
A computer with no crew keeps no seat, so the others close up; its first crewmate seats it.
A seat glides on a spring when the formations around it grow or shrink (home's ninth crewmate moves both wings 46 px out), a new seat appears in place, and reduced motion settles seats at once.
The machine name sits 20 px under the cluster's edge and follows its seat.

**The crew layer is the window.**
With several computers the two crew canvases grow to the window's width and to its height less the room the activity line and the input keep (`sceneBox` in `CrewOrbit.tsx`), centered on the first mate and never smaller than the scene reaches; they already lie under the rails, their panels, the cards and the message box, and nothing in the app moves or resizes for them.
A cluster may sit under an open panel; a crewmate under a panel or a card takes no pointer and no hover, since the pointer counts only on the stage itself.
The whole scene, the first mate included, shrinks only when the window is shorter than the home formation (the existing fit) or narrower or shorter than the wings, never below 30 percent (`sceneFit`, written to the stylesheet as `sceneFitCss` so a still frame keeps fitting as the window changes); the model publishes how far the scene reaches as `OrbitFrame.scene`.
At 1280 by 800 two computers of eight shrink nothing; five computers of twenty-four each fit at about 60 percent.

**One path for a remote clip.**
A remote spark flies one curved screen-space path from the first mate's core to its slot (`arcBetween` in `orbit.ts`), re-aimed at the live slot each frame, eased out once and unfolding over its last two thirds like a home spawn; a finished remote crewmate falls home along the same kind of path, accelerating, and its packets ride the live line as at home.
Each takes longer the farther it flies (`REMOTE_TRIP`, `remoteTripMs`): the home clip's time over the distance a home spark covers, 147 px, and 280 ms more at 320 px, so a spark takes about a second across the stage; the fall home and a packet add the same extra over their own base.
The home spawn's numbers do not change.
A remote send-off or steer cue carries a unit direction, so the first mate glances toward the cluster.

**The black hole stays at home.**
Remote clusters receive a rush level of zero: their crew keep their pace and show no streak while the home crew race, since a cluster orbits its own center, out of the first mate's pull ("The black hole's rush" below).

**Placement arrives with the row.**
The core creates a placed task's row with its computer in the same write (`CreateTaskInput.deviceId`), so the row's first `task_changed` already carries `executionDeviceId` and the crewmate spawns on its own cluster.
A placement that still arrives after the spawn - an older home, or a moved task - takes the crewmate off the orbit it was on at once (`CrewOrbit.discard`: no departure, and no settled snap of the others, who re-space on their springs) and spawns it on the right one, still as a spark if it was one.

The existing painter, solids, working/idle colors, review cues, request flickers, summaries and task-record interactions remain the owners.
Spawns, reports, steers and home departures connect to the one first mate, not to a remote invisible character.

`ComputerOrbits` (`character/crew/computers.ts`) retains the original home orbit and adds remote adaptive orbits behind the existing `CrewOrbit` painter.
The original adaptive orbit remains the unchanged single-computer rendering path, including character size, placement, motion, expressions, model names, empty state, its 560 px square and its fit.
A control-only device contributes no cluster; a device explicitly known to be another user on this Mac shares the home cluster.
The task board and `task_changed` carry `executionDeviceId`, the task's actual execution placement, with null meaning home.
Names and the project's current Runs on never determine identity.
A paired view of an older home that has not published placement keeps the existing stage rather than inventing groups; clustering begins once the home supplies those facts.
An unreachable peer remains configured, so it never collapses a multi-computer scene into the single-computer path.
Its last painted crew positions and spin freeze, with cool dim solids and an Out of reach line under its name; current activity, packets and animated review cues are not guessed.
A removed computer that still owns active work keeps an unavailable cluster until those tasks leave.

Each page shows home and at most five other computers, without limiting tasks or computers.
Previous computers and Next computers are Tab-reachable controls; Previous work computers and Next work computers are commands in command search, with no default shortcut.
Every crew glyph on the page remains keyboard-inspectable even when model names are hidden or unassigned.
Enter opens its existing task record; Esc releases the summary.
All clusters and their controls hide with the character frame under cards.
`computers.test.ts` holds single-computer frame equivalence, local capacities, identity, same-Mac grouping, frozen uncertainty, paging, reviews, directed lifecycle effects, and the stage's rules: the wings' seats and the scene's reach, a seat's glide, the rush boundary, the remote spark's path and trip, the fall home's and a packet's trip, the unit cue, and a late placement.
`tests/e2e/computer-clusters.spec.ts` drives actual saved placement through boot, keyboard inspection and record opening, minimum-width fitting and overflow paging, with every remote crewmate clear of the home crew and, at the minimum width, inside the window.
`src/renderer/src/character/crew/computers.test.ts` holds the single-computer boundary: one computer draws the stage it drew before, with no names or paging.

## Active adversarial review cue

A host-commissioned review task identifies the builder through its fixed parent edge and its `shape.kind = review`.
The task board and `task_changed` stream carry that typed `reviewOf` id; an ordinary child cannot trigger the cue.
While the review task remains active (including an idle reviewer awaiting a re-review), the reviewer crewmate itself circles the builder it reviews, on the same circle a waiting crewmate uses ("Waiting on another crewmate" below): 64 scene pixels, 24 degrees per second, spanned by the builder's radial spoke and its main plane's normal.
Besides the reviewer's own arrow (below), nothing else is drawn around the builder; the review has no electrons.
The reviewer keeps its own solid, label and working/idle color, and its original slot stays reserved.
The circle ends as soon as the review closes or the builder departs.
Closing the review closes the reviewer's task, so the reviewer takes its existing departure.
Its offset eases out on the springs over the fall, so it leaves from the seat it was drawn at and glides to its normal path; reduced motion settles at once.
Restart seeds the same relationship from the live board, and two reviews of one builder do not cancel each other when one ends: the other keeps circling.
`CrewOrbit.withReviewCues` turns each live review into a satellite cue beside the recorded waits.
The host holds the builder's merge on its review as a recorded wait; the orbit layer drops that one edge, so the builder never orbits its own reviewer or points an arrow at it (the Tasks list and its gutter still show the wait).
A real dependency keeps its place, and reviewers and waiting crewmates of one builder share up to three seats.
More than three, a builder that is itself a satellite, a reviewer not yet on its orbit, or a circle that would leave the scene keeps the reviewer on its slot.
Circling or on its slot, the reviewer draws an arrow to the builder at all times, the way a waiting crewmate does ("Waiting on another crewmate" below), in the working ember (`--wire-hot`) rather than the gray (captain, INF-556: "for a reviewer relationship, it should use the orange color that we use as active").
Like a waiting crewmate, it keeps circling when other crew pass close to it.
A reviewer and builder on different computers stay where they are, because each computer's orbit holds only its own crew; the reviewer's arrow still crosses the stage to the builder (captain, INF-556: "the same reach as waits"), drawn by `ComputerOrbits` beside each computer's own arrows.
The reviewer's summary names the relation in every placement: a Reviewing row with the builder's key, opening its record, beside any Blocked by row.
Packets and a steer's send-off aim at where the reviewer is drawn, circle included.
The circle is always 64 scene pixels, even when it crosses the first mate; the captain chose that overlap, so no clearance rule keeps it off the first mate (INF-51).
Reduced motion paints one settled frame.

`crewSignal.test.ts` checks the live review start/close, the board's own hold, departure on close, packets and send-off, unrelated children, a reviewer of an absent builder, the three seats and the slot fallback with every reviewer's arrow, settled frames and boot; `computers.test.ts` checks a reviewer on a remote computer, another computer's reviewer and its arrow across, waits across computers that move nobody, the builder's hold on a remote reviewer drawing nothing, two reviews, mixed companions with their arrows, and a waiting crewmate and a reviewer that keep their circles and their arrows through a minute of other crew passing close.

## A task with parts

A task split into parts draws as a branching constellation, the captain's INF-799 choice ("the branches are the program's own graph"), with the settings the captain staged on that plan: branches of 60 px, 70 degrees of spread, and a finished tree that folds into its root.
The program's shape and the demo's parts and pace were the preview's only.
`constellation.ts` reads it from the board alone (`programsOf`): a parent with work children and no crewmate of its own, and the recorded `blocks` links among those children, closed ones included.
A part hangs from the siblings it waits on, and a part that waits on none hangs from the root, so parallel parts are siblings, a pipeline is a chain and a part after a barrier joins several branches.
A link to a task outside the parent is not a branch, a host-commissioned review is the builder's cue and never a part, and nothing is inferred from a title, an order or a script.
A parent with a crewmate of its own keeps today's look: its crewmate is the work, and its children orbit as before.
A basis or a branch-from that is not also a recorded wait draws no branch, since the board does not carry them; a program's runner files each part's inputs as its waits.

The root is a small hollow ring on the inner orbit at the widest gap when the program first draws, travelling with that orbit.
`layoutProgram` lays the parts in layers outward from it: the first layer 60 px out and each later one 0.82 of the one before, each layer spread evenly across 70 degrees round the root's outward direction and ordered by its parents' mean angle, so a chain stays straight and a barrier's join sits between its branches.
When a node would leave the stage the whole graph scales about its root, and a layer wider than nine shrinks its glyphs as the preview did.
A live part's crewmate keeps its spark, solid, heat, label, summary and departure; once it has arrived it glides to its node on the springs a waiting crewmate's circle uses, with its slot reserved, and any wait arrow between two parts gives way to their branch.
A finished part is a small filled node, an unstarted one a hollow node, a live part on another computer a filled accent node; a dropped part leaves no node.
A branch has the wait arrow's weight, `--fg-3` at 0.28 and 1 px, and lights in the accent at 0.7 and 1.4 px while a result rides it.

A part's report is its result: its packet climbs its branches by first parents to the root instead of flying to the first mate, and the root lights as it lands.
A part filed while the parts it waits on are finished takes a packet down each branch it hangs from.
The parent's own report, when it has no crewmate here, is a packet from the root into the first mate.
When the parent closes done the tree folds into its root over the fall home's time, and the root then falls into the first mate as the one result home; a dropped parent fades where it stands.
A program first draws once one of its parts is underway, and keeps the planes while its next parts are filed.
Reduced motion paints one settled frame, and the pointer's slowdown and pause apply as to every crewmate.
The near crew canvas publishes each program's branches as `data-constellation` and the parts seated at their nodes as `data-constellation-crew`, compare-before-write.
`constellation.test.ts` checks the graph read from a board, the layout, the seats, the packets up and down, the fold home and the settled frame; `tests/e2e/program-constellation.spec.ts` seeds a review program and reads its branches off the painted stage before and after a part is dropped.

## Tier solids

Each crewmate's solid is the intelligence slot it is served on (captain's board verdict, 2026-09-23; rules in the design skill's `components/mate/Crewmate.prompt.md`):

| Slot | Solid | Corners | Wires |
| --- | --- | ---: | ---: |
| low | tetrahedron | 4 | 6 |
| medium | octahedron | 6 | 12 |
| high | icosahedron | 12 | 30 |
| premium | geodesic sphere (the icosahedron, each face split in four) | 42 | 120 |

Every solid is inscribed in the same sphere, so the glyph size, the ring, the planes and every motion are unchanged; denser solids draw finer.
The slot is `TaskView.tier` - the newest routing decision's `served` slot (the asked slot on a row routed before `served` was recorded) - and rides `task_changed` so a re-route moves the solid live.
A crewmate whose slot is unknown (it never routed) is the tetrahedron, pixel-identical to the pre-tier crewmate.
The flicker, the filament tick and reduced motion apply to every solid's own wires; `crewmate.ts` owns the geometry (`TIER_SOLIDS`).

## Waiting on another crewmate

An idle dependency wait with one visible blocker on the same computer orbits that blocker.
The circle is 64 scene pixels from the blocker, before the stage's existing fit, and travels at 24 degrees per second on the stage clock.
It is spanned by the blocker's radial spoke and the main plane's normal, so the planes stay at 90 degrees and the spoke turns with the blocker.
At most three companions share that circle.
A chain, more than one blocker, a larger group, or a companion that would leave the scene keeps its slot instead.
Circling or on its slot, a waiting crewmate draws a quiet arrow to its blocker at all times, arrowhead at the blocker (captain, INF-304: the arrows "should be present at all times to make it more clear there's a relationship").
The arrow keeps clear of both glyphs; as the two close in on screen, such as when the circle passes in front of the blocker, that clearance gives way so a short arrow still shows (`drawDependencyLink`).
Crew pass close to one another and cross freely: nothing moves a circling crewmate back to its slot because another crewmate comes near (captain, INF-304: "we should just not care about collision").
Each kind of relationship has its own color (captain, INF-556): a wait's arrow is 1 px at 0.28 of the quiet gray (`--fg-3`) and a review's is the same strength in the working ember (`--wire-hot`); pointing at or focusing either crewmate lights the arrow at 0.7 and 1.4 px, a wait in the accent and a review still in the ember.
A blocker on another computer keeps its slot there and the waiter keeps its own: the wait is a solid gray arrow across the stage to it, like every other wait (captain's INF-556 choice, "Solid gray, like every other wait"; `crewedWaits` feeds `ComputerOrbits`).
A builder's merge hold on its own reviewer on another computer draws no arrow back, as on one computer.
A missing blocker, or one with no crewmate yet (a queued task), is named in the summary and draws no arrow.
No crewmate is invented, and no one is moved onto another computer.
Continuing, paused and unknown work keep their slots.
The original slot, solid, label and computer stay reserved.
Clearing the wait removes the cue, and the offset returns on the existing springs.
Reduced motion paints one settled frame.
Inspecting a Tasks row does not pause the stage.
`dependencyVisual.ts` is the one projection both surfaces read.
`crewmate.test.ts` checks each kind's color at rest and lit, and `tests/e2e/computer-clusters.spec.ts` reads a wait's gray and a review's ember off the painted stage between two computers.
`satellites.ts` owns the circle.
The Tasks gutter is specified in the design skill's NowPanel.

## Verification

- `orbitalPlanes.test.ts`: retained exact geometry and absolute signed rates, measured travel of rendered frames, selected inner geometry for small rosters, depth/radius/bounds, inner-first activation at 8/9 and 20/21, overflow through 96, inward glides, churn, stable survivors, packets/cues and reduced motion.
- `tests/e2e/crew-planes.spec.ts`: real storage → boot board → 48 crew at the minimum window: all on the stage, clear of the prompt, and a crewmate's summary still opens whole in the window.
- The `orbit`, `crewSignal`, painter/cue and `crew-orbit.spec.ts` tests exercise the unchanged lifecycle, commissioning, solids, posture and review cues.
  Each named `crew-orbit.spec.ts` case launches a fresh app; cancellation commissions its own visible idle crewmate before removing it, and reduced motion starts with an empty crew.
  Its display case moves a reduced-motion ring to a display of twice the density and back with a device-metrics override: each layer keeps one backing pixel per device pixel, and the second visit shows the very picture of the first.
  Run any case alone with `pnpm exec playwright test tests/e2e/crew-orbit.spec.ts --project=renderer --no-deps --grep '<case title>'`, then run the full file without `--grep` to verify prerequisite ownership.
  The tests attach fresh board/count/pixel state and lifecycle pictures; the isolation validation and sample captures were local evidence and are not committed.

`crew-planes.spec.ts` writes its 48-crew minimum-window picture into the run's own results folder.
No playground controls or generated card bundle are imported into production.

## Continuing-work posture

Tasks dots, home-view crew heat/spin, and the working/idle counts read one host-derived `workPosture` from the task board and `task_changed` events.
It is presentation only: `activity`, turn control, the idle clock and the supervision witness order are unchanged.
One reader beside the board: the quiet check refresh skips a task whose posture reads idle behind another task (`docs/forge.md`, "The check watch").
The card-thread Working badge still reads turn activity.

Active means a running turn, a live host/client job, watched checks, deliverable guidance (including retry backoff or a captured captain reply), captured settlement, or a finite automatic wait.
A decision card does not cool a worker while evidenced work continues.
Host jobs remain active past their two-hour inspection bound; that bound remains a supervision rule, not proof of exit.
An account cut-off or quota gate pauses queued delivery.
A question with no continuing work and a dependency with no continuation are idle.
Paused/unknown postures stay cool; the Tasks dot's tooltip carries the reason.

Waiting on its checks (posture active, reason `checks`: a watched pull request's checks or a hand-started run) is working with a look of its own (captain's INF-676 direction A).
On the stage the crewmate stays counted among the working but banks: its ember at idle strength (0.6) and idle pace, no filament tick, no halo, sitting at the idle radius, inside a thin cyan ring at 0.8 of the glyph whose brighter arc travels round at 1.6 radians a second, the fact strip's running-checks mark carried onto the stage.
It eases in and out on the working blend's own ease and heats back to full ember the moment a turn runs; reduced motion draws the ring whole and still.
The shared mark draws it as an ember dot inside an accent ring, still reading `Working · Waiting for checks`, and the Tasks row adds the dim word `checks`.
`crewSignal.test.ts` and `crewmate.test.ts` check the stage look, and `tests/e2e/task-wait-reason.spec.ts` reads the ring off the painted stage and the mark off the row and the record.
Interrupted turns retain the danger dot unless continuing work is known.

The host refreshes sequenced presentation changes after job membership, inbox, card/thread, account cut-off and task events, with reconciliation on the existing ticker.
Only active work has a live posture, so its facts are gathered for active rows alone, and the refresh walks only live rows: a closed row's posture changes only with the write that closed it (`deriveWorkPosture`, `TaskProtocol.refreshPresentation`).
Boot derives the same answer; persisted job rows are history, not live jobs.
Claude's complete background list replaces membership on each signal.
Attachment/transport loss invalidates the previous membership.
Until the installed client supplies a valid list, absence of background work is unknown (the current SDK emits no startup list).
This does not change recovery or assume every installed client supports that signal.

## Model-name labels

Captain-approved after the playable prototype: the current model name follows each crewmate’s painted frame, 4 px above its glyph sphere, in secondary 11 px text with a 128 px maximum width.
It follows the sequenced task board (including reroutes) and the available catalog, including by-name offerings.
An unknown model falls back to its ID; before assignment the label stays empty (captain: “when it's not assigned yet, just leave it empty”).
Known OpenRouter maker prefixes are removed for display by the namespace-keyed exact map in `src/shared/modelDisplayName.ts`.
Unknown/custom labels remain unchanged; catalog labels, provider/model identity and routing are untouched.

The captain's crowding revision shows labels only while exactly one orbit is active.
The second occupied orbit hides all labels; returning to one restores labels only if the Settings switch remains on.
This reads the painted frames' occupied planes, never a copied roster threshold, and excludes departing crew from active occupancy.
Empty rosters show no names.

A name fades in by opacity alone over `--dur-med` with `--ease-out` each time it shows: a model assigned while its crewmate orbits, a reroute's new name, the return from two orbits to one, the switch turned on, and every time the stage is drawn again (at launch and back from Settings).
Under reduced motion it keeps an even `--dur-fade`, like the state word; hiding is immediate (captain, FI3-843: "a quick fade in - consistent with our other transitions").
Labels narrow at the canvas edge and ellipsize, never shrink the type.
The formation’s fit is countered for the text so it remains 11 px even at the minimum window height.
A name is part of its crewmate: pointing at it, or focusing it from the keyboard, opens that crewmate's summary - which carries the complete display name - and pauses the stage like pointing at the crewmate itself; a click or Enter opens its task record, and Esc lets it go.
The separate full-name plate under the formation is gone (captain, FI3-398: "fold it in").
The selected multi-plane formation and choreography remain unchanged; its extra orbits simply carry no labels.
Labels hide with the character’s mounted, inert frame behind cards and do not take focus there.
The last turn above the input is separate (`docs/composer.md` "The last turn").

Settings → Appearance → Crew model names is on by default, also on older installs, and writes the existing core-owned appearance record through ShellPreferencesService.
Automatic orbit visibility never changes that stored choice.
The switch takes effect at once and survives a restart with a fresh window profile; theme and wash writes preserve the choice.

A crewmate's state word ("Working" while ember, "Idle" once cyan) is a second line on the same anchors, 4 px under the solid, drawn for someone new until each word has been seen in full (docs/first-launch.md "The crewmate's state words").
It reads these frames - only phase `orbiting` with the working blend settled - and follows every orbit, whether or not model names show.
It hides with the character's frame behind cards, hides while its crewmate's summary is open, and never changes a color, a motion or a summary.

`tests/e2e/crew-model-labels.spec.ts` verifies real catalog names, complete-name access through the summary (pointer and keyboard), default/on/off/restart behavior, unscaled text and bounds in both themes and narrow/roomy windows.
It also exercises live 8 → 9 → 8 transitions, removes hidden names from accessibility and inspection, and preserves manual off through both transitions.
The existing crew journey specs retain the motion, formation, lifecycle and tier checks.
Product captures are written by `crew-model-labels.spec.ts` into the run's own results folder.
No private prototype code is imported.

## Slowing near the pointer and the crewmate summary

Captain's ask (FI3-398, plan accepted 2026-10-01): "when user mouse move close to the main view's character + crew animations, the whole animation should slow down drastically, and allow user to mouse hover on each crewmate to see a small HUD-style summary for what the task is and what it's doing"; then "when mouse actually hover on a crewmate, let's pause the animation completely. also, avoid text wrapping in the small popover if possible. we can ellipsis".
It replaces the earlier rule that inspecting never pauses or changes the animation.

**One stage clock.**
`character/stageClock.ts` is the one time source for the character and the crew: stage time advances by real time times an eased rate, both animation loops read it (asking twice for one frame answers the same), and every stamp the stage animates is taken from it (`stageNow()`: the boot roster, crew events, the orbit's creation, the character's sim and a tap).
So the character's turning, crew travel and spin, spawns, departures, packets, nudges, flickers and emotes slow and stop together.
At rate 1 stage time is real time minus a constant
- bit-identical to the raw frame time until something first slows it - and at rate 0 it does not move.
  Theme re-reads and the pointer's rest stay on real time.

| Where the pointer is | Rate |
| --- | ---: |
| Away from the formation, absent, or nobody out | 1 |
| Inside the zone: over an occupied orbit, or within 28 px of its painted ellipse or of a crewmate | 0.1 |
| On a crewmate, or its name has the keyboard | 0 |

The zone follows the orbits the crew travel, not a circle around the stage (captain's ask INF-56, 2026-10-15: "right now it seems my mouse is nowhere near the animation but it would already trigger the slow motion").
Each frame the orbit model hands over its occupied orbits (`OrbitFrame.orbits`): one ellipse for each plane a crewmate that is not leaving is on or headed for, traced through the same ring-to-planes blend and projection as the crew, so another computer's cluster has its own orbits at its seat.
The zone is each of those ellipses with both semi-axes widened by 28 px, and 28 px round every crewmate there to point at, such as a reviewer circling off its orbit, in screen pixels after the formation's fit (`inCrewZone`, `crew/hover.ts`).
28 px is past the reach of the largest glyph, so the stage slows just before the pointer lands on a crewmate; the air above and below a flattened orbit, beyond the outermost one, and above and below another computer's cluster runs at full speed.
Every drop eases with a 0.11 s time constant (settled in about a third of a second) and every rise with 0.23 s (about 0.7 s), integrated exactly so the result does not depend on frame timing.
A pointer that rests inside the zone for 3 s, on no crewmate, lets the stage go; its next move slows it again.
A pointer resting on a crewmate holds the pause indefinitely.
The rate is 1 whenever the pointer leaves the window, the window loses focus or is hidden, the character's frame is hidden under a card or record, the view is not home, or the pointer is over something that is not the stage (a rail, the input, the top bar).
Reduced motion has no rate: its one settled frame is already still.
During a pause every structure stops, crew and character alike, but the first mate's eyes keep blinking and following the pointer on real time (captain: "the eyes still blink and follow").
The painted scene is stale by design while paused: a crewmate that arrives, reports or leaves meanwhile plays when the stage resumes.
While slowed, clips stretch (a spawn spark takes about 7 s at a tenth), and the order of events is preserved because they are stamped in stage time.
Typing or talking does not by itself cancel the slowdown or the pause.

**Pointing.**
The crew canvases ignore the pointer, so pointing is a hit test (`crew/hover.ts`, pure) against the frames the orbit already returns, run on pointer movement only: a crewmate drifting under a still pointer triggers neither the pause nor the summary.
The pointer is on a crewmate within half its glyph plus 8 px of its painted centre (never less than 18 px); the nearest wins, the one nearer the camera when equally near; it stays on that crewmate out to 1.6 times that radius, and a neighbour takes over only once the pointer has left the held one's own radius.
A departing crewmate, or a spark not yet unfolded, is not a target.
The near crew canvas publishes the crewmates that have arrived and orbit each plane, by task id, as `data-plane-crew`, and how far the planes have opened out as `data-plane-blend`, which reads `1` once they have settled in (both compare-before-write).
A part of a task with parts takes its seat at its node only once the planes have settled, and is listed on its plane until then.
So a journey's `pointAtCrewmate` waits for settled planes and the crewmate it wants, then points at a seated part's name or sweeps the orbit for any other crewmate.
The pause begins the moment a crewmate is acquired.
It ends when the pointer leaves it, on Esc (which keeps it closed until the pointer has left that crewmate), under a card, or when the crewmate itself is gone.
It works at every crew size and on all three orbits, independent of the model-name switch.
A click on the crewmate being read calls the shell's `openRecord(taskId)` - the record its Tasks row opens - and is not a tap on the character behind it.

**The summary.**
One DOM panel (`crew/CrewSummary.tsx`, `crew/summary.css`), 130 ms after the pointer lands, in the captain's instrument look: corner brackets round the crewmate, a hairline to the panel, squarer corners, and an uppercase micro label in a side column beside each line (the captain's pick from the FI3-427 mocks, 2026-10-01).
The model, its intelligence level and its reasoning, then its pull request and checks, sit in a fact strip under a hairline, each value under its own label, with the footnote across the bottom (the model's cells are the captain's pick D from the FI3-439 mocks, 2026-10-01; the strip, the merge card's own shape, is FI3-1159's layout B), so a bare "High" never stands for either the level or the reasoning.
Its lines are the shared task facts (FI3-565 piece 2, the design skill's NowPanel "Shared task facts"): one projection, `taskFactsOf` (`src/shared/taskFacts.ts`), drawn by one component (`design/core/TaskFacts.tsx`), which the task record shows too, so one task reads the same values on both.
The record places the fact strip just above its action bar, after its rows.
Once the record's read answers, the whole projection is that read's, the same one the record shows.

| Line | Content | Source |
| --- | --- | --- |
| first | task key, the shared status mark and word with its reason, wrapping when long | `tasks.board`, then `tasks.detail`: `taskStatusOf` |
| TASK | the task's title, wrapping in full | `tasks.board`, then `tasks.detail` |
| PROJECT | the project's display name, wrapping, under Task; absent when the board has no name for it | the Tasks row's own lookup, `projectNameOf`: `tasks.board` `projects` by `projectId`, else empty |
| NOW | the crewmate's own newest doing - its own row, its newest action or its last sentence - and that doing's short age (`docs/task-record.md`, "The Now line") | `tasks.detail` `activityLog` and `said`, read only while that crewmate is pointed at, live while open |
| MODEL (strip) | the full model display name; absent before assignment | the one model-name lookup (`modelNames`, `src/shared/modelDisplayName.ts`) the labels, the record and the core's `ModelSlots.nameOf` use |
| INTELLIGENCE (strip) | the level the crewmate is served on, as the `SlotBadge` Settings → Models draws it; absent before routing | `tasks.board` `tier`, the level the crewmate's solid shows |
| REASONING (strip) | the reasoning its session opened at ("Extra high", "Model's own"); absent when the record cannot say | `tasks.detail` `reasoning` through `reasoningWord` (`docs/routing.md` "Reasoning effort") |
| PULL REQUEST, CHECKS, REVIEW (strip) | the pull request (or branch) by its label as plain text, its checks as the merge card's dot and word with how long they have run or took (`running for 15m`, `passed in 14m · 5m ago`), and a review's verdict; absent until the task has a change or a checks reading, except that a task with no change shows the newest run it started by hand and the app watched as its CHECKS (`docs/forge.md`, "The checks cell's time") | `tasks.board` `delivery` |
| footnote | why that model was chosen, then why the reasoning is lower than its level asks, in plain words; absent when the record can say neither | `tasks.detail` `modelReason` and `reasoning` through `modelFootnote` (`docs/routing.md` "Why this model") |

The status, the task title and the project wrap in full.
The other facts stay one line, the panel is as wide as its longest line up to 360 px, and a longer note ends in an ellipsis while the note's age stays whole at the panel's right edge.
360 px leaves every state the app can show whole beside its key (`crew-hover.spec.ts` checks that the shown state reads whole).
The strip's cells wrap whole, so a value the record cannot say leaves no gap, and a long model name ends in an ellipsis inside its cell.
The footnote may wrap, to two lines at most, as may the status, the task title and the project.
A cut-short line is not expanded in place; the record has the full text.
The panel sits beside the crewmate on the side away from the character, level with it; where that has no room, under or over it; and only then on the character's side.
It keeps inside the window between the top bar and the input, never under a rail's panel, and clear of the crewmate's own name.
It lives outside the fitted formation, so its type is never scaled, and it follows the painted crewmate with compare-before-write, so a paused stage touches no DOM.
It is read-only - no buttons - and never takes the pointer.
Under reduced motion the summary works against the still frame.

**From a Tasks row** (FI3-565 piece 3, the design skill's NowPanel "Row hover").
Resting on any Tasks row opens the same `CrewSummary` for that row's task, after the same beat (`CREW_HOVER.dwellMs`); a row the board no longer lists (the filter's `earlier` group) takes its first facts from the record's read instead.
The Tasks panel is a frame, so it reports the row it rests on with the panel API's `point.peekTask` and the row's box (`src/panels/now/panel.tsx`), and `null` when the pointer or the keyboard leaves that row, presses it, or Escs, or the list moves under it.
Leaving any other row lets nothing go: focus leaving the row a click opened keeps the summary of the row the pointer rests on, so an Esc in the window then closes that summary and not the record the click opened.
The host adds the frame's offset and keeps the row in a small view-state store (`plugins/point/taskPeek.ts`); `plugins/point/PeekSummary.tsx` draws the summary in a window-wide layer above the rails and the cards.
A task board tile rests the same way from the board's card, and its summary sits beside the tile itself.
`placeRowSummary` (`crew/hover.ts`) puts it outside the Tasks panel on the stage's side, centred on the row, inside the window under the top bar and clear of the input and the other rail's panels (rising above what is in the way, then the other side), with the hairline from the panel's edge at the row's middle; there are no brackets.
The host also lets it go when the pointer moves anywhere outside the frame, on Esc (which then goes no further, so a record open under the summary stays), a scroll that carries the frame, a resize or the window losing focus.
A move the window receives aimed at the frame element itself is not outside it: Chromium sends one as the pointer crosses into the frame, often just after the frame has reported the row, and the frame never reports that row again.
The pointer leaving the window lets it go too, heard as the window document's `pointerleave`: macOS hands Chromium's exit to the window's own page alone, so a frame under the pointer never hears it and never reports `null`.
It never inspects a crewmate and never slows the stage; the lit task below puts brackets on that task's crewmate, and nothing else.

**The lit task** (INF-237, "hover a task anywhere, highlight it everywhere").
A rest on a task on any surface lights it on every surface that shows it.
`plugins/point/litTask.ts` is a second small window-view store beside `taskPeek`: `{ taskId, by }` or none, one at a time, the last rest winning, and a source lets go only of what it lit.
`taskPeek.set` and `taskPeek.release` feed it, so every Tasks row, board tile, panel key, card-frame key and window key publishes with no change of its own; `CrewOrbit` feeds it the crewmate it inspects (a pointer rest or a focused name, `by: "stage"`) and lets go when it stops inspecting.
It is lit the instant a rest begins and cleared the instant it ends, with no beat; the summary keeps its own 130 ms.
The stage follows it with the corner brackets alone: for a lit crewmate that is not the one it inspects, `CrewOrbit` draws the `.fm-crew-target` brackets round the painted crewmate (`placeLit`, per frame with compare-before-write, and once under reduced motion) and sets `data-crew-lit` on the formation.
There is no summary, no hairline, no pause and no slowing: `data-stage-rate` and the stage clock are untouched, as the 2026-10-01 ruling says a row's rest never moves the stage.
A lit task that is no crewmate here, or whose crewmate is leaving, draws nothing.
Its other followers are the Tasks row (`data-now-lit`), the board tile (`data-board-lit`), a panel's keys (`PanelView.litTaskId`), a card body's or record's keys (`data-inf-lit`, `docs/ui-plugins.md` "Pointing and the view") and the keys the window draws (`data-task-lit`).
Nothing is scrolled or paged into view: a lit row lights where it is.
It is window view state: nothing is saved and nothing crosses IPC.

**From a task key** (FI3-594, FI3-1271; the design skill's core rule "Task keys").
A card body's or a task record's frame reports the key it rests on (`cards/taskLinks.ts`), and a key the window draws - a thread line, a card's title, the record's Now line, a Settings row - reports itself (`cards/TaskKey.tsx`, an `AnchorPeek`); the same store and layer show the same summary for that key's task.
`placeKeySummary` (`crew/hover.ts`) puts it beside the card, or the Settings section, the way a row's sits beside its panel, level with the key and with the hairline from the card's edge on the key's line, or under the key's line (then over it) where neither side has room.
A key in a panel - Activity, Knowledge - points as a Tasks row does (`point.peekTask`), so its summary sits beside the panel.
The same window rules let it go, and also any other key press in the window, the card's frame leaving the window, the frame taking a new document, and a window key leaving the window.
`tests/e2e/card-task-keys.spec.ts` drives it: the key's summary reads the same facts as its Tasks row's, clear of the key and input in roomy and narrow windows, a slide into the key from either side of the card with the synthetic mouse opens it, and a key in a record, a thread line, Activity and Settings › Usage rests and opens the same way.

`stageClock.test.ts` covers the clock (bit-identical at rest, one answer per frame, the two easing constants, an exactly still stage at rate 0, the exact integral, stamps between frames, the rate rules); `crew/hover.test.ts` the zone on the orbit model's own frames (each orbit's shape, every crewmate's reach at every crew size, a reviewer off its orbit, the fit, the glide into the planes, other computers' clusters), the hit test's acquire/stick/release radii and preferences, and the summary's placement beside a crewmate and beside a Tasks row; `crew/useCrewBoard.test.ts` the summary's facts, `src/shared/taskFacts.test.ts` the shared projection and `design/core/TaskFacts.test.tsx` that the summary and the record show the same values, with the record's model readout after its rows.
`tests/e2e/crew-hover.spec.ts` drives the real home view: pointing opens the summary, Esc closes it, a click opens the record, nothing opens under a card, and the summary and record show the same task facts.
Stage-clock rates and easing belong to `stageClock.test.ts`; summary placement journeys use `expectClearOf` from `tests/e2e/layout.ts` rather than asserting a side, gap or hairline alignment.
Its second journey rests on a backlog, an idle and a done Tasks row: each opens its summary clear of the row and input inside the window, the idle row's matches the summary its crewmate opens on the stage, leaving, Esc and a press close it, the press still opens the record, and a row's summary reads over an open record.
Its third journey slides into a Tasks row from the stage on its left and from the panel's edge on its right with Chromium's own synthetic mouse (`launchApp({ gpuBenchmarking: true })`), because Playwright's mouse never sends the window that crossing move; each slide opens the row's summary.
The slow rate itself is `stageClock.test.ts`'s, and the summary's look is judged by eye.

## The black hole's rush

Captain's ask (2026-10-01): "when firstmate character is doing the blackhole fidget animation, it should drastically speed up all the orbital crewmates like crazy".
Built after the playable preview with the captain's tuned settings (Build it: `peakX` 36, `rampS` 1.6, `settleS` 2, spin and streaks on).

| Setting | Value | Where it counts from |
| --- | ---: | --- |
| Top speed of the crew's orbital travel | ×36 | |
| Ramp up | 1.6 s | the black hole's wind-up (0.28 s into its 5.6 s) |
| Settle back | 2.0 s | its unwind (4.48 s in), or the moment it is cut short |
| A crewmate's own spin | a quarter of the boost (×9.75 at the top) | |
| Speed streak | the arc swept in the last 0.06 s, at most 1.5 rad | |

Both ramps are smoothsteps, so the speed never jumps.
The character publishes its black hole to `crew/rush.ts`'s shared `crewRush` every frame it plays (the fidget's start in stage time, so a pinned emote moves the rush with it) and that it stopped; the orbit reads the level each frame (`CrewOrbit.update(now, settled, rush)`).
A black hole that ends on its own changes nothing, since the settle already began with the unwind; one cut short by attention or a turn starts the settle at once, from wherever the ramp had reached.
A rush still settling when the next black hole begins carries on from its level.

Only travel speeds up.
The extra travel is a lead on the orbit's own clock, and every angle spring moves with its target, so the crew race rigidly on their evenly spaced slots instead of trailing them.
Every orbit keeps its direction and relative pace, so the inner (+8°/s) and middle (−20°/s) orbits race in opposite directions.
Spawns, departures, packets, nudges, flickers and tiers keep their own pace, and the lead stays where the rush left it, so nothing jumps when it ends.
An orbiting crewmate trails a streak of its own light, lifted a quarter toward white-hot, along its own projected path, thinning and fading away from it (`drawCrewmate`).
The first mate's own black hole is untouched.
So are the other computers' clusters: their orbits receive a rush level of zero, since each orbits its own center out of the first mate's pull ("Multiple work computers" above).

The rush runs on stage time, so the pointer's slowdown and pause apply to it like everything else.
Reduced motion plays no black hole and no rush: the settled frame ignores the level.
The near crew canvas publishes the travel speed as `data-crew-travel` (1 except during a rush), compare-before-write.

`rush.test.ts` covers the schedule (ramp, hold, settle, a cut, a pinned clock, a new black hole mid-settle) and the streak's arc; `orbitalPlanes.test.ts` covers racing travel per orbit at ×36 on evenly spaced slots, the return to the normal pace, the spin share with an arrival unfolding on its usual schedule, streaks only while racing and behind the crewmate, and reduced motion; `crewmate.test.ts` the streak's paint under an unchanged solid; `computers.test.ts` the remote clusters' unchanged pace and absent streaks at the top of the rush.

