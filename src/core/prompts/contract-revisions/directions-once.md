# Directions arrive once, and again on change

INF-2599, from an audit of the crew's conversations that found the standing-directions block repeated on every crewmate turn; the captain picked "Send a crewmate its directions once, and again only when they change".

A crewmate's conversation is now told its project's standing directions on its first turn, and again only when the set changes, the conversation folds or starts over, or the turn that carried them was never read.
The first mate's context already carried them once and then only what changed (INF-1712).

What the first mate is now told:

- The knowledge tool's description says directions arrive whole once, and again on change, where it said they arrive whole on every turn.
  The sentence grows by two words, about three tokens of the fixed context (`tests/firstmate-fixed-context.test.ts`).

Home: the knowledge tool's description, shared by the first mate and every crewmate.
