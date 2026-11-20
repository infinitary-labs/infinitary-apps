# The first mate aboard Infinitary

FI3-1792, step 9 of the Infinitary rename (FI3-1780's plan): the words the models read name the product Infinitary and the agent the captain talks to the first mate.
The captain's answer on FI3-1720: "'firstmate' is no longer a name. 'first mate' is how we refer to the main agent the user talks to."

- The persona opens "You are the first mate aboard Infinitary, the user's calm desktop first officer, and the app's only voice." (`FIRSTMATE_PERSONA`); it was "You are Firstmate 3000".
- A crewmate is "a background worker aboard Infinitary, working for the first mate, the captain's calm desktop first officer", and still opens "You are a crewmate:".
  A Claude crewmate runs inside Infinitary, and its outputs are the app's tools.
- Every prompt, tool description, parameter, card contract text (`HANDOFF`, `CREWMATE_CARD_ADDENDUM` and the rest), wake and host reply that said Firstmate now says the first mate, as a common noun; what says Firstmate 3000 says Infinitary.
  Words a person reads say "your first mate".
  No tool, parameter or value changes its name: `needs_firstmate`, `FIRSTMATE_OP` and `mcp__infinitary__*` stay as they are.
- The keychain rule names both development signing folders, `~/.infinitary/local-codesign` and `~/.firstmate-3000/local-codesign`, because step 10 moves the signer and the old folder stays on disk.
- A crewmate's emit_card says "With a PR or branch to merge" to stay under the Claude transport's 2,048-character cap.
- Cost: the fixed context measured 19,741 tokens by the app's count, about 28 more than before; its budget rises to 19,745, inside the 19,772 hard boundary (`tests/firstmate-fixed-context.test.ts`).

The ledger entry that comes with it:

FI3-1792. The persona is "You are the first mate aboard Infinitary"; a crewmate is a background worker aboard Infinitary working for the first mate; every contract text says the first mate where it said Firstmate, and Infinitary where it said Firstmate 3000. Tool names are unchanged.
