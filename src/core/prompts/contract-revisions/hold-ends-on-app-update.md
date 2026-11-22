# End a started task's hold when the app update it waits for is installed

INF-5578's audit, finding 4, which the captain chose to start: three tasks stood still for hours after the app update their hold waited for was installed, because the hold could only end at its time, by an outside event, or by a turn.
The update_task `hold` parameter gains `on_update` with an optional `version`, for a task that waits for an Infinitary update on the computer it runs on.
The host records the version that computer runs when the hold is written, and ends the hold with one steer once that computer runs the named version, or with none named, any newer one.
It refuses the hold when no version is named and the computer's version is not known, when the version named is not a version, and when the computer already runs it.
No core text changes; the parameter's description adds about 35 tokens to the tool surface.
