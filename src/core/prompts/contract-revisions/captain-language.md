# The captain's language

INF-3674's approved plan, piece 4; the captain's answer: "Your language for anything written to you; the project's own language for commits and pull requests".
`CARD_AUTHORING`, which every persona reads once, gains one sentence: cards, replies and reports are written in the captain's context-named language, unless the captain asks otherwise, and quoted words keep their own language.
A crewmate alone reads a second sentence: commits, pull requests, change stories, code and its comments, and the project's documents keep the project's own language, the one its existing commits and documents use.
The Firstmate's per-turn context block gains `captain_language`, the language the app speaks on the computer where Firstmate lives, named in English with its tag, such as `English (en)` or `Simplified Chinese (zh-Hans)` (`src/core/prompts/captainLanguage.ts`).
A crewmate's prompt names the same language when its session opens, with a merge card's four headings in it once the catalog translates them, and the card check accepts those headings beside the English ones.
The core is the rule's one home; the context block and the crewmate's prompt carry only the fact.
