# A started task moves to another repository of its project

INF-6536's finding 1, which the captain chose to build: a task started in the wrong repository of a project needed a second task and a second pull request, because a started task could not move.
The update_task `repository` parameter owns the guidance: alone, it moves the task to that repository of its own project and keeps its key; started work moves only while it has no commits of its own, as its crewmate reports, and starts again there.
The core stops the crewmate, checks its working copy holds no commits or edits, removes that copy and queues the task in the named repository; it refuses a task with commits, a change already opened, a start from another task's work, or an open part, in words.
The crewmate's own instructions say to report a change that lives wholly in another repository before its first edit.
A change that spans two repositories is not part of this move.
The parameter's description grows by about 40 tokens.
