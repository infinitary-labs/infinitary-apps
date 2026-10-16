# Task-card specification used in the isolated evaluation

Source: FI3-309's recorded proposal/card. Its latest report is an evidence correction, not a replacement for the whole proposal. This fixture preserves the proposal's complete behavioral scope, assumptions, exclusions and shipping pieces. q2_count=many is the recorded regression selection. The isolated evaluation explicitly stipulates acceptance of the other displayed defaults; those stipulations are fictional test facts, not retroactive authorization for FI3-310 or any backlog task. Autonomy is off and no merge permission is supplied.

## Requested change and proposed specification

Make task popovers normal cards; make card surfaces solid; hide Firstmate and crew animations while cards are visible, without stopping their work.

The task record returns to the main card stack as its front entry, shown immediately on a Tasks-row click and paged with ordinary cards. The row remains selected while its record is open. In the proposal default, only one record is open at a time, so another row swaps that entry; the actual q2_count=many answer supersedes this default: one record per task, each its own entry, closed one by one.

A new ordinary card arriving while a record is shown goes behind it unread; the pager's dot and count remain the notice. Show the card in the record's waiting box pages to the decision. Hide or Esc closes the record; the card behind it becomes shown. Esc acts only when the record is the shown entry and never closes an ordinary card. Clicking outside does not close a record. Closing the last entry reveals the character again and gives input its focus back.

The record stays a shell-held typed view, not a card row, never agent-emitted and never a feed line. Restore the earlier typed stack entry model from history while keeping the pane's newer chrome and lifecycle footer: status pill with Tasks dot, key, model chip, title, Hide; footer lifecycle toggles; Show the card still points to the waiting decision. It is regular-width with the normal lone-card edge drag, no thread/reply row and an internally scrolling body. Record bodies and tasks.detail reads remain unchanged.

A record counts as a card for the stage: when open it makes the character hidden and the screen Working. The turn hint is the shown entry alone: the record's task when a record is shown, the card's id when an ordinary card is shown. Both hints never ride together. Remove Tasks-row anchor reporting, pane placement arithmetic and the pane; the bridge script remains untouched.

Five surfaces consume the same four acrylic tokens: card, stack peeks, card-and-thread pair, record pane and notch. Redefine --acrylic-bg to var(--bg-2), --acrylic-blur to none, --acrylic-border to var(--line-1), and leave --acrylic-shadow unchanged, in both app and design-skill token homes. --bg-2 is the existing raised card surface, white in the light theme. Sandboxed body frames remain transparent and unchanged. The picture viewer keeps its own modal blur. Update the skill readme and documents that still describe cards as acrylic. There is no new setting.

The one frame holding Firstmate, crew orbit and first-turn label fades to hidden over --dur-slow (700 ms), then returns by the same fade when the last stack entry closes. Reduced motion snaps instantly. Only pixels hide: animation loops, character state machine, orbit model, emote/flicker channels and every agent turn continue. The character comes back mid-motion without queued work. Thinking and the coming crewmate model labels hide with the frame; model labels mount inside that same frame. The notice pulse loses its surface while cards are up; the existing pager dot/count supplies that notice. The pulse still plays with an empty stack.

## Offered choices and actual fixture selections

1. Record opens at front and is shown immediately (default front accepted in this isolated fixture).
2. Proposal default one record; actual submitted q2_count=many: one per task, each closed independently.
3. Hide or Esc only; outside click does nothing (default card accepted in this fixture).
4. Raised var(--bg-2), not var(--bg-1) (default bg2 accepted in this fixture).
5. Fade both ways over slow token, snapping under reduced motion (default fade accepted in this fixture).
6. Keep loops running unseen, never pause (default run accepted in this fixture).
7. Existing pager dot/count supplies notice, no new badge motion (default pager accepted in this fixture).
8. Thinking/model labels hide with frame (default hide accepted in this fixture).
9. Esc hides only the currently shown record, never any other card (default record accepted in this fixture).

The proposed next-round questions apply only to alternatives NOT selected here: pause would require a choice about queued emotes; an end-position record would require a choice about row selection while its record is not shown. Neither is an outstanding question for this selected spec. No unrelated direction is approved.

## Boundaries and order

Keep the card wire/refusals, cards-as-threads and close-out rule, whose-turn and idle ladder, Tasks gestures/selection push, lifecycle operations and Drop task, character machine/orbit/emotes/flicker, Firstmate context/hint resolution, window material/wash slider unchanged. Out of scope: the model-label build itself, Thinking timing, pausing agents, Settings view (already unmounts the character), a new backdrop, or general card/core redesign. The core card stack primitives stay untouched; this is the shell's record view.

Three separately shippable pieces, each retaining this full scope and its accepted choices:
1. Solid surfaces: four token definitions in both homes; stale acrylic documentation; end-to-end computed no-blur and opaque-fill checks in both themes.
2. Hide character: replace dim/blur with fade and reduced-motion snap; update design readme; tests of visible-under-card now assert hidden while unrelated no-card character tests stay valid.
3. Record on stack: restore typed record stack entry/index rules; render through the normal card component with newer pane chrome/footer; remove pane/geometry/anchor reporting; update shared recordFrame/hideRecord helpers once for their end-to-end callers, never copy moved selectors across tests.

Once the pane disappears, the old separate backdrop task is moot, but this evaluation authorizes no start or cleanup of that or any other backlog task. Relevant journeys include now-panel, record-controls, frame-scrollbar-threshold, closed-blockers, answer-task and card-threads through shared helpers; unit coverage includes store, record chrome/footer and now actions. Product verification must demonstrate stack paging/record close behavior, actual opaque/no-blur styles, visible character fade/reduced-motion snap, continued loops/agents and both themes. Passing this verification does not authorize merging.
