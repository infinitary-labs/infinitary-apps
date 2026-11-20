# Every revision while answering carries its own answer

INF-1623, the plan for INF-1595's lost answer; the captain chose "Approve and build" with direction C and "every".
INF-1595's crewmate revised its card with an answer after an earlier line had ended the captain's wait, and the host dropped the answer because nothing waited any more.

What the first mate and the crew are now told:

- CARD REPLIES: a changed card's answer rides as reply on every revision while answering, saying what changed where.
- emit_card's reply parameter: the answer says what changed where, and is required on every revision while answering.
- The thread steer: the answer passed with a revision says what changed and under which heading, and every revision while answering needs its own.

Homes: the rule is CARD REPLIES', the parameter says what the answer holds, and the steer repeats it for the turn it starts; the refusal that enforces it is the host's own consent-free check of a typed fact, the card's hold.
The fixed context stays inside its budget (`tests/firstmate-fixed-context.test.ts`): the parameter's shorter wording pays for most of the rule's words.
The host reads none of the answer's words.
