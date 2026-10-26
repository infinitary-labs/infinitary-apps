# Infinitary on iPhone and iPad

The native SwiftUI shell uses the shared dark and light colors, Space Grotesk for words and JetBrains Mono for data.
Native controls keep Dynamic Type, VoiceOver, hardware-keyboard focus and platform-sized touch targets of at least 44 points.
The screen is opaque, with the shared void background, raised cards, hairlines and one ice-cyan selection.
Native colors, spacing and radii are generated from the shared tokens; cards use the card radius and fields the control radius.
The launch screen is the shared void in each appearance, so the first frame is already the app's own surface, never pure white or black.
Every sheet title is inline in Space Grotesk at the headline size, never the system's large bold title.
The paste, Settings and computer sheets sit on the panel color with a hairline at their edge.
A plain field, such as the task search, a crewmate message or a computer's link, is the app's field: the panel fill, a hairline and the control radius.
A card's reply row is shaped like the message capsule: one shape with the send arrow inside at its right edge, dimmed until there is text, on the field's fill and hairline.
That shape is the Mac's input, a pill at one line and a rounded rectangle with the same 22-point radius when it grows.
The app follows the device's appearance; it never presents message bubbles.
One soft tap of haptic feedback confirms that the computer accepted something: a message, a card's answer or reply, a task's start, continue, interrupt or steer, and the computer coming back after it was out of reach.
Nothing else taps, not a page turn, an arrival or the ordinary reconnection when the app opens.

## Joining and the computer

At first launch, the native first mate greets once above the centered headline “Welcome aboard Infinitary”, in the words of the Mac's own first launch.
One line follows: “Your first mate lives on your Mac.
Join it to read your cards and Activity here.”
Nearby is one plain line under it, with no box: the way to find a computer, or each computer announcing Infinitary as a status dot, its name and Scan its code; a press opens the scanner, never trusts the announcement.
Scan the code is the one prominent full-width control, and Paste its link a plain secondary below it with no fill.
Join by its address is a second plain secondary under Paste its link, for a computer away from this network.
It opens a sheet titled Join by its address: one callout line saying to type the account and computer as when signing in to it, with Remote Login or SSH on, a field with the placeholder `kun@studio`, an optional Port (22) field and a prominent Continue.
While the phone signs in, the sheet shows only “Signing in to <computer>…” with a native progress indicator.
The first sign-in asks once in the same sheet: the heading “Is this <computer>?”, one line, the fingerprint in the data face on the field's surface, a caption that the phone asks once and stops if the fingerprint changes, a prominent Trust <computer> and a plain Not this one.
When the computer has not let this phone's key in, the sheet says so in one callout line; where it takes a password, a secure field “Your password on <computer>” and a prominent Sign in once come first, then a caption offering the key instead.
The phone's public key line follows in the micro face on the field's surface, with the plain secondaries Copy this phone's key (Copied once pressed) and Try again.
A refusal is one callout line in the warning color at the sheet's foot, in plain words; the link the computer answers is never shown, and the sheet closes as the phone joins.
An alert names the computer address reached through the link, with Cancel beside Join, before the phone starts showing it; the authenticated computer name is not known before joining.
The scanner's title is Scan the code, the words of the button that opens it.
A permission refusal says how to allow the camera or local network, without replacing a refused camera with an automatic clipboard read.

Once joined, the top bar is one row: a Settings button at the left, the Home, Tasks and Activity strip in the middle and the computer button at the right; the computer's name is in its sheet, not the bar.
The strip is words only, the current tab lit in the accent on a quiet lens, with a dot beside Home while a card is unread; on iOS 26 the bar sets it on glass, and on iOS 18 it takes the field's fill and hairline.
The computer button is the Lucide computer glyph with a reach dot at its corner, the accent in reach and the warning color otherwise; VoiceOver hears the reach as its value.
In reach the bar says nothing more.
Out of reach is said once, by one line under the bar on every tab with its dot, state and last-heard time; no strip above the content or line on a card repeats it, and only the current in-memory view remains.
The message capsule and a card's reply row dim, and one line under the message box says only “Changes are off until <computer> is back.”, as the Mac says it.
The computer button opens a native sheet with the computer's name, its reach and its address.
The Settings button, the Lucide gear, opens this phone's own sheet: this device and its current capability, the fact that appearance follows the device, and the app's version.
Command-1, Command-2 and Command-3 switch tabs, Command-Comma opens Settings and Command-I the computer.
The sheet shows a joining time only if the saved connection supplies one; it never invents one for an older record.
Leave sits at the foot under a hairline, with an alert that keeps Keep it beside Leave and explains that a new link is needed to return.
Out of reach, Forget this computer replaces Leave, asking in the same kind of alert before clearing only the local saved computer and explaining that the computer may still list this device.
Removed clears the computer's data from this device and takes the first screen's shape: the first mate above “Removed from your computer”, a line saying a new link is needed, and one prominent Join again.
A protected-data read failure explains why joining cannot proceed and offers another attempt after unlocking.
A damaged saved connection clears only the saved computer, keeps this device's identity and explains that a fresh link can join again; it never asks the person to unlock for a decoding error.

## Stage and rails

The compact shell switches between Home, Tasks and Activity with the strip in the top bar; there is no bottom tab bar.
Tasks joins the strip when the task reader is present, never as an inert placeholder.
Landscape iPad uses two columns: a sidebar with Activity and, when present, Tasks as a segmented pair at its top, each scrolling alone, with the stage alongside at up to 560 points, and no strip in the bar.
Portrait and narrow multitasking return to one column with the strip; the tablet's width and height decide the layout, not its physical orientation alone.
On any width the card with its pager, the message box, Tasks and Activity share one centred reading column of 560 points with its gutters, so the message box lines up with the card.
Activity is newest first on both devices, following the captain's submitted answer over the plan's bottom-up sidebar sentence.
A row has a semantic kind dot, the computer-authored words, an optional task key in micro mono inline before them, and a relative mono age.
The exact local date and time remains available to VoiceOver; an empty Activity says “No activity yet”.

Home shows one card at a time, with a peek of the next card at its right edge and a quiet pager below it: two chevrons around the count; an ordinary arrival never replaces the card being read.
The count opens a menu of the current titles, then Past cards; the next chevron carries a dot while an unread card lies ahead.
With no card to page the chevrons and count hide; a lone Past cards menu stays while there are past cards, and nothing shows when there are none.
Home carries a dot in the strip while a card is not yet read, and VoiceOver hears the count.
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
While out of reach, the shown body remains readable, actions and the dimmed reply row are unavailable, and no change waits to be sent later.
A stalled body leaves the native card controls usable and offers Retry in its place.
An empty stage shows the native first mate and the desktop's crew formations, home at full size and other computers at half, panned continuously rather than paged or shrunk to fit.
The orbits are drawn a little smaller than the desktop's, so eight crewmates fit the narrowest iPhone held upright; glyphs keep their size.
Crew ride the desktop's growing two-orbit ring with no orbit outlines (`components/mate/Crewmate.prompt.md`).
Crew retain their published tier, work posture and computer; programs show their live parts and dependency branches, and an unreachable computer shows frozen, unknown activity.
A crewmate opens a native preview of its work, with Open task leading to the existing task record.
Shift-Command-C, Browse crew, starts browsing, drawing an accent outline around its viewport; arrow keys pan it, Tab selects and reveals a crewmate, and Space opens that crewmate's preview.
The selected crewmate has an accent outline and a selected accessibility value; Escape, editing, a preview or leaving Home ends browsing.
The native character moves as the Mac's does: idle drifts slowly with eyes that blink and wander, listening breathes as two counter-rotating hexagons, and working speeds up with the ember, shimmer and halo.
It greets once when the app opens or joins a computer, plays the Mac's full reaction and fidget repertoire, and holds a reply reaction until the real conversational turn finishes.
Animation follows permitted display callbacks, requesting up to 120 frames a second, without claiming that a device delivers that rate.
Every state stops its clock off-screen or in the background and shows a settled still pose under Reduce Motion.
The join stage uses idle; the empty stage shows working only from the Mac's published conversation busy snapshot or numbered busy event, and returns to idle when that turn finishes.
A stopped or lost connection clears that reading; an older home without the scene-observation capability stays unknown until a real busy event arrives.
Listening remains a drawing capability, not a live phone state: native keyboard dictation supplies no public listening signal, and focus, typing, tasks and connection traffic never stand in for one.

The conversation owner puts the message box at the foot of Home, with the last turn's two lines above it; Tasks and Activity run to the foot with nothing over them.
One capsule sits in Home's column under the card's pager and grows with the message, photos, last turn and problems; no panel sits behind it.
On iOS 26 the capsule is native glass; on iOS 18 it is the field's fill and hairline.
In the landscape sidebar layout it sits at the stage's foot.
The message box stays mounted once, so its own text and photo drafts survive changing tabs or rotating; no tab or orientation branch owns another copy.
On an iPhone on its side the card gets the height: the bar keeps its one row with the strip; the last turn and the notice wait until it is upright; and one row holds the removable photo strip and the message capsule.
The field shows at most two lines there and keeps its full text; the 44-point controls and complete warning rows remain visible at the foot.
Portrait and iPad retain the stacked layout; a landscape card must show its full heading and have enough scrollable height to read body text and use its actions.
Dictation is the keyboard's own.
While the keyboard is open, a native Done button takes the Settings button's leading slot and supports Shift-Command-K without sending or clearing the draft.
Its command belongs to the persistent navigation bar, not the keyboard's transient accessory view.
Tasks uses the desktop's five groups, search, status/key/title/project rows and records with their actions at the foot.

## On the computer

On the computer, + A phone opens the existing link panel with a locally encoded scan code, a Copy link alternative and Stop it.
The code has a white quiet margin in both themes because the phone's camera must read it.
The panel says the phone app comes from TestFlight for now, only to people asked to test it, so it implies neither App Store availability nor that anyone can install it.

## Talk and tasks

The joined screen keeps the message box at the foot of Home, with the last captain turn and the first mate’s reply immediately above it.
The last turn is two bare centred lines, one each, with no border, fill or padding: the captain's words in the secondary ink, the reply in the primary ink, each inside quotation marks in the muted ink.
The message field, Photos and Send sit inside the one capsule, Send at its right edge and dimmed until there is something to send.
The native multiline field takes the keyboard’s dictation; there is no second microphone or speech engine.
Photos opens the system library picker, and selected photos appear as removable thumbnail chips above the field.
Send submits words and photos once; a refusal keeps the draft and says why, and an unconfirmed send asks the person to check the Mac before sending again.
Out of reach and a read-only connection retain the view but refuse every change, without sending it later; the one line under the message box says which.
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
The notice is a quiet pill at the top of every tab, under the top bar and over the stage beside the landscape sidebar: a mono New card or Reply label in the accent, then the card's title, on the raised surface with a hairline.
A tap opens the card on Home and a swipe dismisses it; a reply notice leaves after a few seconds, a new-card notice when its card is read, and VoiceOver offers Dismiss.
No notice requests background delivery, and an initial snapshot does not announce old cards.
