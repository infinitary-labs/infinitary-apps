# Task wait projection

Task rows and detail reads optionally carry `waits`, a read-only projection of standing owner facts with source identity, cause, task keys, recorded-since dates and explicitly named next events.
An empty array means no standing waits; an older home omits the field and keeps its existing presentation.
Desktop kanban, hover previews and task cards use the projection without changing list rows, task state, scheduling or priority.
