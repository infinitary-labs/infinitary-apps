# A personal panel build ends the ordinary way

INF-1677, the captain's question on its card: "the fix should be to simply remove the special case so it follows the default behavior, right? or something else?", answered yes and closed with Approve and build.
A crewmate's report on a personal panel build used to close its task on the host's own, with no wake to the Firstmate, while the served crewmate text already asked for a note before the report.
The host now commits the workspace and, once the commit lands, routes the report like any other, so the Firstmate hears it and closes the verified build with `settle_task` `finished`.
The `settle_task` description now names personal_ui work beside operations and in_folder work as what `finished` closes; that one tool description is the rule's home.
The `commit-failed` wake now says the task cannot close as finished, instead of naming the host close that no longer exists.
The prompt is unchanged; the description drops its redundant "as done" to make room, so the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).

The ledger entry that comes with it:

INF-1677. A personal panel build's saved report routes like any other; the Firstmate closes it with settle_task finished.
