# Infinitary — Design System

Infinitary is an AI assistant for software development and general knowledge work, shipped as an Electron desktop app (light + dark theme, dark default).
The product feeling: **calm, peaceful, confident, futuristic, a bit of space-travel fantasy, minimal, distraction-free**.

## Product concepts
- **The input** — the default state of the app is a single text input.
  Placeholder: `press/hold [keybind] to talk` (default keybind: right ⌥, quick press to toggle or hold to talk).
  It takes more than one line: the pill grows upward into a rounded rectangle as the draft grows, and the stage (the first mate and the card) lifts with it (`components/voice/VoiceInput.prompt.md`).
  Activated, its foot row becomes a live waveform with three controls: abandon (left end), accept, submit (rightmost), while the draft stays on screen.
- **The first launch** (captain decisions 2026-09-19; the app's `docs/first-launch.md`) — while no subscription can serve the first mate, the null state carries one caption under the character in the reserved null-state display type, "Welcome aboard Infinitary, Captain", then the first mate's own line asking to be set up on a computer that stays on, and the provider chip row (`components/core/ConnectChips`) so the sign-in happens right there; the input is `disabled` and dimmed with the line "connect a subscription first", and voice-key presses are ignored.
  It is state, not a flag: it returns if the last such subscription is removed.
  When the only thing missing is one fresh check of the custom connection the first mate was chosen on (its saved checks are an earlier version's), the caption names that connection instead - "Check Operator gateway again to begin" - with one sentence on what the check covers and that it may use billable tokens, and a primary Button "Check again" (pending "Checking...") that runs it in place; a failure takes that sentence's place in `--danger`, the chips stay below, and the input reads "check your connection first".
  Under the chips, a hairline apart, the group `YOUR FIRST MATE IS ON ANOTHER COMPUTER` offers "+ Paste its link" instead: this computer then joins Your devices on another computer, controls its first mate and can run its work (`components/devices/JoinAnotherMac`).
  For an eligible new setup, the host commits the first mate's approved copy as one ordinary note before publishing readiness, without waiting for inference (FI3-314, 2026-09-30; the exact copy, picture and starters live in the app's `src/shared/welcome.ts`).
  This replaces live welcome authorship.
  Since FI3-1164 (2026-10-06) the How we work note is an interactive presentation: a 520 by 190 picture of the window that shows one part per press, each with its words beside it inside the picture - the first mate over the lit message box, a card rising over it as it fades, Activity with a crewmate reporting into it, Tasks with its record, then the closing line - with only dots, a mono count, Back and Next under it, one `--accent` element lit at a time, one pass of `--dur-med` per Next and a cut for Back.
  Under it, "To begin, press one and finish the sentence:" and three starters (Clone a project, Start a new project, Work in a folder on my computer), whose press puts the start of an ask in the message box with the caret after it, sending nothing.
  The note has an ordinary close and no reply row; on a first installation no What's new card follows it, and the Tasks panel shows collapsed on the right from its creation on.
  Older installations and preconfigured starts are skipped; pending survives restart, creation is atomic and once-only, dismissal stays final, and an accepted first ask skips any still-uncreated introduction.
  A paused account alone does not qualify.
  Existing cards stay shown, and focus and panel choices stay unchanged.
  There is no tour of the window and no coach mark on it; the presentation stays inside its card; the caption dissolves as before, and the input reads "give your first mate a task, or press/hold right ⌥ to talk" until the captain's first turn.
  That first turn shows what every turn shows above the input: the captain's message, and under it the first mate's line working, then replying (`components/voice/VoiceInput.prompt.md`, "The last turn"); nothing is written above the character.
  Nothing in the first launch surfaces personalize.
- **First mate** — the character.
  A 4D wireframe structure (tesseract projection) of lines and dots with a pair of soft-light eyes in the inner cell (blinking, gaze wandering when idle), continuously animating under an explicit state machine (captain-approved spec: `firstmate/data/fm3000-character-animation-prototypes-s1/report.md`; the app's `src/renderer/src/character/` is the reference implementation — this package's `components/mate/Firstmate.jsx` mock predates the eyes and emotes).
  Base states: idle = near-still drift (ice cyan) with occasional fidgets; listening = the tesseract shapeshifts flat into two counter-rotating hexagons (Interstellar-robot style) breathing with the voice, spun faster by keystrokes — typing holds listening exactly like voice; working = fast double rotation, shimmer, pulsing nodes.
  The ember (`--wire-hot`) rides a separate busy parameter, not the state — hot means the agent's own turn is running, even mid-listening, and it cools in place when the turn ends.
  Consulting is the second parameter over working, never a state: while the agent's turn asks a stronger model the tesseract folds into the crystal - the listening hexagons stood up as a slowly turning hexagonal bipyramid in cool-white light, a band of light climbing its edges every 3s, the ember banked to half in the eyes and cores - and one band comes back down as it unfolds on the answer; attention and emotes still win, and the word "consult" reaches no user surface (the canvas keeps the state name).
  One-shot emotes overlay the base states and return home on their own: greet (bow + wink on app open), celebrate (spin burst + sparks, on a landed task), ponder, confused (stutter + jitter, on a failed turn), and a fidget pool drawn at random, also on a tap: roll, yawn, orbit, five sky fidgets (the captain's picks, 2026-09-29: Orion and the Big Dipper as traced stick figures on catalog star positions, Saturn with the listening hexagons as its rings and the eyes in the globe, a face-on spiral galaxy with the eyes in the bulge, and Algol with the eyes as the eclipsing pair and the whole light dipping at each eclipse) and the pretend black hole - every one of them in the character's own light, the wires fading as the 16 vertices settle on the figure and returning as it comes home.
  Five reply emotes answer the replies that carry no card (captain's board verdict, 2026-09-22), each short (1.4-2s) and built from the same parts - a pose, a look, line-art in the character's own light: nod "got it" (two nods, eyes squeezed into happy arcs), salute "on it" (a wind-up, then a snapped quarter turn with two motion arcs), tick "all set" (a light leaves the inner cell and draws a check beside the structure), tuck "noted" (a small light swoops into the inner cell behind a closing ring and one slow blink), aww "any time" (bashful happy eyes glancing away, a shy sway, line-art blush).
  A reply asked for during the agent's own turn plays as that turn ends, while the ember cools, and the app itself nods for a captain's steer, tucks for a kept note and ticks for an applied personalize.
  The agent's emotes carry a few plain words, at most 40 characters (captain's Approve and build on FI3-622's plan), and the app's own replies carry "Got it", "Noted" and "All set"; nothing is written above the character.
  On a captain's turn those words become the first mate's reply beside the captain's message above the input (`components/voice/VoiceInput.prompt.md`, "The last turn").
  Separate from the emotes, a notice pulse marks a card landing on the stack unseen: one soft ring of light swells out of the structure while the ambient glow lifts, then fades over ~1.4s - it changes no state, cuts nothing short, and remains unseen while cards are up: the pager dot and count are the notice then.
  A token flicker marks each finished model request on the character that made it (captain's board verdict, 2026-09-23): the wires flicker like a dim bulb's filament - each edge wavering white-hot on its own phase in four damped pulses over 2s - while the halo takes only a whisper (12%) of it, brightness on a log scale of the request's total tokens (100 tokens barely stirs, 500k and up runs the wires white).
  No token count ever shows, it changes no state, the resting character is untouched, and under reduced motion it does not play.
  Transitions are continuous morphs with named clips.
  Big and central in null state; stays mounted behind the cards, with its whole frame (crew, the line above it and model labels included) fading to hidden over `--dur-slow` whenever the stack has an entry and back when the last closes; reduced motion snaps, loops and agents keep running.
  Voice activation is keybind-only — a plain click on the input focuses it for typing.
- **Cards, not chat** - agent responses arrive as a prioritized stack of cards, one shown at a time.
  ONE card shape: its chip is derived from what it is, never declared - a card with actions is a decision, one without a note, one the app itself raised (sign in, the first mate down, a crewmate stuck past every nudge) an attention; a working preview is a decision whose body is interactive (`components/cards/ResponseCard`).
  No message bubbles ever.
  A new card never takes the shown card's place, and it is never gone unseen: it lands on the stack unread, the pager marks it (an accent dot on the arrow that leads to it, one "1 new" badge beside the pager - `components/cards/CardStack`) until it is paged to, and the first mate gives one notice pulse.
  A note the captain has already seen steps aside on its own once it is old: it collapses out of the stack into its task record.
  A closed card can be read again as a **past card** (`components/cards/ResponseCard`, "Past card"): a shell-held, read-only entry with a PAST strip, the version last seen with its figures, the submitted answers, the offered buttons shown inert with the chosen one marked, and its thread beside it with no reply row.
- **Tasks** — every ask the captain makes lands in a task record (`FM3K-12` keys, one project per managed repo plus Scratch).
  The captain reads the record in two places and writes it in none: the **now panel** (right side rail; `components/now/NowPanel`) is what IS - the host title row carries its header buttons, Search tasks and Open task board, between the panel title and collapse button, and Open task board stays beside the collapsed counts; expanded content has rows for "waiting on you" and "working", and "queued" / "backlog" / "done · 7d" collapsed to a count, with no waiting/working counts line.
  Collapsed Tasks says its waiting/working counts as its collapsed summary.
  Everything richer hides behind a rest or a click: resting on a row opens the crew summary beside it (the same panel a crewmate opens).
  Open task board (⌘B) shows every task as a focused **task board** on the stage (`components/now/TaskBoard`): Waiting on you above Backlog, Queued and Working, with Backlog, Done · 7d and dropped work as paged lists, the Tasks panel's own card on the stack, its tiles opening the record or the waiting card as a row does.
  Clicking a row opens the task's **record card** (`ResponseCard` kind `record`, body `components/cards/TaskRecord`): the crew summary's shared facts (Now, the plan the crewmate reported as a list), then goal, the captain's words verbatim, graph, timeline tail (each report line opens to its whole text), then the fact strip - the model, the pull request and its checks, the merge card's own shape - just above the action bar, everything on one left edge and every pull request number a link to its page.
  Each task has at most one shell-held entry: opening focuses it at the front immediately, records page with cards, Hide or Esc closes only the shown record, and outside clicks do nothing.
  Rows stay selected while their records are open, even when paged away.
  Every open record ends in the same action bar - Drop task at its left edge, and Start, Continue, Show the card or nothing at its right edge, read off the task's state; a dropped work record with no replacement or parts offers Start again in the next slot, while Done has no bar - and merge, discard and keep stay on cards (the captain's 4A, 2026-09-28; Drop task, FI3-243; one bar, FI3-565 piece 4).
  Every other write, from a steer to a merge, happens by talking to the first mate; a shown record card is what points the turn at that task.
  A task whose crewmate uses its own browser on this computer adds a Browser line to its record, and its `Open` brings the **task browser** view to the stage (`components/cards/TaskBrowser`): one row of chrome, the live page, a foot line and Hide, where the captain watches the crewmate drive.
  A crewmate's card may carry the same door as a **live attachment** labeled by the crewmate (`Try it`, `View booking`): a Browser strip between its body and its buttons whose click opens the view and answers nothing (`components/cards/ResponseCard`).
  The same door may name a page from the task's project, such as a finished game's `Play`: its click opens that page in the task's browser view with the captain in control, even after the task closed, and answers nothing.
  A model named in a container's top row is always the model chip (`components/core/Badge`), never truncated and never pushed out of view.
- **Knowledge** (all builds, stable included) — your directions and your knowledge graph: concepts and findings with their evidence.
  A compact **Knowledge panel** under Tasks in the right rail shows up to four directions in their own words with quiet links to all directions and the graph, and Open Knowledge puts up the **knowledge browser** on the stage (`components/knowledge/KnowledgeBrowser`): a 3D map of concepts the captain orbits like a game camera, Concepts and Findings lists, and one inspector with Overview, Evidence, History and Used in.
  Browsing writes nothing; standing directions have their own list and inspector.
- **Crewmates** — background workers the first mate delegates to.
  Rendered as 3D wireframe **solids**, deliberately simpler than the 4D first mate (dimensional hierarchy = org hierarchy), and richer for a stronger model: the slot a crewmate is served on picks a **tetrahedron** (low, and any crewmate whose slot is unknown), **octahedron** (medium), **icosahedron** (high) or **geodesic sphere** (premium) - never a hue, label or size (rules in `components/mate/Crewmate.prompt.md`).
  Never a focal point: on the home view each live crewmate orbits the first mate on three differently inclined planes, using the selected inner geometry from the first crew, filling inner to eight before middle to twelve, then outer to twenty (least-populated overflow after forty), with older crew gliding inward to fill vacated inner slots, and the captain-approved speeds and directions (`docs/crew-orbits.md`; quiet model-name labels only with one active orbit, fading in over `--dur-med` whenever they show, shown by default and switchable in Settings → Appearance; the whole stage slows to a tenth while the pointer is inside the formation and pauses while it is on a crewmate, whose instrument summary (one line per fact beside its label, then the fact strip of its model, intelligence level and reasoning, its pull request and checks, with why its model was chosen - the task record's shared facts) opens beside it and whose click opens its task record, the first mate's eyes alone staying alive through the pause), crewmates with host-evidenced continuing work heated toward ember and idle ones a dim ice cyan (including cool paused/unknown postures with an honest reason on the Tasks dot; `docs/crew-orbits.md` owns the shared work posture) (rules in `components/mate/Crewmate.prompt.md`); the only count is a small overview strip (n working / n idle).
  Above the strip, an **ActivityFeed** thread logs major crewmate events (spawn / report / decommission) — one-line rows with a colored type dot at the far left and a mono timestamp at the right, chromeless 1px rail, newest at the bottom, a thin left-edge thumb on the rail and a top dissolve when history outgrows the column.
  Both live in the left side rail as host-framed panels (the feed docks to the bottom, hugs its content, and caps its body at 320px; a feed row wraps to at most two lines at the rail's width); with nothing to show they are absent, and so is the rail.
  With multiple configured work computers, every other computer's crew form the home formation at half its size - the same orbits opening one by one as crew pile up, model names by the home rule per cluster, the same glyphs with the depth cue - in two wings left and right of the home formation beyond its edge plus a 40 px gap, stacked within a wing, each under its quiet machine name, with no plates, outlines, center markers or crew counts (the captain's FI3-1519 plan, 2026-10-10, on his FI3-1406 Home constellation).
  A machine name shows only on a cluster with crew, and only while some computer other than home has crew; an unreachable computer retains cool, frozen last-known crew and an Out of reach line under its name, never guessed activity.
  A control-only computer stays in Devices, and a known other user on the computer where the first mate lives belongs to the home cluster.
  The crew layer is the window, drawn under the rails, their panels, the cards and the message box, and nothing in the app moves for it; the whole scene, the first mate included, shrinks only when the window is narrower or shorter than it.
  The home animation stays unchanged in both single- and multi-computer scenes; a remote spark flies one smooth path from the first mate to its slot, taking about a second across the stage, a finished remote crewmate comes home the same way, and the black hole's rush never reaches a remote cluster.
  More than six computers use a keyboard-reachable paged overview with home on every page, never a work limit; every glyph remains keyboard-inspectable even when its model name is hidden.
  Geometry and the live placement projection are owned by `docs/crew-orbits.md`.
- **Side rails** - two dock columns, left and right, framing the stage (character, cards, input) on the home view.
  Empty by default and invisible when empty: zero width, no border, no header, no affordance, so a window with nothing docked is pixel-identical to one without rails.
  A rail is a vertical stack of host-framed panels at one fixed width (`--rail-width`, never resizable); the host owns each panel's title, attribution, and collapse, and a panel styles only its body region.
  The stage insets and is never covered.
  Nothing on a rail is drawn under the message box: where the window-centred box reaches into a rail's columns on a narrow page, a rail with an expanded panel ends above the box and its last-turn lane, and the box stands on a collapsed header at a rail's foot.
  A feed that gets shorter there keeps its newest line in sight.
  Rails carry contributed UX (the plugin system's `side-panel` slot); the app's own feed is the one panel on the left, and the now panel the one on the right.
  Once three of the captain's crewmates have finished their tasks and the captain has no panel of their own, the left rail opens with the create-your-own-panel slot, an empty dashed outline that invites one (`components/panel/Panel.prompt.md`); a panel of the captain's that names no place lands there.
  A panel declares its size: `content` hugs what it shows, `fill` takes the rail height its siblings leave.
  The app never attributes its own panels; a third party's panel carries its name in the header.
- **Subscriptions** - users add AI subscriptions (Claude, Codex, Grok) and connect OpenRouter with a browser sign-in or API key.
  The app discovers each subscription's models; you place them in four slots - premium, high, medium, low - and a starter placement is filled in when a subscription connects; it routes tasks by slot and remaining quota.
  Users can override model choice.
- **Where your projects live** - an optional section at the top of Settings -> Projects (`components/projects/ForgeRow`): the app's own sign-in to the place projects live (GitHub and GitLab), a chip row and a browser-code aside like the subscriptions', one quiet line when nothing is signed in.
  A project kept on this computer never needs it, and nothing anywhere suggests it does.
- **Projects folder** - the first row of the Projects list in Settings -> Projects (`components/projects/ProjectsFolder`): the folder the first mate clones into and starts new projects in, chosen with the system's folder picker, "default" while it is the app's own.
  Projects already set up never move.
- **Devices** (captain's picks on FI3-681 and FI3-682, 2026-10-03; pairing's rules are the app's `docs/devices.md`) - the first mate lives on one computer, and the person adds their other computers once.
  Any added computer can control that first mate while Infinitary is open on it - the same cards, feed, Tasks and conversation, keeping no record - and can run the work of a project set to run on it, with sign-ins of its own.
  Running as another user on this computer only runs work, with sign-ins of its own, and never controls the first mate.
  Like every user on the computer, it can read files in the person's home folder outside private folders such as Desktop and Documents, and every word about it says so.
  Settings → Devices, after Usage, holds one list, **Your devices**: This computer, running as another user, then each computer, each with Remove, beside the link or command panel and the address a link sends a computer to (`components/devices/DevicesTab`).
  A computer joins by a link pasted at its first launch (`components/devices/JoinAnotherMac`), by one command run in Terminal there, or by its address over Remote Login (`components/devices/AddAMac`); a link or command exists only after the captain's own click, works once for ten minutes, and never enters a card, a feed line or a conversation.
  A computer that controls reads "Controlling your first mate on MacBook Pro", keeps its own appearance, says "out of reach · as of" and refuses changes while it cannot reach that computer, and leaves with Leave (`components/devices/RemoteControl`).
  Each device's sign-ins are made in Settings → Intelligence, grouped by device, and what the person types there is kept nowhere (`components/devices/SignInOnAMac`).
  The moment a computer that runs work joins, the app raises one card of its own, "Finish setting up Mac mini", one row per thing it still needs with the button that opens that step in Settings, revised as each need is met and down by itself once it is set up (`components/devices/FinishSetup`).
  A project's Runs on menu offers Automatic for a compatible computer with room for each new task, or an explicit computer (`components/devices/RunsOn`).
  A started task stays on its computer, and `components/machines/MachineRow` is a device's row.
  Asking the first mate sets one task's own Runs on before it starts, which its record shows read-only.

## Sources
- Quota-tracking domain model: https://github.com/kunchenguid/quota-axi (src/types.ts, src/pace.ts) — provider ids, quota windows, pace/runway/burn-multiple semantics, intelligence buckets.
- No Figma, codebase, or brand assets were provided.
  **There is no logo**: render "Infinitary" in plain type (Space Grotesk 500) wherever a mark would go.
  All visuals here are original.

## CONTENT FUNDAMENTALS
- **Tone:** calm, competent, low-ceremony.
  The app talks like a trusted first officer: brief status, clear options, no exclamation points, no cheerleading.
- **Casing:** sentence case everywhere, including buttons ("Add subscription", "Submit").
  Micro-labels are uppercase with wide tracking (`CREW`, `QUOTA`, `ON PACE`).
- **Person:** the app addresses the user as "you"; the first mate refers to itself sparingly and never says "I'm excited".
  Task copy is factual: "Refactor finished.
  14 files changed."
- **Vocabulary:** every word the app shows is written for someone who has never opened a terminal (`copy/Vocabulary.prompt.md`, the plain-language pass): the say / never-say table is the one home - your project, a pull request, the checks, a branch, a working copy for the isolated copy, merge, a commit, lint, your plan's allowance, your sign-in - and a technical name is allowed only where the person chose it, where it is the thing itself on screen in mono, or one click deeper.
  The same rule and table reach the models through `CARD_AUTHORING` and the persona prompts.
  Measured by a hand-scored sample in the replay gate, never a banned-word list.
- **Numbers & data** are always mono (JetBrains Mono): quotas, percentages, host specs, keybinds.
- **Emoji:** never.
- **Examples:** placeholder — "press/hold right ⌥ to talk"; decision card title — "Two ways to fix the flaky test"; crew strip — "3 working · 5 idle"; quota — "62% left · on pace · resets Fri".
- **Card bodies:** semantic HTML in a sandboxed iframe, never one unstructured paragraph.
  The text the models read is `CARD_AUTHORING` (`src/core/prompts/cardContract.ts`, orchestrator contract v3.6 - the authoring half every persona includes once; the call mechanics live beside it in `CARD_MECHANICS`); this bullet is the design side of the same rule and must not drift from it.
  A card leads with its answer in one sentence (finished code-work completion cards are the exception: the title alone carries the answer, and the body opens at Why, then What changed, Before and After; `docs/card-authoring.md` owns that loose outline).
  An answer that explains how something works, compares options, or shows state, shape or layout is drawn - that sentence, then the figure or figures carrying it: inline SVG figures, small tables, a picture a crewmate names from its working copy, or (from a crewmate) an interactive prototype.
  This is a fact about the card, not a judgment the author makes: the audit `fm3000-card-visual-density-audit-s1` found the old conditional wording obeyed 0 times in 11 by the model family most work routes to, while every concrete rule in the same document was obeyed at or near 100%.
  An explanation with several parts gets several figures, each beside the short sentence it illustrates, rather than one crowded drawing.
  Prose carries what a picture cannot - a name, a number, a quote, a caveat - and stays in the open beside the figure it qualifies; `<details>` holds only what a reader who digs would want.
  The host retains kind, title, close, pager, and footer actions.
  A preview or a drawing of a project's screens takes that project's own look instead, read from its source - its colors, type, spacing and controls, which for Infinitary's own screens is this design system - and restyles every element it draws, since the frame stylesheet dresses whatever it leaves bare; the card's own answer, explanation and questions keep the app's look.
  Use design tokens for app UI: body `--text-base` / `--fg-2`; headings `--text-md` or `--text-base` / `--fg-1` / weight 500 (`h4` `--text-base` / `--fg-2`, `h5` `--text-sm`, `h6` the uppercase tracked micro label in `--text-xs` / `--fg-3`); code and `kbd` `--font-mono` / `--text-sm` (`kbd` is the keycap: `--bg-3`, `--line-1` with a 2px bottom edge, `--radius-s`); links `--accent`; `mark` `--fg-1` on `--accent-dim`; `details` a `--line-1` / `--radius-m` panel whose `summary` is `--fg-1` / weight 500 with a `--fg-3` disclosure caret; `figcaption` `--text-sm` / `--fg-3`; a picture (`img`) is a block that never reaches past the body's width, and one that would stand taller than 360 px shrinks to fit 360 px, whole, letterboxed on `--bg-1` - never cropped; several in a `figure.inf-pictures` are a group, lead and strip: the first leads under that rule, the rest are 88 x 60 thumbnails (`--line-1` border, `--radius-s`) cropped to their top, five shown and then a mono `+N` tile on `--bg-1` counting the rest, beside the fifth while the line has room, and the `figcaption` under them is the group's caption.
  Something new is a figure marked `data-inf-new`: it draws a **New** tag - `--font-mono` / `--text-xs` / `--fg-1` on `--accent-dim` with a `--accent` hairline and `--radius-s`, inset `--space-1` from the figure's top-left corner - so a picture with no before reads as new, never as an omission; the mark sits on the figure, never on its `img`, which cannot draw the tag; a completion card's Before and After each hold as many pictures as the change needs, a view in both keeping the same order and caption, and a card for a change nobody can see carries one sentence in an element marked `data-inf-no-picture`.
  A click on any picture, or on a group's `+N` tile, opens it large in the picture viewer over the window, paging within its group (`components/cards/PictureViewer.prompt.md`).
  An element marked `data-inf-theme="dark"` or `data-inf-theme="light"` shows only while the frame is in that theme, so a dark and a light picture of one view swap with the theme; the startup note's highlights carry their hero pair this way, each picture on a mat - a `--line-1` hairline panel on `--bg-1` with `--space-3` of padding and `--radius-s` - so a picture of a card keeps one visible edge instead of two (`docs/release-notes.md`).
  Figures are inline SVG, written by hand, and no shape is prescribed - draw whatever the explanation calls for.
  All of SVG renders (any shape, path, gradient, filter, marker, wrapped text via `<foreignObject>`).
  What makes a figure belong to the app is the design system: a `viewBox` 750 units wide with `width="100%"` for a full-width drawing, or a pixel width when the drawing is smaller so the card only shrinks it, `--fg-2` inherited as `currentColor`, color from theme tokens through `style` (`fill:var(--accent)`, `stroke:var(--line-2)`) so it follows light and dark, `--accent` on the single most-current or lit element within each figure - one accent per figure, not one per card - non-accent tokens for everything else it draws, and `--ok` / `--warn` / `--danger` / `--idle` only for real state, in `StatusDot`'s language (`components/viz/Viz.prompt.md`).
  External resources are forbidden - the frame loads nothing - though an image the body carries itself as a `data:` URI renders, and so does a picture the host verified and serves from its own copy, and a preview's project font file, which the host checks, loads and serves from its own copy the same way (`docs/card-authoring.md`, "Fonts by reference"); `data-inf-action` may mirror a declared action, except any action carrying an effect (`settle`, `open`, or the app's own `host` op), which is the footer button's alone.
  A card carrying a settle effect shows the host-rendered fact strip (`.inf-facts`, contract v2.7) at the start of its action row, pushed left of the buttons, so it stays in view however long the body is; when the row is too narrow it takes its own row above the buttons, and its hairline shows only where it follows a body (a past card): one labeled single-line cell per fact - project, the crewmate's model (labelled Model, named through the one model-name lookup), the task's effective care (Quick, Default or Careful), the pull request by the label the project's host gave it (`#N` on GitHub, the pushed branch on a plain Git host) as a link only where the host has a page, underlined only while the pointer rests on it, the checks' state, the CI and review round counts against their caps once the host has counted any (contract v3.6), and the review on a reviewed task - labels in the `h6` micro-label style, identifiers in `--font-mono`, the checks, the caps and review carrying a `StatusDot`-language dot; the checks reading's age, the head the checks last failed on, and the review's risk note ride the cells' `title` attributes.
  A cell never wraps internally: a too-long value truncates with an ellipsis, and only whole cells wrap to the next row.
  The body never repeats these facts.
  At the end of the body on a card whose button merges, the host draws "Filed while working on this" (`.inf-followups`): one single-line row per open follow-up filed from the task - key in `--font-mono`, title cut with an ellipsis, and one word at the end (must merge first in `--warn` with the warning mark, starts once this merges, working, queued, backlog), the full sentence on hover.
  At the end of the body on a card whose button sends something where the project lives, the host draws what the click sends, once (`.inf-call`): a `--line-1` / `--radius-m` panel with the `h6` micro label naming where it goes, the call in `--font-mono`, and one `--text-sm` line in `--fg-3`.
  For a merge past the branch rules it reads the pull request, its version and squash, then one row per rule it may skip with its rule set in `--fg-3` and one `--warn` row per failed check, and the host names the button `Merge, skipping the rules`; the author's `Not now` stays beside it.
  For a write a crewmate asks to send (`request_write`) it reads the method and path, then the JSON body in a `pre` on `--bg-1` with `--radius-s`, at most 240 px tall and scrolled inside, and the host names the button `Send it to GitHub` after the host's own name; the author's `Not now` stays beside it.
  A card revised since the captain last looked carries the host's revised line under its title and a 2 px `--accent` change bar in the body's margin beside each new paragraph, list item, table row, figure or question - "Rewritten" and no bars when more than half is new, the line alone on a playable preview - a body with a `<style>` sheet, a `<canvas>` or a script outside every figure (`components/cards/ResponseCard.prompt.md`); a body never draws its own.
  A decision with several questions asks them in the body as ordinary named form controls presented however reads best - the proposed option checked, `required` on a must-pick, a bound `<label>` per option - and a pick sends nothing: the footer counts the picks and its button sends them all (`components/cards/ResponseCard.prompt.md`).
  An inline `<script>` (never `src`) may add behavior - draw a `<canvas>` in token colors read from the frame's computed style, toggle a view, raise a declared action with `inf.action`, move a figure - and can load nothing.
  A `<button data-inf-draft="words">` needs no script: the captain's own press puts its one line of words at the start of the message box, caret after them, sending nothing.
  A figure plays only when a press shows what one still drawing cannot hold - the same thing in two places or more states than panels would fit - and a figure with one value the reader would vary takes one control.
  Every other figure stays still, including timelines, charts, numbered steps and flows; a cursor or highlight sweeping a drawing that already shows every state adds nothing.
  Previews are exempt: they draw something that does not exist yet.
  A moving figure moves only on a press or a drag, one pass, its script inside its `<figure>`, so the card stays prose (`components/viz/Viz.prompt.md`, Motion).
  A card whose script stops answering is replaced by one quiet line in the body (`--fg-3`, `--text-sm`: "This card stopped responding.") with a secondary small "Retry" Button beside it; the card chrome stays.

## VISUAL FOUNDATIONS
- **Palette:** deep-space blue-black base (`--bg-0 #05070d`), ice-cyan accent (`--accent #7fdcff`) = the first mate's light.
  Exactly two chromatic families: ice cyan for everything calm (accent, ok, medium bucket) and ember/lava (`--hot #ffa257`, `--danger #ff6b52`) for the occasional hot thing — energy, sun, fire: warnings, high-intelligence bucket, the working first mate.
  Everything else is neutral gray.
  Light theme via `[data-theme="light"]`.
  One accent at a time within each thing being read - a screen's chrome, and inside a card each figure on its own, so a card with several figures may light one element per figure; large areas are the tint over the desktop - `--material-tint`, the void at 0% by default - and read against the blurred desktop rather than as a fixed opaque color.
- **Type:** Space Grotesk (UI/display, weights 300–600); JetBrains Mono (data).
  Display is light (300–400) and large with tight tracking; labels are 11px uppercase tracked +0.09em.
- **Spacing:** 4px scale, generous by default (`--space-5..8` between regions).
  Emptiness is a feature — the null state is ~90% empty.
  Settings has two gaps, owned by `settingRows.tsx` (`SECTION_GAP` 32 above a section, `ROW_GAP` 12 between rows and from a label or intro line to its first row) plus `LABEL_GAP` 8 from a label to its intro line; a tab never writes its own.
- **Backgrounds:** the window is translucent on macOS (the app's `docs/translucent-window.md`): native under-window material on shown Macs, tinted once by the body with `--material-tint` at the chosen wash opacity (0% by default); the app paints no other window-sized surface, no imagery, no gradients except a barely-there radial glow behind the first mate (`--accent-glow` at low opacity, lifted by `--halo-boost`).
  No textures, no patterns.
  Panels stay chromeless on the tint and the voice input's shell is its hairline alone; cards paint solid `--bg-2` without blur; only modal overlays keep their own blur.
  Hairlines (`--line-1`) and tertiary text (`--fg-3`) are set for the material, not the opaque void.
  Reduce transparency in macOS accessibility brings the opaque `--bg-0` back.
- **Borders & cards:** 1px hairlines `--line-1`.
  Cards, stack peeks and card/thread pairs are solid `--bg-2`, with no backdrop blur, `--line-1` borders and the unchanged highlight/drop shadow.
  Legacy `--acrylic-*` names remain as material aliases.
  Frames stay transparent; settings surfaces and the picture viewer are unchanged.
  No colored left-border accents.
- **Radii:** 6 / 10 / 16 / pill.
  The voice input is a pill at one line; taller, it keeps `--prompt-radius` (half its one-line height), never a larger one.
- **Shadows/glow:** shadows are for depth only (dark, diffuse).
  Glow (`--glow-accent`) is reserved for the first mate and active states.
- **Motion:** 160 in place (`--dur-fast`), 360 for a surface (`--dur-med`), 700 for a dissolve (`--dur-slow`); the card stack, popovers, hover summaries and icon-button labels have their own moves below (the captain's Build it on FI3-747's livelier-motion prototype, 2026-10-03).
  Entrances and moves use `--ease-out`, the glide (`cubic-bezier(0.32,0.72,0,1)`); state and bars use `--ease-drift`.
  Paging with the arrows slides the next card in from the arrow's side as the drawing it replaces slides out the other way, `--move-page` (32px) over `--dur-page` (300ms), and the page number slides with it.
  A close takes effect at once and never waits: the card leaves the stack, and only its drawing drops away, `--move-drop` (10px) down to `--scale-stack` (97%), fading over `--dur-quick` (200ms).
  Meanwhile the next card comes forward from the stack's edge, `--move-stack` (8px) up and from `--scale-stack`, over `--dur-page`, and the peeks behind it move up one place; the last card drops away the same way.
  A card on an empty stage fades, rises `--move-arrive` (12px) and grows from `--scale-arrive` (98%) over `--dur-arrive` (420ms); any other replacement is one crossfade over `--dur-fast`; first paint is static.
  Popovers - the update panel, the Reduced motion panel and every row menu - grow from their button's centre, from `--scale-pop` (94%) over `--dur-quick`, and fade out over `--dur-popover-out` (120ms), inert while they fade.
  A hover summary slides `--move-summary` (8px) out from what it describes over `--dur-quick` while its hairline draws; resting on another row, key or crewmate while one shows, or within 300ms after it went, moves it there at once; letting go fades it over `--dur-summary-out` (100ms).
  An icon button's label is drawn by the app, never the native title, for the pointer's rest and the keyboard's focus alike: the first waits `--delay-label` (500ms) and fades in, the next moves over from its neighbour at once, and leaving or a press takes it away at once.
  Animate opacity and transform; the sole geometry exception is replacement-only card-shell height over `--dur-med`, after initialized destination-width drawing, without scaling content or tweening width.
  Never animate same-entry growth, new blur or perpetual UI motion, and never bounce; state commits immediately and never waits for motion.
  The shared `tokens/effects.css` rule zeroes every duration token under reduced motion in the shell and every frame, so each move above is a cut, and a summary opens after the beat and closes at once.
  Only opacity-only fades of 160 ms or less may opt in with `--dur-fade` (160 ms), which stays nonzero; drift, size and blur transitions stop.
  Frame bodies share the stylesheet; an author’s own scripts are untouched.
  The first mate and crewmate structures keep their intentional motion and their own reduced-motion guards; never bounces, never spins UI chrome.
- **Hover:** background lifts one step (`--bg-3`) or opacity 0.8→1; text stays put.
  **Press:** no shrink; background darkens slightly.
  **Focus:** `--focus-ring` (hairline + soft glow), never a browser-default outline: the window and every frame draw it on whatever the keyboard reaches, over a selected row's tint rather than in place of it, and a part of the window F6 lands on (a panel's list, the shown card whole, Settings' tabs) draws it too; whatever an edge would cut draws `--focus-ring-inset`, the same hairline and glow turned inward: a card's body, which the card clips, the Activity list and a Tasks row or group header, which span the frame, and the Models heading, which its disclosure clips.
  Never write `inset var(--focus-ring)`: `inset` turns only the first shadow, the hairline, inward, and the edge still cuts the glow.
  **Facts shown on rest:** a fact the app shows on rest - a mark's meaning, a reset time, the exact time behind a short age, why a chip cannot be pressed, words cut short - is drawn in the icon button's label, never the native title, for the pointer's rest and the keyboard's focus alike.
  The element that holds it is a Tab stop of its own (words cut short only while cut), and its accessible name or description carries the same words, because the label is hidden from assistive technology (`docs/keyboard.md`, "Facts shown on rest").
  A control that cannot be pressed for a reason is marked off rather than disabled - dimmed, still a Tab stop, its reason on rest and as its description - and a fact that sits inside a control rides that control's focus and description.
- **Transparency/blur:** overlays use `--blur-overlay` over `--bg-0` at ~80% opacity — used only for modal-level surfaces.
- **Data viz:** thin 2–3px bars, mono numerals, semantic pace colors; no chart junk.

### Long developer lists

Observe keeps its existing two-pane layout and token styling.
Long transcripts and crew lists mount only the viewport plus a small overscan, with measured variable-height rows rather than clipped text or fixed-height guesses.
Scrollers persist across updates.
Reading history stays anchored to the same row when data or width changes; streaming follows the bottom only while the reader is there.
Main, Crew, Review, and Panels keep their worded group headings.
The retired supervision session is not a group.
Windowing adds no animation or new chrome, and keyboard selection must still reach offscreen sessions.

## LINUX DESKTOP CONVENTIONS

The app on Linux is the same app in the same design system: one window, the same tokens, type, cards and character.
Where a Mac and a Linux desktop differ, the app follows the computer it runs on, and a Mac keeps everything above unchanged (the captain's picks on FI3-1432; the app's `docs/architecture.md`, "Desktop platform facts", owns which system gets which).
What differs is decided by the system, never by the person's choice of desktop: Ubuntu, Fedora, Arch, Omarchy and NixOS read the same.

- **Keys:** Ctrl takes ⌘'s place in every key the app gives.
  Ctrl+K searches commands, Ctrl+L goes to the main message, Ctrl+, opens Settings, Ctrl+Shift+[ and Ctrl+Shift+] page the cards, and Ctrl+Plus, Ctrl+Minus and Ctrl+0 change the size.
  The message box's Mac-style Control keys (Ctrl+U, Ctrl+K, Ctrl+W, Ctrl+Y and Ctrl+P) are off, so Ctrl+K is search everywhere; ↑ still brings back the last message, and Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y step through the field's own undo.
  Ctrl+Q quits Infinitary and Ctrl+W closes the window.
  A Linux desktop keeps the Super key, Ctrl+Alt with a function key or T, Alt+F4, the editing keys and the input method's keys for itself, so Keyboard settings refuses them and says which job each keeps.
- **Key words:** a key reads as Linux writes it, in words joined by `+`, modifiers in the order Ctrl, Alt, Shift, Super: `Ctrl+Shift+L`, `Ctrl+,`, a two-key shortcut `Ctrl+K S`.
  Named keys read Esc, Enter, Tab, Backspace and Space, and the arrows keep ↑ ↓ ← →.
  It sits in the same mono `KeyCap` and after an icon button's words exactly as `⌘,` does on a Mac (`Settings Ctrl+,`).
  Words that name a key elsewhere follow it: "Ctrl+Plus and Ctrl+Minus change the same size", "Hold Alt as you drop".
- **The dictation key:** right Ctrl by default, because right Alt types accented letters on many Linux keyboards; the choices read right Alt, right Super and right Ctrl, and the key cap shows `Ctrl`, `Alt` or `Super`.
  The input's placeholder names it: "type, or press/hold right Ctrl to talk", and an input too narrow even for "press/hold right Ctrl to talk" reads "hold right Ctrl to talk".
- **Dictation without a graphics card:** a Linux computer with no graphics card speech can run on has no dictation, as on a Mac without one: the placeholder reads "type a task for a crewmate", the key does nothing, and nothing says why.
- **Window controls:** the window has no system title bar and no menu bar.
  The top bar keeps its 52 px, its drag and its 16 px left edge, with no 80 px room for the Mac's buttons.
  Its right end holds the window controls, as Linux desktops put them: three neutral 32 px `IconButton`s, 6 px apart like the top bar's other buttons, Minimize (Lucide `minus`), Maximize or Restore (Lucide `square`, or `copy` while the window is maximized) and Close window (Lucide `x`), 16 px from the window's right edge and `--space-3` past the app's own buttons.
  Each draws its label under it like every icon button, takes Tab in the top bar's order after the Settings gear, and draws the focus ring.
  They float over everything the window shows, the picture viewer and command search included, as the Mac's buttons do, and every surface that covers the top bar clears them at its right edge as it clears the Mac's at its left.
- **Menus:** there is no menu bar.
  Settings is the gear and Ctrl+,; Keyboard settings, Reset all keys and What's new are in Settings and command search.
- **Closing the window:** the first mate and its crew keep working.
  The app's icon stays in the desktop's top bar while Infinitary runs: the app icon's mark (`assets/app-icon.svg`) without its rounded body, and pressing it opens the window again.
  Its menu holds Open Infinitary and Quit Infinitary, in that order; opening Infinitary again from the desktop's app list also opens the window.
- **Settings:** Start at login stays, with the same words, and writes the desktop's autostart entry.
  Show in dock and Window wash are absent: Linux has no Dock, and the window is the opaque void (`--bg-0`), so nothing washes over a desktop behind it.
- **The system's settings:** a line that sends the person to their settings names the desktop's, never macOS's.
  The Reduced motion panel ends "To change it, turn animations back on in your desktop's accessibility settings."
  The microphone line ends "Turn it on in your desktop's privacy settings."
  There is no Open System Settings button, because no desktop gives the app one page to open.

## ICONOGRAPHY
- **Icon set:** [Lucide](https://lucide.dev) via CDN (`lucide` UMD), stroke 1.5, sized 14–18px, colored `currentColor`.
  Chosen for its thin, even stroke that matches the wireframe character.
  Used sparingly: controls on the voice input (x / check / arrow-up), card actions, settings rows.
- No icon font, no emoji, no unicode-as-icon (except keybind glyphs ⌥ ⌘ ⇧ in KeyCap, which are legitimate keyboard symbols).
- **App icon:** `assets/app-icon.svg` — two nested hexagon rings (outer bright accent, inner twisted 30°, dim) with a center dot: the first mate's listening form, calm and geometric.
  The source is a square 1024 base; `scripts/render-app-icon.mjs` scales it into an 824px rounded body (185px radius) with a 100px transparent margin for macOS packaging. macOS 12–15 draw the supplied shape; macOS 26 normalizes it with the system squircle.
  Do not depend on the system mask to shape the legacy icon.
  No logo was provided; this mark derives from the character itself.
- The first mate and crewmate structures are canvas-rendered, never SVG icons.
- **No logo exists** (none provided; none invented).
  Wordmark = "Infinitary" in Space Grotesk 500.

## Index
- `styles.css` → `tokens/` (colors, typography, spacing, effects, fonts)
- `components/core/` — Button, IconButton, Input, Switch, GroupedPills, Badge, KeyCap, StatusDot, RowMenu, and CommandSearch, KeyboardSettings and TaskKey, the rule for every task key the app shows (prompt pages only)
- `components/mate/` — Firstmate (4D character), Crewmate (3D mini), CrewStrip
- `components/voice/` — VoiceInput (idle ↔ recording states)
- `components/cards/` — ResponseCard, CardStack, TaskRecord (the record card's body), TaskCrewmate (a task's Crewmate tab: its crewmate's session as a transcript, and a prompt that steers it), TaskBrowser (a task's own browser on the stage), PanelCard (one of a panel's cards on the stack)
- `components/now/` — NowPanel (the right rail's now panel: rows, group headers, the counts line)
- `components/knowledge/` — KnowledgeBrowser: the Knowledge panel and its browser, a 3D concept graph, Concepts and Findings, and one inspector (all builds; prompt page only)
- `components/panel/` — the five panel primitives every side panel is built from (`Panel.prompt.md`): Row, FeedLine, MicroLabel, Empty, Disclosure
- `components/quota/` — QuotaMeter, QuotaMicroMeter, SubscriptionCard, SlotBadge
- `components/devices/` — DevicesTab, JoinAnotherMac, RemoteControl, AddAMac, SignInOnAMac, RunsOn, FinishSetup: Your devices, controlling the first mate from another computer, running its work there, and finishing a computer's setup (prompt pages only)
- `components/machines/` — MachineRow, a device's row in Your devices
- `components/usage/` — UsageTab: Settings → Usage, the fleet's recorded model usage in tokens or estimated dollars (prompt page only)
- `copy/` — the vocabulary: the words the app says and never says (`Vocabulary.prompt.md`)
- `components/viz/` — how a figure should look to belong in the app (`Viz.prompt.md`): scaling, token color, state-color semantics, type, weight, motion.
  No prescribed shapes and no helper — a card body hand-writes its SVG.
- `ui_kits/firstmate/` — full app screens (null state, listening, working w/ card stack, and Settings: General, Appearance, Projects, Intelligence, Devices)
- `guidelines/` — foundation specimen cards (including card-body markdown)
- `SKILL.md` — agent skill entry point

## Intentional additions
From-scratch system (no source inventory), so the component set was authored to the product brief.
KeyCap exists because keybinds are a first-class UI concept here.

## Offline completeness
This package is fully self-contained; nothing loads from a CDN at runtime.
- Fonts: Space Grotesk + JetBrains Mono woff2 binaries are vendored in `assets/fonts/` (SIL Open Font License 1.1); `tokens/fonts.css` declares local `@font-face` rules.
  Regeneration instructions are in the header of that file.
- Mock runtime: the click-through pages (`ui_kits/`, `components/*.card.html`) load React 18.3.1, ReactDOM, and Babel standalone 7.29.0 from `vendor/` (verified against the upstream SRI hashes).
  This runtime is for the mock only - production code bundles its own dependencies.
  The Settings mock and the quota card load components the prebuilt `_ds_bundle.js` carries stale from their sources, which the browser reads only over HTTP, so serve the skill directory rather than opening those pages from disk.
- Icons: components draw their icons inline; nothing loads Lucide at runtime.
  Production code should depend on the `lucide-react` npm package (bundled at build time), never the CDN.
