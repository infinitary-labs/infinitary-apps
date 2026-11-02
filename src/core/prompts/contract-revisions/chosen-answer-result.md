# Chosen answer cards deliver their requested result

INF-2242's approved plan replaces only `CARD_PARAMS.answering` in `cardContract.ts`.
The parameter tells authors that a delivered result can answer the request while offering further work, but a prerequisite question or consent cannot.
This replaces the old answer description rather than adding a second instruction, examples or new fields.
The asking, continues and handoff guidance stays unchanged.
The replacement adds about 19 tokens at its existing home; it introduces no host interpretation of natural language.
