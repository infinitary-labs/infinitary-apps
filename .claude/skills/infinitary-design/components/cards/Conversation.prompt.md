# Conversation

Everything the captain did directly and what came back, held by the window at the front of the stack (INF-6337's plan, the captain's Approve and build; behavior in `docs/composer.md`, "The conversation").
It is an escape hatch for a person who still thinks in a chat thread, and the place to find their recent cards.

## Shell

- A `ResponseCard` of kind `note`: the Note chip, then a quiet "Conversation" heading in `--fg-2` at `--text-sm`, then `GroupedPills` for its two views, Everything and Cards.
- No actions, reply row or footer; the shared minus or Esc puts it away, and Find in this card searches what it has read.
- 720 px wide until the captain drags it, between the regular and wide sizes (`CONVERSATION_WIDTH`).
- While it is shown the lines above the message box are not drawn; the message box is its field.

## Everything

Oldest at the top, the newest at the foot, the body scrolled to the foot on open, or to the round the strip was pressed on, centered and outlined for a moment in a 1 px `--accent` line `--space-2` outside it, `--radius-m`, which fades over `--dur-slow` after 1.6 s.

- **Day line.**
  A hairline in `--line-1` either side of the day's name (Today, Yesterday, or the weekday and date), mono `--text-xs` in `--fg-3`, `--space-2` above and below.
- **Time.**
  Mono `--text-xs` in `--fg-3`, centred, drawn only where the minute changes.
- **The captain's words.**
  Whole, in the strip's soft grey bubble (`--fg-1` mixed at 8% over transparent, corners 11, 11, 4 and 11 px, padding 3 px by 10 px), `--text-sm` in `--fg-1`, on the right, at most 82% of the width, selectable; a message that was only pictures reads "A picture".
- **The first mate's words.**
  Unboxed on the left beside its 14 px mark in `--accent`, `--text-base` in `--fg-1`, line breaks kept, at most 92% of the width; `--danger` for a problem.
  While it works on the newest message the mark turns `--hot` and spins as the strip's does, and "Working…" in `--fg-3` stands in for a reply not yet given.
- **A card tile.**
  Before each act on a card: a button with a 1 px `--line-1` border, `--radius-m`, `--bg-2` fill (`--bg-3` and `--line-2` on hover), padding `--space-2` by `--space-3`, the card's kind chip, its title cut with an ellipsis, and its task's key in mono `--fg-3`.
  A press of a card's button follows as the captain's bubble, "Chose “Approve and build”"; a line typed under it follows as their bubble, then the author's first answer: the first mate beside its mark, a crewmate after a mono "Crewmate" label.
- Rounds are `--space-5` apart; the parts of a round `--space-2`.

## Cards

- "Waiting on you", a mono `--text-xs` heading in `--fg-3`, over the live cards, those put aside included, newest first, each a tile with its time under it.
- "Answered" over the cards the captain acted on, newest first, each once: its tile, then "You chose “…”" or "You replied “…”" and when, in `--fg-3` at `--text-xs`.
- A tile opens its card: a live card comes forward and its Hide returns to the conversation in this view; a closed one opens as a past card, whose minus does the same.

## Reading on

The core sends 30 rounds at a time; scrolling to the oldest end reads the next 30 and keeps the reader where they were, with "Reading earlier rounds…" in `--fg-3` while it reads.
A home too old to answer shows the two rounds the strip holds and says "Only your last two messages could be read."
