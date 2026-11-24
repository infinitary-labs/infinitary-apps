# Restore four instructions prompt trims dropped

Part 1 of an approved plan from an audit of recent prompt-budget trims, which found four lost instructions it rated high and still missing.
The captain approved the plan and chose to keep both budgets for now.
Each sentence is restored in its own home, from the wording the trim removed.

What the first mate and a crewmate are now told:

- `check_change` (crewmate): absentChecks needs positive evidence, and "time, history or missing workflows prove nothing", so a change is not called checkless because no check has appeared yet. Removed by the Nov 20 crewmate trim. About 13 tokens.
- `open_change`'s `around` (crewmate): "Change a person's words only when asked.", so text a person wrote around the story is not rewritten unasked. Removed by the same trim. About 10 tokens.
- `prepare_change` (crewmate): after inspecting publishable media, "publish no private threads, local paths or secrets". The Nov 11 trim removed "no private threads or secrets" from the media sentence and "Keep local paths and private threads out of published text." from the saved-story rule. The crewmate core's public-writing rule already says leave out folder paths and the captain's words for text, so the two return as one clause in the story's own tool, where it also covers pictures. About 13 tokens.
- `move_task` (first mate): "Files git ignores stay behind and go with the old copy unless keep names them." The Nov 16 trim's "stay with the old copy" hid that the old copy, and those files with it, is removed. About 3 tokens.

Homes: each rule returns to the tool description it left and is said nowhere else.
The crewmate's fixed context grows by about 36 tokens and the first mate's by about 3 (`tests/crewmate-fixed-context.test.ts`, `tests/firstmate-fixed-context.test.ts`); both budgets are unchanged.
