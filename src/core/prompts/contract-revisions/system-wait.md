# A wait for a system no computer runs is told at once

INF-720's fourth fix, from the captain's review of INF-653 and INF-665, which waited 219 and 115 minutes for Linux before the Firstmate moved them to a Mac.
A queued task in an Automatic project that requires a system no paired computer runs, this computer included, waited on "different required system" as a feed line only, and nothing woke the Firstmate.
Automatic placement now carries that as a typed fact (`unserved`): the systems the task requires and the system each computer runs, set only when every computer's system is known and none runs one the task requires.
The new `system-wait` wake tells the Firstmate the task, what it requires and what each computer runs, and that no room or reading ends the wait: it starts once a computer that runs the system is paired and in reach, or once what the task requires changes (`update_task placement_requirements`).
Its one home is that wake, sent once per task and required system.
The prompt and the tools are unchanged, so the fixed context does not grow.

The ledger entry that comes with it:

INF-720. The system-wait wake tells the Firstmate at once when no computer runs the system a queued Automatic task requires.
