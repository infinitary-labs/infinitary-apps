# Saved knowledge as counts

INF-4008, approved by the captain with direction B (the tool and one line saying how much is saved).
The captain: "saved knowledge should be discoverable by the agent but not automatically injected".

The first mate's input no longer carries a `knowledge` fact of entries matched from the captain's words.
Its context carries a saved section instead, `saved_knowledge`: how many personal entries, saved sources and their findings the captain's collection holds, sent once per conversation and again when a count changes, and absent while nothing is saved.
No saved entry's words, title or id reach it unasked.

The `knowledge` tool description adds one sentence, its home for the rule: no saved entry is put in the agent's instructions, so it searches when the work may depend on the captain's situation or a saved source.
The fixed context grows by about 25 tokens for that sentence; the per-message lookup it replaces cost up to 2 KB on a matching message.
