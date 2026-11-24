# Serve a crewmate's plan, preview and purchase rules where its work needs them

The second change of the captain's choice on an earlier prompt-budget card: raise only the first mate's budget, and move the crewmate's passages that tests held word for word in a change of their own.
The captain allowed the edits to the tests that held them.

Where a crewmate now reads them:

- An answer task's answer-shape section (`renderAnswerShapeSection`, after "Previews and plans:") carries a playable preview's two authoring passages (`ANSWER_CARD_AUTHORING`) and what a planner acts on of the hand-over (`ANSWER_HANDOFF`). A quick answer neither plans nor previews and goes without.
- The basis section of a change built on an answer (`basisSectionParts`, after "Building on an answer:") carries what a builder acts on of the hand-over (`BASIS_HANDOFF`).
- What a purchase review names moves from `emit_card`'s `browser_handoff` to the browser's home view and the help of `click` and `press` (`BROWSER_RULES.review`). `browser_handoff` keeps that the step is the captain's and the card is its review, and says the home view names the rest.

A crewmate's prompt keeps the question-card flags, the steering limit and merge consent of the hand-over.
The first mate's prompt reads every hand-over passage it read before.

Restored, from wording earlier trims removed while tests held the text:

- First mate: "Read-only limits the planner, not its authorized successor.", "Record their facts if needed, then stop; a closed answer is acknowledgement, not build permission.", "Start bounded work only when the settled scope authorizes it.", "the last included" in filing a plan's pieces, and "A parent holds its steps and never builds: a child task delivers what its goal names."
- Crewmate, in the answer-shape section: "The card's own answer, explanation and questions keep the app's look.", a plan card "with more than one part", and the read-only and closed-answer lines above.
- Crewmate prompt: "Name patterns elsewhere in your report, never fixing or copying them."

The largest crewmate reading goes from 25,906 to 24,672 tokens of its 26,624 budget; the first mate's from 20,045 to 20,126 of 29,658.

## Marked list

`node scripts/served-sentences.ts --base` the earlier change's version.

Crewmate:

1. Name patterns in your report: kept, "Name patterns elsewhere in your report, never fixing or copying them."
2-7. A playable preview, its controls, scratch, a preview's look, its own styles and its font files: moved to the answer-shape section, word for word ("A preview loads a font file only by path" for 7).
8. A read-only planner's defaults: moved to the answer-shape section, with "Read-only limits the planner, not its authorized successor."
9. Declare asking true: kept, now the prompt's first hand-over sentence.
10-13. Acceptance queues pieces, what it authorizes, the backlog, a captain-only action: moved to the basis section.
14-17. What Approve and build authorizes, no second approval, what is not build permission, old offers: moved to the answer-shape section, with "Record their facts if needed, then stop; a closed answer is acknowledgement, not build permission."
18-19. The careful-review question: moved to the answer-shape section, "A plan card with more than one part asks one optional checkbox question".
20. A planner never edits product code: moved to the answer-shape section.
21-23. Latest submitted values, actual submissions, the full specification: moved to both sections.
24. The builder acknowledges the spec: moved to the basis section.
25-26. Start on a saved build, a saved build's check: moved to the basis section.
27. A consequential unanswered question: moved to both sections.
28-31. After an answer authorizes a build, a click needs nothing more, revising once, closing the planning card: moved to the answer-shape section.
32. browser_handoff's purchase sentence: kept, adding "your browser's home view says what a review names".
33-36. What a review names, a changed price, an unconfirmed step, an unknown outcome: moved to the browser's home view and the help of click and press, word for word.

First mate:

1. Filing a plan's pieces: kept, adding "the last included".
