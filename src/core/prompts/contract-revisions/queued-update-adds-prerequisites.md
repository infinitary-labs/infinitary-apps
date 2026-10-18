# A queued update adds its prerequisites

INF-416 piece I, from the captain's choice on the audit plan.
`update_task` adds each declared prerequisite that is not linked yet, in the same step as its other edits, and never compares that list with the current links or removes one.
A queued update that omits `blocked_by` is still refused, so an undeclared automatic start cannot slip through.
`[]` declares none in one place: `create_task`'s `blocked_by` parameter.
`create_task`'s description again says it records project work without starting.
Restoring `create_task`'s purpose sentence is paid for by saying the empty-list rule once and shortening the pieces line. The fixed context stays inside the unchanged 19,770-token budget.
