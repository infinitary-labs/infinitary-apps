# Infinitary on iPhone and iPad

The native SwiftUI shell uses the shared dark and light colors, Space Grotesk for words and JetBrains Mono for data.
Native controls keep Dynamic Type, VoiceOver, hardware-keyboard focus and platform-sized touch targets of at least 44 points.
The screen is opaque, with the shared void background, raised cards, hairlines and one ice-cyan selection.
Native colors, spacing and radii are generated from the shared tokens; cards use the card radius and Nearby buttons the control radius.
The launch screen is the shared void in each appearance, so the first frame is already the app's own surface, never pure white or black.
Every sheet title is inline in Space Grotesk at the headline size, as the joined computer's name is, never the system's large bold title.
The paste and computer sheets sit on the panel color with a hairline at their edge.
A plain field, such as the task search, a crewmate message or a computer's link, is the app's field: the panel fill, a hairline and the control radius.
A card's reply row is shaped like the message capsule: one shape with the send arrow inside at its right edge, dimmed until there is text, on the field's fill and hairline.
That shape is the Mac's input, a pill at one line and a rounded rectangle with the same 22-point radius when it grows.
The app follows the device's appearance; it never presents message bubbles.

## Joining and the computer

At first launch, the native first mate sits above the centered caption “Infinitary is on another computer”.
One sentence explains that tasks and conversation stay on the computer.
Nearby is a bordered list of computers announcing Infinitary, with a status dot and scanner icon on each row; a press opens the scanner, never trusts the announcement.
Scan the code is primary and Paste its link secondary, full-width controls below the list.
An alert names the computer address reached through the link, with Cancel beside Join, before the phone starts showing it; the authenticated computer name is not known before joining.
The scanner's title is Scan the code, the words of the button that opens it.
A permission refusal says how to allow the camera or local network, without replacing a refused camera with an automatic clipboard read.

Once joined, the native navigation title is the computer's name, with its reach line below it.
Out of reach shows the last-heard time, a quiet explanation above the content and only the current in-memory view; changes are unavailable until it returns.
The top-right computer button opens a native sheet with the computer's name and reach, this device and its current capability, and the fact that appearance follows the device.
The sheet shows a joining time only if the saved connection supplies one; it never invents one for an older record.
Leave sits at the foot under a hairline, with an alert that keeps Keep it beside Leave and explains that a new link is needed to return.
Out of reach, Forget this computer replaces Leave, asking in the same kind of alert before clearing only the local saved computer and explaining that the computer may still list this device.
Removed clears the computer's data from this device and explains that a new link is needed.
A protected-data read failure explains why joining cannot proceed and offers another attempt after unlocking.
A damaged saved connection clears only the saved computer, keeps this device's identity and explains that a fresh link can join again; it never asks the person to unlock for a decoding error.

## Stage and rails

The compact shell uses iOS's own Cards and Activity tabs, tinted with the shared accent and Lucide outline template images.
Tasks joins those tabs when the task reader is present, never as an inert placeholder.
Landscape iPad uses two columns: collapsible Activity and, when present, Tasks panels in the sidebar, with the stage alongside at up to 560 points.
Portrait and narrow multitasking return to one column with tabs; the tablet's width and height decide the layout, not its physical orientation alone.
Activity is newest first on both devices, following the captain's submitted answer over the plan's bottom-up sidebar sentence.
A row has a semantic kind dot, the computer-authored words, an optional task key in micro mono inline before them, and a relative mono age.
The exact local date and time remains available to VoiceOver; an empty Activity says “No activity yet”.

Cards shows one card at a time, with a peek of the next card at its right edge and a quiet pager below it: two chevrons around the count; an ordinary arrival never replaces the card being read.
The count opens a menu of the current titles, then Past cards; the next chevron carries a dot while an unread card lies ahead.
The Cards tab carries the native badge with the count of cards not yet read.
The peek stays within the shorter of the foreground card and its scrolling viewport, never filling the empty space beneath a short card or reaching the pager.
Swiping the native card head changes cards without intercepting the body's own sliders, canvases or pinch gestures.
The card stage fits the shell's available column, up to 560 logical points, and owns neither navigation nor the computer-details sheet.
The kind chip, attribution, title, close control, footer buttons and reply field are native controls outside the body’s web view.
The native controls inherit the shell's tint and retain platform focus and touch behavior.
A review-finding card shows Review finding in the warning color above its title, and the builder’s task name in its attribution.
The default choice uses a prominent native button with the dark void's ink on the accent in either appearance, as the approved card does.
The body uses the Mac’s card stylesheet and fonts, fits the available width and permits pinch zoom; its pictures open a separate viewer and its recordings offer playback there.
Named form answers and reply drafts stay in memory while paging; choosing a form value sends nothing, and a footer press collects the current answers.
Required questions hold the default choice, and a failure keeps the draft with an explanation.
A failed body with a saved reading says that choices use the last saved answers and offers Retry; a timeout on a press never sends that choice.
The thread opens below the card, with plain messages and their submitted answers, never message bubbles.
Past cards show their last-seen body, submitted answers and chosen button, with Hide instead of Close and no reply field or working actions.
A Settings or browser door says to do it on the named computer and keeps the card open.
Using a saved sign-in is a normal choice sent to that computer, not a request to open its browser here.
While out of reach, the shown body remains readable, actions and replies are unavailable, and no change waits to be sent later.
A stalled body leaves the native card controls usable and offers Retry in its place.
An empty stage shows the native first mate; a crew count appears only when the connection supplies it.
The native character moves as the Mac's does: idle drifts slowly with eyes that blink and wander, listening breathes as two counter-rotating hexagons, and working speeds up with the ember, shimmer and halo.
It greets once when the app opens or joins a computer, and nods when the first mate's reply carries a nod; it plays no other emote.
Every state stops its timeline off-screen or in the background and shows a still pose under Reduce Motion.
The join stage uses idle; the empty stage shows working only when the Mac's published `firstmate_state.busy` says a conversational turn is running, and returns to idle when it finishes.
A stopped or lost connection clears that reading; until a new busy event arrives, the character stays idle because the connection has no initial busy snapshot.
Listening remains a drawing capability, not a live phone state: native keyboard dictation supplies no public listening signal, and focus, typing, tasks and connection traffic never stand in for one.

The conversation owner puts the message box at the foot on every tab, with the last turn's two lines above it.
One capsule floats alone above the measured native tabs and grows with the message, photos, last turn and problems; no panel sits behind it.
On iOS 26 the capsule is native glass over the system's soft scroll edge; on iOS 18 it is the field's fill and hairline, with the page color fading in behind it.
The fixed-height system tab accessory is not used for multi-line content.
In the landscape sidebar layout it sits at the stage's foot.
The message box stays mounted once, so its own text and photo drafts survive changing tabs or rotating; no tab or orientation branch owns another copy.
On an iPhone in compact-height landscape, the last-turn excerpts sit side by side above a row containing the removable photo strip and the message capsule.
The field shows at most two lines there and keeps its full text; the 44-point controls and complete warning rows remain visible above the native tabs.
Portrait and iPad retain the stacked layout; a landscape card must show its full heading and have enough scrollable height to read body text and use its actions.
Dictation is the keyboard's own.
While the keyboard is open, a native Done button occupies the leading navigation slot and supports Shift-Command-K without sending or clearing the draft.
Its command belongs to the persistent navigation bar, not the keyboard's transient accessory view.
Tasks uses the desktop's five groups, search, status/key/title/project rows and records with their actions at the foot.

## On the computer

On the computer, + A phone opens the existing link panel with a locally encoded scan code, a Copy link alternative and Stop it.
The code has a white quiet margin in both themes because the phone's camera must read it.
The panel says the phone app comes from TestFlight for now, only to people asked to test it, so it implies neither App Store availability nor that anyone can install it.

## Talk and tasks

The joined screen keeps the message box at its foot above the system tabs, with the last captain turn and the first mate’s reply immediately above it.
The last turn is two bare centred lines, one each, with no border, fill or padding: the captain's words in the secondary ink, the reply in the primary ink, each inside quotation marks in the muted ink.
The message field, Photos and Send sit inside the one capsule, Send at its right edge and dimmed until there is something to send.
The native multiline field takes the keyboard’s dictation; there is no second microphone or speech engine.
Photos opens the system library picker, and selected photos appear as removable thumbnail chips above the field.
Send submits words and photos once; a refusal keeps the draft and says why, and an unconfirmed send asks the person to check the Mac before sending again.
Out of reach and a read-only connection retain the view but refuse every change, without sending it later.
The Tasks tab follows the desktop’s five groups: Waiting on you, Working, Queued, Backlog and Done, with search across its current list and earlier tasks.
Each group header is a micro uppercase tracked label with its count, as on the Mac.
The first three groups start expanded; Backlog and Done start collapsed, with their counts and disclosure chevrons.
A row is one line: status mark, mono key, title, then the project in mono; dividers start past the mark, and active parent trees stay together.
The search waits above the list until it is pulled down from the top; Shift-Command-F opens it, and VoiceOver always shows it.
A task opens its record in the same column: goal, captain’s words, progress, outcome and timeline, plus a Crewmate section for the session and its direct message box.
The timeline's events sit on a hairline rail in caption size, with each time right-aligned.
The record's heading is the task's own title, with its key in mono at the start of the line below; the bar above it carries no key.
Start and Continue follow the Mac’s own allowed moves; Steer sends to that crewmate, and Interrupt stops only its current turn.
The actions sit at the record's foot like a card's footer: Start or Continue full width with the accent fill, Interrupt bordered beside it, and above them a capsule message box whose arrow is Steer.
A closed task remains readable without a message box or actions.
New cards and answered replies announce themselves while the phone is open, following the Mac’s Notifications switch.
The notice is a quiet pill under the title on every tab: a mono New card or Reply label in the accent, then the card's title, on the raised surface with a hairline.
A tap opens the card on the Cards tab and a swipe dismisses it; a reply notice leaves after a few seconds, a new-card notice when its card is read, and VoiceOver offers Dismiss.
No notice requests background delivery, and an initial snapshot does not announce old cards.
