# End a started task's hold sooner on an event

INF-5145's plan, part 2, approved by the captain: the update_task `hold` parameter gains `on_event`, an event named as an Automation event rule names one (integration, event, filter), in the shape a put-off's event takes.
The parameter's description says the event ends the hold sooner, once, through a rule that runs on its own and tells the task what arrived; the captain chose that it runs without a click, as a Not until rule does.
The host checks the event as a rule's event is checked and refuses the hold, making no rule, when nothing connected tells it or the hold itself is refused.
No core text changes; the parameter's description adds about 40 tokens to the tool surface.
