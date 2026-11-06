# Each decision sits in its section, and file means the backlog

INF-2715, the plan for putting each decision beside its finding on cards; the captain chose "Approve and build" with the rule in the built-in card text for every user, a choice among sections placed after their comparison, start with its moment for work that waits, and INF-2601 folded in.
Audit cards listed every finding, then one checklist of all of them at the end, because the old rule placed a question beside "the paragraph it is about" and a list of findings read as one question.
The guidance also called queued work "filed", and the first mate started work the captain had only asked to file.

What the first mate and every crewmate are now told, in CARD_AUTHORING:

- A decision asks each question inside the finding or section it is about, never in one closing list; a choice among sections follows their comparison. It names no form: each question takes whatever control suits it.
- The card word list says file for the backlog, and start for now or with its moment (starts once INF-12 merges), offering both for each proposed task.

What the first mate alone is now told:

- create_task's description says it records every ask to file, add, note or backlog work, which waits unstarted in the backlog for Start.
- The core says to create accepted work, and the sequences document's pieces line says to create them queued, each starting once its blockers finish, instead of "file".
- create_task's reply line says "Filed KEY in the backlog: title" for work on request and "KEY starts now" or "KEY starts when X finishes" for queued work, and the feed line says "waits in the backlog" instead of "starts on request".

Homes: the placement and word rules are CARD_AUTHORING's; the file-ask rule is create_task's description; none is said twice.
Both fixed contexts stay inside their boundaries (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`): the placement rule names no form, the new-task offer rides the word list, the card-script sentence reaches crewmates alone (the first mate's own cards are static), and "a preview its current settings" is gone, since the preview rule already says it.
No host check reads where a question sits or which verb a card uses: both stay the author's judgment.
