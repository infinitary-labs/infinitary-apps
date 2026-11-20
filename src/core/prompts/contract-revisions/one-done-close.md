# One close as done, naming why

INF-3169's plan, piece 2; the captain chose "Approve and build", with the delivery proof as the one hold their words pass ("its crewmate has not reported, or its own pull request is still open, or its commits are not merged and the close names nowhere else the work went") and the task's own pull request left open ("Leave it open where the project lives, and say so on the record").
The first mate had five ways to close work as done - `answered`, `finished`, `released`, `carried_on` and a merge close of an already merged pull request - each with refusals of its own, so finished work it could not prove one way was refused every way.

What the first mate is now told:

- `settle_task` has one mode `done` beside `merge-pr`, `land` and `discard`, and names `why`: `answered`, `finished`, `released`, `carried_on` or `merged`.
- `evidence` replaces `completion_evidence` and `release_evidence`; `delivered_in` names any pull request in the task's project or a commit on the main branch for `merged`.
- Closing on its own, the close holds for open decisions, parts, waits and the delivery proof; `captain_words` (this turn, or the card or Crewmate tab line their words came in) passes them all.
- The close leaves the task's own pull request open and records it, except `carried_on`, which closes it.
- A refusal of a hold names the hold with its soft-hold words, as every other soft hold does.

Homes: the modes, holds and the pull request rule are the `settle_task` description's; `why`, `evidence`, `delivered_in` and `captain_words` are top-level parameters; the closing sentence's exception for `answered` and `carried_on` is its own parameter's.
The settle_task description and parameters are about 40 tokens shorter than the ones they replace, and the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host carries the typed facts it read and the first mate's declared why; whether the evidence proves the work stays the first mate's judgment.
