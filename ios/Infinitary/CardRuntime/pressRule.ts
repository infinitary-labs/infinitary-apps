/**
 * The phone's rule for a finger held on a card's or panel's picture (docs/ios.md, "Cards on the phone"): a picture the
 * bridge opens (`data-inf-picture`) cannot be lifted to drag, have its words selected or show the system's menu for it.
 * Held past the moment WebKit starts any of those, a press otherwise ends in a drag or a selection with no click, and
 * by then its release holds none of the page's user activation the host's gate on pictures reads, so the bridge cannot
 * open the picture for it either (`FRAME_PRESS_SCRIPT`). With none of them to start, WebKit clicks the held picture
 * itself as the finger lifts, with an activation of its own. The rule only ever rides a phone page; the Mac's
 * stylesheet is untouched.
 */
export function phonePressRule(): string {
  return "\n[data-inf-picture] { -webkit-user-drag: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }\n";
}
