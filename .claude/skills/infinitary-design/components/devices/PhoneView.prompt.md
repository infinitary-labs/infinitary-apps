# Infinitary on iPhone and iPad

The native SwiftUI shell uses the shared dark and light colors, Space Grotesk for words and JetBrains Mono for data.
Native controls keep Dynamic Type, VoiceOver, hardware-keyboard focus and platform-sized touch targets; desktop text sizes are not a phone's reading size.
The screen is opaque, with the shared void background, raised cards, hairlines and one ice-cyan selection.
Native colors, spacing and radii are generated from the shared tokens; cards use the card radius and Nearby buttons the control radius.
The single reading column is at most 750 logical points wide.
No character, message bubbles or new visual metaphor appears.

At first launch, the heading says Infinitary is on another computer.
Nearby lists the names of computers announcing Infinitary; a press opens the scanner, never trusts the announcement.
Scan the code and Paste its link are the two join controls.
A confirmation names the computer reached through the link before the phone starts showing it.
A permission refusal says how to allow the camera or local network, without replacing a refused camera with an automatic clipboard read.

Once joined, the top line names the computer and says whether it is in reach.
Out of reach shows the last heard time and retains only the current in-memory view.
Cards and Activity are separate tabs; Cards initially lists titles and attribution read-only, without executing card bodies or showing inert action buttons.
A review-finding card shows Review finding in the warning color above its title, and the builder’s task name in its attribution.
Activity puts the newest line first so returning to it shows the Mac's latest work.
Each empty list says plainly it has nothing to show.
In reach, Leave asks for confirmation and removes this phone from the Mac.
Out of reach, Forget this Mac replaces Leave and asks for confirmation before clearing the saved Mac locally; its explanation says the Mac may still list this phone.
Removed clears the Mac's data from this phone and explains that a new link is needed.
A protected-data read failure explains why joining cannot proceed and offers another attempt after unlocking.
A damaged saved connection clears only the saved Mac, keeps the phone's identity and explains that a fresh link can join again; it never asks the person to unlock for a decoding error.
The iPad uses the same single-column view with roomier margins, not a side-by-side layout.

On the Mac, + A phone opens the existing link panel with a locally encoded scan code, a Copy link alternative and Stop it.
The code has a white quiet margin in both themes because the phone's camera must read it.
The panel says the phone app comes from TestFlight for now, only to people asked to test it, so it implies neither App Store availability nor that anyone can install it.
