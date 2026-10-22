# Typed results and branch_from

INF-799 piece 1, from the captain's Approve and build on the plan "Plan task-graph programs, typed results first" (answers: the host checks the result; delivery is a branch and a result).
`spawn_crewmate`, `create_task` and `update_task` take `result_schema`, a JSON Schema with an object at its root for the typed result the task's report must carry, and `branch_from`, the task whose last commit the new task's working copy starts at.
The parameters are bare (`{"type":"object"}` and `{"type":"string"}`, no description); the rule for both, including that `update_task` clears either with `{}` or an empty string, has one home, the served sequences guide's preamble.
A schema without an object at its root, and a `branch_from` that names an unknown task, the task itself, a task in another project, or one with neither a branch nor saved work, are refused as tool text and nothing is filed.
A step filed behind open work that has not started yet may name it; its branch is checked again when the step starts, and a start with nothing to branch from fails in those words.
The report wake carries the checked result after "Its result, as declared:" (the wake's home), and the tasks query by key reads `result`, `result_schema` and `branch_from`.
No host rule reads the loop.
The fixed context grows by about 110 tokens in the app's count, inside its boundary.
