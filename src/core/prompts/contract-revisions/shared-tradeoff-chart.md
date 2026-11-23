# One tradeoff chart text for every card author

INF-6293's plan, from the captain's ask whether the review finding cards' tradeoff charts should be a common building block any card can use, with plan, decision and review finding cards nudged to use it; the captain chose "Approve and build" with option words a dozen words at most, as on review cards.

What the first mate is now told:

- `CARD_AUTHORING` gains one text, read by every persona: a question whose options differ under two or more whole-product qualities carries a `<table data-inf-tradeoff>` under its options, written as a first row of headings and one `data-inf-option` row per option with a high, medium or low level in each heading's cell; what a heading is and the suggested headings; that with a table each option's label is a dozen words at most, with one line naming the headings on which the options are level and one naming the pick and what it gives up; that an option for what the project does now is marked `data-inf-current` and has its row; and when to write no table.
- `FLEET_WORK`: an option's label, or its tradeoff table, says what it gets and gives up.
- To make room, `CARD_REPLY`, the merge-permission line of `HANDOFF`, the theme token list, the write-in row and the time and language line say the same rules in fewer words.

Homes: the chart's rules have one home, the shared card rules.
The reviewer's handoff (`REVIEW_CARD_RULES`) and the pull request comments runbook, which are not the first mate's contract, drop their copies and keep only that their table is required with the as-built row; the reviewer's brief points at the card rules for what a heading is.
The card check no longer reads whether a question offers what the project does now: a table in a question with no option marked `data-inf-current` is sound; a question that marks one still needs that option's row, and a mark on anything but an option's input is still refused.

The new text costs about 245 tokens in each seat's fixed context and the trims return about 45, so the first mate's fixed context grows by about 200 tokens.
