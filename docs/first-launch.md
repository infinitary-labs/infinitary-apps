# The first launch

The captain's decisions of 2026-09-19: a brand-new user gets a model before they can try anything, the app does not teach itself with a tour of the window, and personalize is left to be discovered by asking.
The captain's decision of 2026-10-06 (FI3-1124) adds one door to personalize: the create-your-own-panel slot, once a task has finished.

## Before the first-launch shell

Saved work from an unsupported newer database or persisted format stops startup before sign-ins, launch counters or agents start.
A standalone window explains that a compatible alpha or stable is needed; no normal shell or first-launch gate is initialized.
Supported old/current state opens normally.
See `docs/saved-data-compatibility.md` for the guard.

## What a fresh install shows

The null state is unchanged - the character greets, the pill sits below - except for one caption under the character while **no model can answer the first mate**: "Welcome aboard Infinitary, Captain", then the first mate's own line.
That line reads "I'm your first mate.
I'll help you manage the rest of the crew."
Under it the first mate asks where it lives before anything opens (the captain's approval of INF-6207, "ask first"): "Where should I live?
Pick a computer that stays on as much as possible."
Three equal cards follow in one row, each a button whose line says how that setup works:

1. **This computer** - "Sign in to a subscription here.
   I live and work on this computer." - opens the provider chips below.
2. **Another computer** - "Give its address and I set myself up there over SSH.
   You control me from here." - opens the setup over SSH, with the commands route one press away ("Setting it up from here" below).
3. **One already running** - "Connect to me where I already run on another computer, and control me from here." - opens the chips that join a first mate on another computer.

Tab reaches each card, the arrow keys move between them, and Enter or Space opens one; a narrow stage stacks them.
`tests/browser/first-launch-choices.test.tsx` drives the cards by keys, the commands route to the paste box, and Where I live back.
Under the cards, "You can move me to another computer later, in Settings → Devices." says the move after setup stays the fallback (`docs/devices.md`).
An opened choice shows "‹ Where I live" above it, which returns to the three cards; a gate that closes and comes back asks afresh.
A subscription that is connected and still cannot answer keeps the older heading, "Set up your first mate on this computer", and its remaining-need line, and opens on This computer, where that account shows.
A computer that controls another's first mate, and a fresh check (below), ask nothing: they show their chips at once.
The same provider chip row the Intelligence tab has sits under This computer, in catalog order, one group.
Sign-in happens right there: a chip runs the provider's own flow (Pi's select, a browser bounce or a device code, a pasted key) through the same aside the tab renders, anchored under the row.
While a sign-in step is up (`data-sign-in-step`), the band takes the held input's room, the input is hidden, and a window under 720 pixels tall hides the heading, so a code step fits the smallest window without scrolling (INF-842).
The input is disabled meanwhile, dimmed, with its own line ("connect a subscription first"), and hold-to-talk is ignored in the same state.
Before the window's first read of the gate settles, nobody knows yet whether it is up, so the input is held the same way: no typing, files, focus or hold-to-talk (`mainInputHeld`, `src/renderer/src/app/composer.ts`).
Words sent in that moment would reach a first mate that cannot answer and skip the welcome.
The held input keeps full strength and its usual hint, so a launch that is ready never fades in; a fresh one dims when the gate's caption arrives.
A first read that fails still settles it, and the input opens as it did before any read rather than waiting for a read that may not come.
An answer that would open the input applies only after the window's fence (`docs/architecture.md` section 17), so every push the core sent before answering, the welcome's card among them, reaches the window before the input opens.
A newer read wins over an older one still waiting at the fence.
An account connected while the gate is up - one that cannot answer yet - shows in place of its chip, with a hollow dot and why when the app knows ("install Claude Code first" when the Mac has no Claude Code, "not signed in" for a login not signed in yet), and the caption restates the one remaining need: "Your first mate still needs a subscription that answers - Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter with an API key, or Amazon Bedrock with your AWS sign-in."

When the gate is up only because the custom connection the first mate was chosen on needs one fresh check, the caption asks for that check instead of a subscription.
That happens after an upgrade whose check profile is new, which makes every saved check an earlier version's (`docs/custom-api.md`, "Protocol and storage profile").
The core says so as `freshCheck` on `inf:app:first-run`: the enabled connection holding the first mate's chosen model, and its models whose saved check no longer counts.
The caption names the connection ("Check Operator gateway again to begin"), then one sentence on the models the check covers and that checking may use billable tokens, then a primary **Check again**.
The words live in `src/renderer/src/app/firstRunGateWords.ts`, and the input reads "check your connection first" (`GATED_CHECK_PLACEHOLDER`).
**Check again** runs the check right there (`inf:accounts:custom:recheck`); a failure takes the sentence's place above the button, and a passing check closes the gate without a restart.
A short window keeps that sentence, since it says what the check may cost before it is pressed, and the band scrolls.
The provider chips stay below it for a person who would rather connect a subscription, and a Mac that controls another's first mate runs the same check there.

A person with only Claude on this Mac completes the first launch on it: the Claude chip goes straight to the Mac's own login (Claude signs in one way), the gate closes, and the first mate - seated on Claude (`docs/architecture.md` §16.1) - owns the host-presented welcome and answers the first turn.
`tests/e2e/first-launch.spec.ts` runs it against the mock provider through the SDK's own client, as a user the Keychain holds no Claude login for, so the sign-in never reaches the person's own (`tests/e2e/claudeSeat.ts`).

The gate is **derived, never flagged**: `FirstRunService` (`src/core/ firstRun.ts`) reads it as "no routable model can answer the first mate" - its provider's role and an account the seat can stand on (`Flagship.servesFirstmate`), the exact pre-flight `resolveModel` (`firstmateModelPick.ts`) performs before a session can be built.
It is true on a fresh install, false the moment an account that can serve the first mate signs in - Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter with an API key, or Amazon Bedrock with your AWS sign-in (or a custom provider in the app's `models.json` exists, which is how dev and every other e2e run, or the dev-only local seat of `docs/local-orchestrator.md` is set) - and true again if the last such account is ever removed or cannot run (a Claude login with no Claude Code, which the stage names).
A provider outside the catalog counts only when the app's `models.json` defines it or the app's auth file saves its key (`PiAuthService.customProviderModels`): Pi also serves a built-in provider whose key it finds in the process environment, such as `OPENAI_API_KEY`, and a Windows app keeps its whole environment (`hostEnv.ts`), so such a key, which outlives an uninstall and a data wipe, never closes the gate on its own.
A seat that is only paused - its account refused, signed out or out of allowance by a typed cut-off the vault holds (`Flagship.standsOnCutOff`) - keeps the gate down: the pause card speaks for it, the input stays open, and the captain's words wait on the inbox (`docs/architecture.md` §16.8).
The renderer reads it over `inf:app:first-run` (a core channel on the frozen `app` namespace; `window.infinitary.app.firstRun`), at boot, on every quota push (one follows each account change), on every model change, and after the gate's own sign-in or fresh check; `FirstRunGate` (`src/renderer/src/app/FirstRunGate.tsx`) draws it and dissolves over `--dur-slow` when it closes.

## Joining the first mate on another Mac

One already running opens a group, a hairline apart, that offers the other way in: `YOUR FIRST MATE IS ON ANOTHER COMPUTER` with "+ Paste its link" and "+ Join by its address", which join the first mate on a computer the person already has instead (`docs/view.md`, "Joining").
On a Mac or an x64 Linux computer "+ Set up from your first mate's computer" leads them, with the three chips on their own line: its aside shows this computer's address, private network first, whether Remote Login is on, and the line to compare, and waits for that computer to add this one (`docs/view.md`, "Set up from your first mate's computer").
Once it does, this window opens that first mate by itself, with no relaunch, while nothing was done on this computer yet: no sign-in, connection, project or turn (`docs/view.md`, "Following along").
Another computer's "Set it up with commands", under its address form and on each of its stops, sets the first mate up there by commands instead (`docs/run.md`), in numbered steps under "Set me up on another computer with commands": install Infinitary there; start it, with `infinitary start-at-boot` ("Starting at boot"); make a link for this computer, with `infinitary link` ("A link by command"); and paste the link it prints here.
Each command sits in a mono box with its own Copy, and a line under the steps says a Mac types `/Applications/Infinitary.app/Contents/MacOS/Infinitary` in place of `infinitary`.
The last step's "Paste its link" opens One already running at its paste box, so the link joins as any pasted link does; its Cancel leaves One already running's chips.
When a connected subscription still cannot answer, the first mate's line keeps "Pick a computer that stays on.
Other computers need it awake."
These explanations stay visible in a short window, where the band scrolls.
After this app stops controlling that Mac it returns here, and one line under the three cards says which Mac it left, or that the Mac removed it.
The gate itself stays derived; the line only says what happened.

## Setting it up from here

Another computer opens "Set me up on another computer" (the captain's approval of INF-6207, part 2; design skill `components/devices/SetUpThere`, `src/renderer/src/devices/SetUpThere.tsx`): the address form Join by its address has, with its port field and the computers nearby, and "Set it up with commands" under it.
Continue runs seven steps in a list under "Setting up your first mate on studio", the one under way lit, each done step with what it found beside it:

1. **Read its SSH key** - the key line to compare, asked once before any sign-in, as Join by its address asks it; the step names the port where one was typed, and its stop names the port the person's SSH settings resolve.
2. **Sign in with your SSH key** - the person's own SSH, or that account's password once where the computer did not let the key in, which lets Infinitary's own key in.
3. **Check its system** - what it is, what it lacks, whether a Linux computer has systemd to start it at every restart, and who signed in.
   An account that already runs work for another first mate, or whose closed window joined one, stops with "studio already runs work for another first mate.", checked again as `infinitary` after a root sign-in, so two first mates never share that account's record.
   A root sign-in on Linux asks once whether to make an ordinary account named `infinitary` there; a yes makes it with root's SSH keys and linger on, and the setup goes on as that account, whose system is checked again as that account; the Ubuntu package still goes in over root's sign-in, since the new account may not install software.
   Infinitary open there already for that account stops the setup with "Infinitary already runs on studio." and **Connect to it instead**, which opens Join by its address with that address.
   Only an account where no Infinitary is open goes on: one that controls another computer, or an answer with no link, stops the setup, so a second copy never starts beside it.
4. **Send Infinitary** - the Ubuntu package where it applies (24.04 and 26.04), otherwise the copy for its system, kept in that account's own `~/Applications`, with the megabytes sent beside the step.
5. **Start your first mate there** - the kept copy's own `start-at-boot` (`docs/run.md`, "Starting at boot"), which starts the record that account already has, never a new one in its place.
6. **Connect from here** - port 47623: Join by its address's two requests, asked again every two seconds for up to a minute while the first mate there opens, or for as long as a Mac account that is not logged in waits for its login, which a line says.
   Its key line was said yes to at step 1, so it joins without asking again.
7. **Connect a subscription for it** - joined, the window starts over as that computer's, whose own first launch signs in from here.

The first five are one core request, `inf:devices:home-at`, asked again with each answer as Join by its address asks (`src/core/devices/homeAt.ts`, `docs/devices.md`, "Setting the first mate up from a first launch").
A stop marks its step and says what stopped it and what to try (`homeAtRefusalLines`, `src/shared/homeAt.ts`), with **Ask again**, **Set it up with commands** and **Back** (to the address form, its fields kept), and a footer such as "4 more steps not started · nothing changed on studio", or that the first mate keeps running there once it started; once an account was made or the Ubuntu package went in, neither the footer nor the stop's own words say nothing changed, and the stop ends with Ask again or the commands instead.
The Ubuntu package's install asks for that account's password with the install question, as Settings' add does; the `infinitary` account made after a root sign-in has no password, so a password question there stops as the key not taken.
After it started, connecting is always tried, and Ask again tries it again; when it fails, a computer with no private-network address, a firewall that may keep it out, or a port that did not answer says so, with the one command to run there where there is one; a Linux account that does not linger shows the administrator's `loginctl enable-linger` line with its Copy.
Cancel stops at the next step: before step 5 the copy sent is deleted and nothing was started there; pressed during step 5 or after it, the first mate keeps running there, the stop says so without connecting, and Ask again connects to it.
Once an account was made or the package went in at that address, no later stop there says nothing changed until Continue asks a new address.
Leaving the screen while a step runs cancels the same way.
Every control is a button or field in tab order; the key line's question puts focus on Cancel, so Enter never says yes to a key unread, and each other question and stop puts it on its first button.

## The Diagnostics notice

A release build (one with a diagnostics destination) also shows, under the input, the disclosure the captain asked for on 2026-09-22: anonymous usage events with a random install ID, reset when Diagnostics is turned off and on, never what the person types - with "Turn off" beside "OK".
It is independent of the gate - it shows whether or not a model is connected - and it stays until its answer is saved; every event waits for it.
A refused Turn off or OK keeps the reason and last saved Diagnostics state beside the choices (`docs/sharing.md`).
The input reserves the notice's full height, and the gate stays above it in a scrolling band, including when refusal feedback needs more room.
The first-run steps themselves (the gate shown, the first sign-in, the first turn, the first crewmate's start, report and close) are Diagnostics' `ftue_*` events, each sent once per install.
`docs/sharing.md` is its home.

## The welcome

The approved immediate-welcome specification (FI3-314, 2026-09-30) replaces the earlier live-authorship decision: the host presents fixed copy as a first-mate-owned informational note, without a model request.
The captain selected **compact orientation** and **skip a late, uncreated welcome if the first accepted ask wins**.
The captain's redesign of 2026-10-06 (FI3-1164, direction C, the interactive presentation) replaced its copy and drawing, after a new person found the old tiles looked pressable and the next step unclear.
This one introductory note is explicitly allowed to suggest a starter without footer actions; other cards retain the normal action rule.

The note is titled “How we work”, and everything in it is app copy in `src/shared/welcome.ts`, never a model's.
Its body is a picture of the window, 520 by 212 units drawn at its pixel width, that shows one part per press, each with its words inside the picture beside the thing it names; no sentence sits above or below the picture.

1. At rest: the first mate, large in the middle over the lit message box, and under the box “Type what you want done in the message box under this card.”
2. A card rises over the first mate carrying “I bring back answers and choices as cards like this one.”, while the first mate fades behind it in the same pass, as the window hides the character while a card is up.
3. Activity appears on the left with its label and report rows, a crewmate (a small tetrahedron) beside the card's top corner with a dashed leader into Activity, and the column reads “Crewmates do the work in the background and report here.”
   The crewmate beside the card is a teaching liberty: the real window hides the crew while a card is up.
4. Tasks appears on the right with its label and rows and reads “Every ask gets a record here.”
5. The words under the box change to “That is all of it.
   To begin, press a starter below.”

One element is lit at a time, in `--accent`: the box, the card, the crewmate, the first task row, then the box again.
Under the picture are only its controls: five dots and a mono count (“1 / 5”), then Back and Next.
Next moves one pass of `--dur-med`, which reduced motion zeroes to a cut; Back is always a cut; Back at the first chapter and Next at the last are dimmed and do nothing.
Back and Next are buttons Tab reaches and Enter or Space presses; nothing about them is a command, because nobody repeats them.
The presentation is the figure's own script, inside the `<figure>`, with styles as attributes and no style sheet, so the body stays prose (`docs/card-authoring.md` "Scripting") and takes the mount path any scripted card does.
Without the script the card reads whole: the full picture with every part and its words, the card over the first mate, and no controls, so nothing on it looks pressable that is not.

The first mate and the crewmate in the picture are the real ones, smaller (INF-5609, the captain's “render the same real animations we use in the center animation area”): the app's own stage part (`docs/card-authoring.md`, "The app's own stage") draws them with the center's painters, the first mate 176 units wide, fading behind the picture's card as the still did, and the crewmate live from chapter 3.
Their motion is calm: the first mate drifts and blinks, with no greeting, fidget or turn toward the pointer.
A reader without the part, such as an older phone, shows the still drawings in their place: the tesseract projected the way the character draws itself, with its two soft-light eyes, and the crewmate's tetrahedron.

Below the picture, always: “To begin, press one and finish the sentence:” and three starters - Clone a project, Start a new project, Work in a folder on my computer.
A press of Clone a project or Start a new project puts “Clone the project at ” or “Start a new project called ” in the message box under the card, with the caret after the words and focus in the box, through the store's `beginDraft` as the create-your-own-panel slot does: words already typed stay after them, and another starter's words replace the first one's while the box still starts with them.
A press of Work in a folder on my computer, in a window on the first mate's own computer, opens the system's folder picker (`inf:app:choose-folder`) and adds the chosen folder as a project as Settings -> Projects does (`inf:repos:setup` with `adopt`; `pickProjectFolder`, `src/renderer/src/app/projectFolder.ts`).
Cancel changes nothing.
Once the folder is added, a quiet line under the card's title names the project and says to type what the captain wants done with it in the message box, and focus goes to the box; a folder already on the list is named the same way, and a plain folder's line says git was started in it.
A refusal, such as a folder inside the app's own projects folder, shows on the card's error line.
A view (`docs/view.md`) keeps the starter's words instead, since the picker would show the wrong computer's folders: its press puts “Work in the folder ” in the message box like the other two.
The frame sends the window only a starter's words, so the window knows the folder starter by the app's own words in the welcome's body (`isWelcomeFolderStarter`, `src/shared/welcome.ts`).
A press sends nothing and leaves the welcome up, and while the box is held - a recording, the dictation key's pick, the first-launch gate - it does nothing (`mainMessageRefusal`).
A starter is a `data-inf-draft` button, the frame bridge's own message for a body that starts the captain's message, which the window takes only from the card on screen whose frame holds its focus, as a link opens only then (`docs/card-authoring.md` "Style").
A press of a starter, Next or Back is not the first turn.

The note has an ordinary close, normal priority, no footer buttons, no provider personalization, and no reply row: the captain asked for none on this card, since the message box under it is where to type (`docs/card-threads.md` "A card with no reply row").
It is a regular card, the width its picture was drawn for, which the host sets when it presents the note.
It teaches default positions, never opens panels or overrides the captain's choices.
Sending a message does not close it; if that message starts the first crewmate, the welcome steps aside for the first crewmate's note (“The first crewmate's note” below).
From its creation on a new profile, the Tasks panel shows collapsed on the right, since the welcome's own record is an ask's record (`onRail`, `src/panels/now/rows.ts`), so “Every ask gets a record here.” points at something real.
On a first installation no What's new card follows it: the welcome is the only card, and the version is recorded quietly as the baseline once the welcome is settled (`docs/release-notes.md` "A first installation").

### Eligibility, commit and publication

Migration 58 distinguishes new app-data profiles from older installations.
Only a new profile initially needing a model persists `pending`.
Legacy profiles (even without a welcome stamp), fresh preconfigured starts, and prior captain activity, tasks, cards or user-registered projects are terminally `skipped`; the built-in personal workspace is not prior activity, and neither is an `operation` row (`hasPriorActivity` in `src/core/firstRun.ts`): the settled trail of an app change - during setup, the captain's own Settings changes (connecting, resuming, a crew slot, the first mate's model), which are how a new profile gets ready - or a host card's gate row, whose card already counts.
The delivery record is durable; the gate itself remains derived.

Pending reconciliation runs at boot, on readiness reads and account, serving/catalog, quota/liveness and local-seat changes.
The actual pinned model, or the normal initial automatic selection, must be available on the selected serving binding, with the required client and no known pause.
A pause-only closed gate does not qualify.
Unknown allowance is not zero; there is no paid health probe and no guarantee that the next request will succeed.
A supported local seat qualifies only an already pending setup.

`CardService.addRecordedFirstmateNote` uses `TaskService.atomic` to commit the first-mate-owned note, an ordinary completed standalone question/answer record, its identity and `consumed` state together through the existing writers.
Task change listeners and the card broadcast run after commit.
The note is published before normal fresh readiness, without waiting for inference, wake grouping, caption fade or a quiet period.
New arrival keeps another shown card in place and unread rules, focus, drafts, voice and notifications unchanged.
No active task, crewmate or project work starts.

### Recovery and first input

Before commit, a write failure rolls everything back and leaves pending for the next reconciliation or boot; otherwise usable input is not held.
After commit, restart restores the same card and thread.
Dismissal, cleanup, copy changes, upgrade and reconnection never clear consumption or reissue it.
`welcomedAt` means committed creation for new notes, not viewing; old values remain compatible and still mean scheduling.
`welcomeCardId` retains identity after cleanup.
This is at most one automatic creation per app-data profile, not proof of reading.
Reset app data deliberately to start anew; release and development profiles stay separate.

Captain-turn acceptance and welcome creation run synchronously before session work can yield.
An accepted ask first terminally skips a pending introduction; a committed note first stays available.
Never delay, rewrite or co-batch an ask for the welcome.
Main-input and first-mate-thread turns stamp `firstTurnAt`; both end the existing introductory hint, and since the welcome takes no reply, on a new profile that is a message sent from the box.
The first mate's next context carries the committed introduction's identity and recorded answer, without a composition wake.
The recorded answer is the welcome in words (`WELCOME_ANSWER`): its chapters' words and its starters, never the picture and script, which would cost every turn.
Reconciliation never overwrites authored changes.
Obsolete typed welcome inbox requests are retired before draining; unrelated work and legacy cards remain intact.

The input's hint follows the record: the gated line while the gate is up; “give your first mate a task, or press/hold right ⌥ to talk” from creation until the captain's first accepted turn; then the standard hint.
`src/shared/firstRun.ts` is the one home of the unchanged strings and hint rule.

## The first turn

A new user who asks something for the first time sees the character spin and run hot, which reads as activity only once you know it.
So the first turn shows what every turn shows: the captain's message above the input, and under it the first mate's line with its spinning ember mark and "Working…" until its reply takes their place (`docs/composer.md` "The last turn").
Nothing is written above the character.

## The crewmate's state words

The captain's call of 2026-10-01 (task FI3-436, on a reviewed plan): ember and cyan mean working and idle, but nothing said so until a person pointed at a crewmate.
So for someone new, the first crewmate on the home stage carries its state in a word directly under it - "Working" while it is ember, "Idle" once it is cyan - and each word is taught once per profile.
No tour, legend, setting or dismiss control; colors, motion, the hover summary, the Tasks dots and the welcome note do not change.

`src/renderer/src/character/crew/stateWords.ts` is the pure, time-injected rule (like the character machine); `CrewOrbit` reads the painted frames on a 200 ms clock of its own (so it works while reduced motion holds one still frame, and its seconds are real seconds whatever the stage rate) and draws the one word on the anchors the model names use, 4 px under the solid: `--text-xs`, `--fg-2`, never the state's color.

- **When a word appears.**
  Only on a crewmate settled on its orbit (frame phase `orbiting`, never spawning or leaving) whose working blend has settled, after it has held that state for 1 s.
  The earliest crewmate in the state carries it.
  It hides while that crewmate's summary is open.
- **When it counts.**
  Only when shown in full: 6 s at full strength (fade in `--dur-med`, out `--dur-slow`) with the stage visible - the home view, no card over it, the window not hidden.
  Any interruption (the crewmate closes or leaves, its color changes, a card opens, the summary opens on it, the window is hidden or the clock stalls) cancels the showing, writes nothing, and the word is offered again on the next crewmate that qualifies.
  A crewmate idle for an instant before it is closed shows nothing and teaches nothing.
  The two words are independent.
- **Record.**
  `workingWordAt` and `idleWordAt` join `firstTurnAt` in the first-run record (`src/shared/firstRun.ts`), written through the core (`inf:app:first-run:crew-word`, `FirstRunService.noteCrewWord`) only when a showing completes, never overwritten.
  The first read of the record marks both as taught when the profile already has crew history (a `work` task on the board), so the decision is made at boot, before a new profile's first crewmate exists; an absent value reads as taught on the stage.
- **Reduced motion.**
  The fade is opacity alone over `--dur-fade`; with no blend to wait for, state alone settles a crewmate.

`stateWords.test.ts` pins the rule on a fake clock (an idle of a few frames before leaving, showings cut short by a card, a color change, a departure, the summary and a stalled clock, and one full showing); `firstRun.test.ts` the record.

## The first crewmate's note

The captain's call of 2026-11-20 (task INF-5532, on a reviewed plan): the moment the first mate hands an ask to a crewmate is where the app differs most from a chat, and nothing said what was happening.
So when a new person's first crewmate starts, the app shows one note, once per profile, titled “A crewmate is on it”.
Everything in it is app copy in `src/shared/firstCrewmateNote.ts`, never a model's, and no model is asked.

The body says the ask went to a crewmate that works in the background and can take a while, then draws two panels side by side: Now, “A crewmate works” and “No need to watch it”, beside the crewmate's tetrahedron in ember; Later, “A card comes back here” and “An answer or a choice”, beside a card in `--accent`.
Under them it says that an answer or a choice comes back as a card like this one and that cards are the only part that needs the person, and that the card can be put away while the work goes on.
The panels are boxes of text that wrap, not a drawing, so every language fits; on a narrow card the second panel moves under the first.
Between the first sentence and the panels, a send-off stage 180 px wide shows the real first mate sending a crewmate off into its orbit, as the center does when a crewmate starts, and Now's crewmate is the real one, 40 px, working (INF-5609).
Both are the app's own stage part (`docs/card-authoring.md`, "The app's own stage"), in the calm motion the welcome uses; a reader without the part shows no stage and Now's still tetrahedron.
Every run of words is a saved fact (`saidMark`) and the title's fact rides `cardWordsMark` (docs/i18n.md, "Saved facts"), so the window and the phone word the note in their own language when they draw it.
Its record keeps the note's sentences in English as its answer, without the panels.

It is a first-mate note like the welcome: committed with its completed answer through `CardService.addRecordedFirstmateNote`, no reply row, the regular width, and one button, Got it, on Command-1.
It promises no system notification, and follows the standing notification rule like any note.

- **When.**
  On the first `task_started` the app broadcasts, of any kind of work, after the event reached every window (`createEventSeam`'s `attachFirstLaunch`, `FirstRunService.noteCrewmateStarted`).
- **Who.**
  Only a profile whose welcome was committed (`welcomeState` `consumed`) and that never started a crewmate.
  The first read of the record decides `firstCrewmateAt` with the crewmate state words: a profile that already has crew history is stamped as past it, so people already using Infinitary never see the note; a profile without the welcome gets its first start stamped and no note.
- **Once.**
  `firstCrewmateAt` and `firstCrewmateNoteId` join the first-run record (`src/shared/firstRun.ts`), written in the same commit as the note.
  Putting it away, a restart, an update and reconnection never show it again; a failed commit leaves the stamp unwritten, so the next start tries again.
- **The welcome steps aside.**
  If the welcome is still open at that moment, the app takes it down (resolution `first-crewmate-started`) before the note goes up, so there is one card at a time and the crewmate's first card later arrives on an open stage rather than behind the welcome (the captain's “replace”).
  Someone partway through the welcome's pages loses their place.
- **Other cards.**
  No new rule for the stage: if another card is shown, the note waits as new like any note.

`firstRun.test.ts` pins the record's rule, and `tests/e2e/first-crewmate-note.spec.ts` walks a new profile from the gate through the note, its Got it by key, the working crewmate, its first card and a second crewmate after a restart with no second note.
A journey that signs a new profile in through the gate and starts a crewmate puts the note away with `putAwayFirstCrewmateNote` (`tests/e2e/firstLaunch.ts`).

## The create-your-own-panel slot

The captain's calls of 2026-10-06 (FI3-1124, on a reviewed plan) and 2026-10-12: once someone's crewmates have finished three tasks, an empty slot at the top of the left rail teaches that they can make a panel of their own, and one click starts the ask.

- **What it is.**
  An empty outline a panel wide and 88 px tall, above Activity, with a plus over "Create your own panel" and "Tell your first mate what this should show", and a small Hide in its corner.
  It is the app's own chrome, not a panel: no title row, chevron or attribution, no rail slot, no manifest (`src/renderer/src/plugins/CreatePanelSlot.tsx`; its look is the design skill's `components/panel/Panel.prompt.md`).
  It docks the left rail as a panel does, and reserves card room as an expanded panel does, so a wide card never covers it.
- **When it shows.**
  While four typed facts hold (`showsCreatePanelSlot`, `src/shared/createPanelSlot.ts`): three of the captain's crewmates have finished their tasks, their panels are on, no panel of their own exists, and they have not hidden it.
  An installed panel, by someone else, is not one of their own.
- **A finished crewmate.**
  Work a crewmate started that closed done, whether merged, landed, answered on its card or built in place (`TaskService.finishedCrewmates`, read through `crewFacts` in `src/core/firstRun.ts`).
  A question or decision the first mate answered itself had no crewmate, work closed done before a crewmate started it was nobody's, and dropped work did not finish, so none of them counts; neither does a host note (the welcome, a release's note) or an `operation` row, the trail of an app change.
  `thirdCrewmateDoneAt` joins the first-run record, written once at the first read that finds three and never cleared, so a profile that already has three sees the slot at its next launch.
  A record an earlier version wrote, holding only `firstTaskDoneAt`, shows no slot until the third crewmate finishes.
  The window reads the record again when a task closes done (`task_changed`), so the slot comes without a relaunch.
  `firstTaskDoneAt`, the first task of the captain's that closed done (`TaskService.hasFinishedTask`), is still written for a view on an older version, which shows the slot from it.
  Each crew fact is one seeking read of the task record, never a list of every task: a record that lacks them decides them at boot, before the window opens (INF-2338).
- **The click.**
  The message box starts with "Make me a panel that shows " and the caret after it, focus in the field, through the store's `beginDraft`: words already typed stay after the prefix, and a second click changes no words.
  While the box is held - a recording, the dictation key's pick, the first-launch gate - the click is refused, as Go to the main message is (`mainMessageRefusal`).
  The finished sentence is an ordinary message; the first mate already sends a new panel for the rails to a crewmate on the personal workspace.
- **Where the panel lands.**
  A panel that names no place lands at the top of the left rail (`DEFAULT_PERSONAL_PLACEMENT`), where the slot was.
- **How it leaves.**
  As the first panel of the captain's own appears, and it returns if every one of them is removed.
  For good on its Hide, or on "hide it" to the first mate: both write `hiddenPanels` under its surface id `create-panel`, with one feed line and no card, and "show it again" brings it back.
  The slot is listed among the captain's surfaces, left rail, top; `app_change panel` hides or shows it, never moves it, and it takes none of a rail's panels.
  With the panels off it goes with them.
- **The keyboard.**
  Tab reaches it and then its Hide, F6 lands on it as the left rail's first part, and Enter or Space clicks it (`docs/keyboard.md`); it is not a command, because nobody repeats it.

`createPanelSlot.test.ts` pins the rule, `createPanelSlotStore.test.ts` the click and the Hide, `firstRun.test.ts` the first finished task an older view reads, `core.projects.test.ts` "hide it", and `tests/e2e/create-panel-slot.spec.ts` the journey, from the third finished crewmate on.

## What is deliberately not here

- No first-run flag, no tour of the window, no coach marks on it, no pre-seeded sample task; the welcome's presentation stays inside its own card, and the first crewmate's note inside its own.
- One surface teaches personalize, the create-your-own-panel slot above; there is no paragraph in the welcome, no reactive tip and no copy branch on the "Your panels" row.
- The input while gated does not park a typed turn; the captain chose the disabled input.
  `parkedCaptainTurn` stays what it was, the benched- flagship rung's.

## Sign-in and quota behavior

- The auth card ("A provider needs sign in") opens the Intelligence tab (effect target `subscriptions`), not General one click short of it.
  Its body names the provider the first mate could not reach and says to sign in again, or names a custom connection and says to press Edit and then Save in Settings → Intelligence to check it again (`FirstmateSeat.signInCardBody`).
  With no provider to name, it lists the ones that can serve the first mate: Codex, Grok, Claude, Kimi Code or Copilot, OpenRouter with an API key, or Amazon Bedrock with your AWS sign-in.
  It never quotes the failure: Pi's own text names its terminal sign-in and paths into the app's files, so the raw text stays on the turn's records.
- A failed session create (no model, a broken store) ends the ask the turn opened, as a failed question task, instead of stranding it until the next boot files it.
- The Intelligence tab's "as of · Refresh" header meta renders only once a quota snapshot has providers; an empty tab says nothing about when.

## Account model catalogs

Every account runtime now reads the app-scoped `models.json` (`PiAccountBackend` option `modelsPath`), keeping its own pi.dev overlay store beside its auth file (`ModelRuntimeOptions.modelsStorePath`).
A custom provider or a per-provider override in that file therefore serves an account exactly as it serves the base runtime.
It is what lets `tests/e2e/first-launch.spec.ts` connect a real, key-signed provider through the gate's own chip and still send every turn to the mock server: the file points OpenRouter at the mock and defines no custom provider, so the base runtime serves nothing and the gate is up until the key lands.

## Custom API connections

Custom API shares the Intelligence connection aside.
Paused save, checked-but-unselected save and crew-only placement keep the gate closed to work; only an enabled, checked custom model explicitly chosen for the first mate makes it ready.
Readiness remains derived from existing account/model settings, not a separate flag.
See `custom-api.md`.
