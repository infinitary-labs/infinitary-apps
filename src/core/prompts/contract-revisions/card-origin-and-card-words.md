# Where a card's work came from, and two rules for a card's words

INF-2326, from the captain's choice on its plan: "Approve and build. card_words: Words only: two rules in the card guidance, measured by the replay check. pieces: One change."

The line under a card's title now names where the work came from, nearest first: the captain's message that filed or started it, an automation that filed it, or a card click it was filed from (`docs/card-authoring.md`, "The You asked line").
The host saves an automation, click or report origin when the first mate files or starts work while answering one.
`spawn_crewmate` and `create_task` gain a top-level `origin` parameter: when one turn read several automation runs, card choices or crewmate reports and none of the captain's messages, it names the one the filing answers, and the host refuses a name the turn did not read.
That rule's one home is the parameter.

The card guidance gains two rules, said in words every project has:

- A project's own term, a name its code or people coined, is explained in a few plain words where a card first uses it, or replaced by those words.
- A card about a change says near its start whether people using the project will notice it, or whether it changes only how the project is built, checked or documented.

Their one home is the authoring text both personas read (`CARD_AUTHORING_PARTS`, `src/core/prompts/cardContract.ts`).
The crewmate's completion card asks its What changed section for that effect; its home is the crewmate prompt's completion-card sentence, which the first mate does not read.
The replay gate measures both rules by hand-read labels (`term_explained_share`, `change_effect_share`, `docs/replay-harness.md`); no word list or term finder looks for them.

The first mate's fixed context grows by about 220 tokens, to 19,624 under the unchanged 19,772 boundary (`tests/firstmate-fixed-context.test.ts`): about 140 for the `origin` parameter and about 80 for the two rules.
The crewmate's grows by about 107, still under its boundary (`tests/crewmate-fixed-context.test.ts`).
