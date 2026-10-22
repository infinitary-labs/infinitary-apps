# A merge that goes through wakes the first mate only when it leaves a decision

INF-834's friction 7, filed and started on the captain's "File the checked improvements" with his words: "The merge-settled wake fires only when the merge failed or unblocked a decision".
His audit of October 21 counted 62 merge-settled wakes, 45 of them turns that answered nothing needed.

The `settled` wake keeps its words, but a merge or land the captain clicked that went through no longer sends it unless the merge freed open work that only a start begins: a task that waited on the merged one, now waits on nothing, and is on request or held (`TaskService.awaitsStart`).
Every refusal, failure and discard still wakes, as before; a waiting crewmate already hears the close from the ready sweep (`dependency-closed`).

The after-merge check of tasks a report says its change covers needed that wake, so it now has a typed trigger: on the report, the first mate links each unstarted covered task to wait on the reporting task (`link_tasks blocks`, left on request), and the merge that frees it wakes the first mate to drop it as covered or keep it with a verdict.
Optional ideas meriting the captain's choice are offered in one decision card after the report that names them, since a successful merge no longer brings the first mate back to offer them.
The reworded rule costs no tokens: the fixed context still measures 19,772, at its derived boundary.
