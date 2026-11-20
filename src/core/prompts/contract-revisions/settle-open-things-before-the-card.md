# A crewmate settles what it leaves open before its card, and the crew's own work is a fact

INF-4574, the audit of cards that showed the crew's own choices as the captain's decision; the captain chose "Approve and build" on direction B, "The app says what it knows, with the same words", and said yes to letting a merge click allow what a listed after-merge step names.
Crewmates put up cards that asked the captain to start work the crew had already decided on, and cards from steps the crew started read as the end of the story.

What the first mate is now told:

- The emit_card contract asks only for the captain's part - what they want, a consent, a sign-in - and says the crew's decisions and running work are facts with their owner, never buttons; a next move for work the captain did not ask for goes to the first mate in the report.
- The core's triage bullet sets `internal_step` on a filing the first mate queues or starts that the captain did not ask for, and, when a crewmate hands over an open thing with `needs_firstmate` while its card is up, names or starts its owner that turn and steers that crewmate with the owner's key.
- A step the app files at a merge is briefed as the crew's own (`internal_step`), says which merge listed it, its sibling steps and what it waited on, and a run watch on a batch run tells a watcher outside the batch that the batch's repair owns a failure.
- prepare_change's after-merge rule names `uses`: what a step will use that needs the captain's yes, which the captain's own merge click allows and a merge the app makes on its own does not.

Homes: the card rule is the emit_card contract's, the triage rule the core's, the step's facts the builder's brief, the batch words the run-watch wake, and `uses` prepare_change's parameter; none is said twice.
The core's bullet grows by about 50 tokens, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host adds no judgment: whether a thing is open, who owns it and what a card asks stay the agent's.
