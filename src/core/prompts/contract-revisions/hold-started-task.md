# Hold a started task until a time

INF-5145's plan, part 1, approved by the captain: a started task that only waits on a time or an outside event no message speeds, such as a long run on another computer, can be held instead of climbing the idle reminders to a stuck-task card.
The update_task `hold` parameter owns the guidance: it takes the latest time the wait ends and one line of what the task waits for, keeps the task started with no reminders until then except for a captain reply it has not answered, sends it one message at that time if it is still held, ends with any turn of the task, and `null` lifts it; parking in the backlog stops a task, a hold keeps it started.
The idle stall wake's ways add "Hold it until its wait ends" beside the park way, as a way, not a rule of its own.
The schedule_prompt description adds one sentence pointing a started task's time wait to update_task `hold`.
The host refuses a hold on a task not started, in the backlog, with a turn running, waiting on the captain or an allowance, or at a time already past, in the refusal's own words.
No core text changes; the parameter's description adds about 60 tokens to the tool surface.
