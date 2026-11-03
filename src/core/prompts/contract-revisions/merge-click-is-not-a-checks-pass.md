# A click on a merge never passes the checks

INF-1966, filed while reproducing INF-1955: on a pull request with no checks, the captain clicked Merge when checks pass, the app held the merge on the checks, and the first mate then recorded a task-long override of the checks citing that same click as the captain's words, so the pull request merged with no check and no separate word of the captain's.
A click on a merge is the captain's approval of it, kept until the checks pass; it was never a waiver of them.
`update_task override` now refuses an override that names the checks on words that are the captain's click on a merge - the completion card's merge or an ordinary `request_merge` card's - with nothing recorded.
The host reads that from the clicked action's declared effect, never from the words, and keeps the fact on the record, so naming more holds with `standing` carries it; Merge anyway and a merge past the branch rules are not such clicks.
The refusal tells the first mate to leave the checks out, that the merge waits while the crewmate reads them or declares that the pull request has none, and that only the captain's own words that the checks need not pass, or their Merge anyway click, pass them.
The rule's one home is that refusal (`mergeClickRefusal`, `src/shared/holds.ts`); no prompt, tool description or parameter changed, so the fixed context does not grow.
