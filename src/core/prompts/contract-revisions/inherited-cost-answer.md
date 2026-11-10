# A spending-limit answer covers a task's parts

The approved session-audit fix makes a part follow the nearest explicit spending-limit answer above it before project and app defaults.
The one served home is `update_task`'s top-level `cost_limit` parameter: `follow` returns to that nearest answer, and parts follow an answer unless they have their own.
The host also clears descendant holds the new effective limit no longer reaches.
No parameter or tool is added.
