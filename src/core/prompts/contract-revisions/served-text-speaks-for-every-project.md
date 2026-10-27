# The served text speaks for every project

INF-1553, the captain's audit ask after INF-1549 ("i want that task to start with an audit for whether we already have such mix ups in the codebase"): the first version of that change wrote this repository's own signing setup into the rule every user's crewmates are served, and the audit found three more such sentences.
`spawn_crewmate`'s description no longer names this repository's development signing folders or its scratch-signing setting: it says the real keychains or a project's own signing material, and reproducing keychain or signing behavior with stand-ins under a scratch HOME.
The crewmate prompt's Keychain rule says the same in the same words, without this repository's test file.
The kind classifier's retrieval instruction names the fleet's other computers and the project's checks, runs, logs and pull requests where it lives, instead of a Mac mini, its CI runners and virtual Macs, GitHub alone and a job's slot or lease; `KIND_CLASSIFIER_INSTRUCTION_VERSION` moves to 5.
No rule, tool, parameter or wake is added.
The first mate's fixed context shrinks by about 12 tokens and a crewmate's by about 2 (`tests/firstmate-fixed-context.test.ts`, `tests/crewmate-fixed-context.test.ts`).
The boundary is written in `docs/orchestrator-contract.md`, "What the served text may name", and `tests/served-boundary.test.ts` holds the part that is a fact of the tree.
