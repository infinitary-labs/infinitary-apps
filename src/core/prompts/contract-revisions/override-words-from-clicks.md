# Override words from clicks

INF-1582's audit, finding 2, filed on the captain's words "a click on a yes button does not count as your yes": the app refused the override after the captain clicked a button on a first mate card, dropped the go-ahead they typed while a crewmate's report was being read, and left them copying approval words in by hand.
`update_task`'s `override` parameter now says `from` cites a card's reply or click, `crewmate-tab`, or `standing`, the words of the override already recorded on the task, so the first mate names more holds with the captain's one sentence; its one home stays that top-level parameter.
The host takes a card's words from the newer of the captain's reply in its thread and their click on one of its buttons, on the first mate's cards and a crewmate's alike, and a click reads as the button's words, the card's title and anything written beside it, the words Merge anyway records too.
A turn's own words are every message of the captain's it carries, however it began, so words typed while a crewmate's report is being read count in that turn.
The first mate's soft-hold sentence on a refusal names a click among the words it may cite, and the crewmate's names a click on its card's button among the words it reports.
The longer `override` description costs about 13 tokens of the Firstmate's fixed context, from 17,672 to 17,685 (`tests/firstmate-fixed-context.test.ts`).
