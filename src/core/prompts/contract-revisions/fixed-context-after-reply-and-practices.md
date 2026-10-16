# The core drops three phrases a tool or the core already says

FI3-1805 brings main's checks back to green after two changes merged against the same older main.
The development-practices rule (`project-testing-rules.md`) left the fixed part at 19,599 of its 19,600 budget, and the always-answer thread rule (`always-reply-in-thread.md`) was measured without it; together they measured 19,616.
The Firstmate's core now leaves out three phrases whose rule is still served:

- The escalation rule no longer adds "the host replaces that attempt at the chosen tier"; `spawn_crewmate`'s `escalate_from` says it ("The host stops that attempt, keeps its branch and report, and runs this one a tier up.").
- The thread rule no longer opens with "Every card is the head of a thread with its author"; the same sentence goes on to say what the captain types under a crewmate's card reaches that crewmate, and `CARD_REPLY` says it for the Firstmate's own cards.
- "The fleet is yours to operate." is gone from the rule against sending the user to Settings; the operate case already says fleet management is done now with the Firstmate's own tools.

The fixed part measures 19,581 of the unchanged budget, about 35 tokens fewer, which leaves room for a few words before the next change has to trim.
No rule changes, and no other text changes.
