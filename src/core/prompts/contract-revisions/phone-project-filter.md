# The phone's own project filter on the project filter line

INF-2820 piece 2, the plan the captain approved with the answers "Filter button" and "messages: focus": the iPhone and iPad keep a project focus of their own, picked from a Filter button, saved on the phone for each computer, and their messages and card replies say it.
Before, every message from the phone read as every project, since the phone had no filter.

What the first mate is now told:

- From a phone focused on a project: the project filter line names the project, says the filter is on the captain's phone, which they wrote from, and carries the same order and scope as a window's project line.
- From a phone at All projects, or focused on a project the board no longer names: the line says the captain's latest message came from their phone, whose project filter is at All projects and shows every project; before, it said the phone had no project filter.

Home: the per-input `project_filter` line in the core (`projectFilterLine`), as before.
The fixed context does not grow.
The host reads only typed facts: the `focusedProjectId` the phone sent and whether a paired phone sent the message.
