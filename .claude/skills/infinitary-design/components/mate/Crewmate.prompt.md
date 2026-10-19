A crewmate — a 3D wireframe solid, clearly simpler than the 4D first mate (dimensional hierarchy = org hierarchy).
The tetrahedron, the simplest solid, is the base crewmate; a stronger model is a richer solid.
```jsx
<Crewmate status="working" size={24}/>
```
Solid by intelligence slot (captain's board verdict, 2026-09-23): the slot the crewmate is served on picks its solid, every one inscribed in the same sphere and still 3D - **tetrahedron** (low, 4 corners), **octahedron** (medium, 6), **icosahedron** (high, 12), **geodesic sphere** (premium: the icosahedron with each face split in four, 42 corners and 120 wires, a node only on its 12 original corners).
A crewmate whose slot is unknown is the tetrahedron - it claims no more than the app knows.
Denser solids draw finer (lower alpha, thinner lines, smaller nodes) so the ring stays calm.
The slot is never a hue, a label, a mark, a size or a motion: status keeps the only color, and a still frame (reduced motion) carries the solid.
This JSX mock paints only the tetrahedron; the app's `src/renderer/src/character/crew/crewmate.ts` is the reference.
In the home view and Tasks panel, status means host-evidenced continuing work (`docs/crew-orbits.md`), not only a running model turn.
Paused or unobserved work stays cool with an honest reason on the Tasks dot; the card-thread Working badge remains turn-only.
Status is color: `working` heats the wires to ember (`--wire-hot`) and spins faster; `idle` is ice cyan (`--wire-accent`), recessive by alpha and a slow drift, never a second hue.
Never paint an idle crewmate grey or `--wire-dim` — that reads as dormant, and it contradicts the row it sits beside.

In orbit (home view, captain-approved 2026-09-14; the app's `src/renderer/src/character/crew/` is the reference): each live crewmate is one solid on an inclined ring around the first mate (radius 190px, tilt 0.58, glyph 30px, one revolution per 64s), sent out as a spark that swirls 1.1rad out of the inner cell and unfolds on its slot over 720ms.
Color follows the first mate's own heat ramp: a working crewmate blends ice cyan to ember (`--wire-hot`) with a white-hot filament and a halo in its own heat; an idle one stays a dim ice cyan.
Color is never the only cue - working is a fast double spin and pulsing nodes ON the ring, idle a slow tumble and bob 6% farther out.
Reports and steers are packets on the crewmate's line, a finished crewmate folds home into the first mate, a dropped one dims and drifts off, and each of its finished model requests is a token flicker on its own wires - the first mate's filament rule (readme), same curve.
Model names sit immediately above their own solids: normal-case `--text-xs` (11px), `--fg-2`, 4px gap and 128px maximum width, with an ellipsis rather than smaller type.
Pointing at a name, or focusing it from the keyboard, points at its crewmate and opens that crewmate's summary, which carries the full display name (below).
Crowded formation fitting scales positions and glyphs, not label text.
Known OpenRouter maker prefixes are omitted using the model’s namespace and an exact prefix map, never by splitting arbitrary names at a colon.
Unknown/custom names retain their wording.
Settings → Appearance → Crew model names defaults on and persists through restart; it affects only these labels, never the first mate or tier solids.
Show these names only while exactly one orbit is active; hide all names when a second orbit appears, then restore them at one orbit if the switch is still on.
A name fades in by opacity alone over `--dur-med` (`--ease-out`) whenever it shows, a reroute's new name included, and over an even `--dur-fade` under reduced motion; hiding is immediate.
Automatic hiding never writes the stored choice.
The strip and feed still carry activity.
Reduced motion: every crewmate appears settled on its slot, one still frame.

The black hole's rush (captain, 2026-10-01, tuned on the playable preview): while the first mate plays its pretend black hole, every crewmate races its orbit at up to 36 times its travel speed - ramping up over 1.6s from the wind-up, holding, and settling back over 2s from the unwind (or from the moment the black hole is cut short), smoothstep both ways, never a cut.
Each orbit keeps its direction, so the inner and middle orbits race in opposite directions, and the crew stay evenly spaced on their slots.
A crewmate's own spin takes a quarter of the boost, so its solid still reads.
While racing, an orbiting crewmate trails a speed streak along its own path: its own light lifted a quarter toward white-hot, thinning and fading over the arc swept in the last 0.06s (at most 1.5rad).
Arrivals, departures, packets and every other cue keep their pace; the pointer's slowdown and pause apply to the rush; reduced motion plays none of it.

During a live adversarial review the reviewer crewmate circles the builder on the waiting crewmate's circle, 64 px at 24° per second; the builder's own solid is unchanged.
This cue does not resize the crew's orbital planes or change the other shape states.

Naming the colors (captain, FI3-436, 2026-10-01; docs/first-launch.md "The crewmate's state words"): for someone new, a crewmate on the home stage says what its color means once.
"Working" sits 4px under the solid while it is ember and "Idle" once it is cyan: `--text-xs`, `--fg-2`, normal case, never the state's color (the color stays on the solid alone).
Each word is taught once per profile, only on a profile that has never had a crewmate, and counts only when it has been seen in full: 6s at full strength (fade in `--dur-med`, out `--dur-slow`) with the home stage uncovered and the window not hidden.
A showing needs a crewmate settled on its orbit (never spawning or leaving) that has held its state for 1s, hides while that crewmate's summary is open, and the earliest crewmate in the state carries it.
Any interruption (the crewmate closes or leaves, its color changes, a card covers the stage, the summary opens on it, the window is hidden) cancels the showing and teaches nothing, so a crewmate idle for an instant before closing shows no word.
No tour, legend, setting or dismiss control; colors, motion, the summary and the Tasks dots do not change.
Under reduced motion the fade is opacity only.

Reading a crewmate (captain, FI3-398, 2026-10-01; replaces "inspecting never pauses or changes the animation"): the character and its crew read ONE stage clock, so they slow and stop together and stay one coherent picture.
While the pointer is over the formation - on or inside an occupied orbit as painted, or within 28px of one or of a crewmate - the whole stage eases to a tenth of its speed; while the pointer is on a crewmate it pauses completely; away from the formation, with nobody out, under a card, or with the window out of focus it runs at full speed.
The zone follows each orbit's own tilted ellipse, and each other computer's cluster's, so empty air above and below the crew never slows the stage (captain, INF-56: "right now it seems my mouse is nowhere near the animation but it would already trigger the slow motion").
Every change eases (about a third of a second down, 0.7s back up), never a cut.
A pointer resting inside the formation for 3s, on no crewmate, lets the stage go and its next move slows it again; one resting on a crewmate holds the pause for as long as it stays.
During the pause every structure stops - crew and character alike - but the first mate's eyes keep blinking and following the pointer: that is what tells a paused stage from a stopped app.
A crewmate drifting under a still pointer triggers nothing; only pointer movement acquires one (within half its glyph plus 8px, never less than 18px; it lets go at 1.6x that).

The summary is one small instrument panel beside the crewmate, on the side away from the first mate (under or over it where that side has no room; never under a rail's panel, the top bar or the input), a beat (130ms) after the pointer lands: `--bg-2`, a `--line-2` hairline border, `--radius-s` corners, no glow; corner brackets (`--fg-3`) round the crewmate and a `--line-2` hairline joining them to the panel.
It slides `--move-summary` (8px) out from the crewmate and fades in over `--dur-quick` while its hairline draws; resting on another crewmate while it shows, or just after it went, moves it there at once; it fades out over `--dur-summary-out` (100ms) when the pointer leaves the crewmate, on Esc, under a card, or when the crewmate itself is gone (Motion in the readme; a cut under reduced motion).
The layout is the captain's pick (FI3-427, 2026-10-01: side labels, 360px, a reason of two lines at most; the model's cells are FI3-439's, the fact strip FI3-1159's), padded 12px by 14px.
The first row is the task key (mono, `--fg-3`), the shared task status mark and word, followed by its reason (`components/now/NowPanel`, Shared task status), on one baseline.
10px under it comes one row per fact, 6px apart: its uppercase micro label (`--text-xs`, `--tracking-label`, `--fg-3`) in a 66px side column and its line beside it on the same baseline - TASK, the title (`--fg-1`, medium); NOW, the newest row of the record's Activity with its age (mono) at the panel's right edge; PROGRESS, the count and the current item of the plan the crewmate reported, with one dot per item on a line under it and a short label under each dot (`components/now/NowPanel`, Shared task facts; FI3-734), absent until it reports one.
Then 10px lower, under a `--line-1` hairline with 10px above and below it, the fact strip (FI3-1159, the captain's layout B; the model's cells are FI3-439's pick D), the merge card's own shape: one cell per fact, each an uppercase micro label with its one-line value 5px under it, the cells `--space-4` apart and wrapping whole, `--space-2` between rows.
The cells are MODEL, the full display name, ending in an ellipsis when the cell runs out of room; INTELLIGENCE, the level the crewmate is served on as the `SlotBadge` Settings → Models draws (bars and the level's own color); REASONING, the reasoning its session opened at in words ("Extra high", "Model's own"); PULL REQUEST (BRANCH on a plain Git host), the change by its label (`#612`), plain text here because the summary never takes the pointer; CHECKS, the merge card's dot and word (`running`, `passed`, `failed`, `not read yet`) with the reading's short age; and REVIEW, an independent review's dot and verdict with its risk.
A value the record cannot say leaves its cell out; the strip is absent until the task has a model, a change or a checks reading.
6px under it, in `--text-xs` `--fg-3`, the footnote: why that model was chosen, in the plain words `modelReasonLine` gives the routing decision's typed record ("Building from the plan in FI3-419", "You asked for this model"), then, when Quick care or the model's own ceiling put the reasoning below what the level asks, a second sentence saying so ("Reasoning one step lower for Quick care."); absent when the record can say neither.
These are the shared task facts (`components/now/NowPanel`, Shared task facts): the task record shows the same values, and places this strip just above its action bar.
A level is never a bare word in the panel: it is the labeled badge.
The status, the task title and the project wrap in full.
The other facts stay one line: the panel is as wide as its longest line up to 360px - wide enough that every state the app can show reads whole beside its key - and a longer note ends in an ellipsis while the age stays whole.
The footnote may wrap, to two lines at most, as may the status, the task title and the project.
Its type is never scaled with a fitted formation.
It is read-only and has no buttons, so its change is plain text, never a link; a click on the crewmate (or its name) opens the same task record its Tasks row opens, which has the full text.
It works at every crew size and on every orbit, whether or not names show.
Resting on a Tasks row opens the same summary for that row's task, placed beside the row (`components/now/NowPanel`, Row hover).
That rest also puts the summary's corner brackets (`--fg-3`) round the task's crewmate on the stage, at once, with no summary or hairline: the stage neither slows nor pauses (the 2026-10-01 ruling), and the brackets follow the crewmate as it moves.
The same brackets mark it for a rest on a task key or tile of its task; the crewmate the pointer is on draws its own with its summary, and the stage's rest on a crewmate lights that task's row, tile and keys in turn (`components/now/NowPanel`, "The lit row").
Reduced motion: the scene is already still, so only the summary applies.

Keep small (≤32px); crewmates never become a focal point.
Prefer CrewStrip for overviews.

Approved orbital formation (FI3-340, captain, 2026-09-30): use the selected inner plane from the first crew; fill inner to 8, then middle to 12, then outer to 20.
Middle opens at 9 total, outer at 21.
Travel is +8 / −20 / −4 degrees per second, with tilts 42° / 65° / 16°.
Above 40, retain least-populated-plane overflow.
When a member leaves, the oldest member on the next occupied plane glides inward with only necessary moves; a fast capacity-boundary bounce never undoes the move.
Exact radii, orientations, phases and lifecycle rules are in `docs/crew-orbits.md`; `orbitalPlanes.ts` owns the constants.
Draw far-to-near and never add permanent orbit paths or plane-specific colors.
Projected crossings are intentional; these unequal signed speeds are stylized choreography.
At the minimum window height, fit the formation above the activity line and input as one uniformly scaled group.
The original single ring remains an explicit historical model mode only.

Waiting on another crewmate (captain's FI3-1680 choice): an idle dependency wait with one visible same-computer blocker orbits that blocker, not the first mate.
The circle is 64 scene pixels out, before the stage's existing fit, and travels at 24 degrees per second on the stage clock.
Its plane is spanned by the blocker's radial spoke and the main plane's normal, so the two planes stay at 90 degrees and the spoke turns with the blocker.
At most three companions take that circle.
A chain, a second blocker, a larger group, or a companion that would leave the scene stays on its own slot instead.
Circling or on its slot, the waiting crewmate draws a quiet arrow to its blocker at all times, arrowhead at the blocker, and a reviewer draws one to the builder it reviews (captain, INF-304).
Each kind keeps its own color (captain, INF-556): a wait is the quiet gray (`--fg-3` at 0.28, 1 px) and lights in the accent; a review is the working ember (`--wire-hot`) at the same strength, at rest and lit.
A wait or a review between crewmates on different computers is a solid arrow across the stage in its kind's color; nobody moves for it.
As two related glyphs close in on screen the arrow's clearance gives way, so a short arrow still shows.
Crew cross and pass close to one another freely; nothing moves a crewmate aside to keep it clear of another.
A missing blocker, or one with no crewmate yet, is a named link in the summary, never an invented crewmate and never a move.
Continuing, paused and unknown work keep their slots, colors, solids, labels and review cues.
Clearing the wait removes the cue and the offset glides home on the existing springs.
Reduced motion paints one settled frame.
Row inspection does not pause the stage; pointing at the glyph still does.
