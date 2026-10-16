# Knowledge references

FI3-1150 builds the rest of the captain's approved knowledge design (FI3-1110, "Approve and build"): an answer card shows only the findings that answer relies on as compact references that open the Knowledge browser's inspector.
Which findings an answer relies on is its author's call, so the `knowledge` tool's description now says that a card cites each finding it relies on by writing its id, and that the app links it.
The app links an id only where a collection the window reads holds that entry; a stable build serves no knowledge tool and links nothing.
The sentence reaches Firstmate and every local crewmate through the one tool declaration, only in alpha and development builds.
It costs about 20 tokens of the fixed context (`tests/firstmate-fixed-context.test.ts`), which stays under its ceiling.
