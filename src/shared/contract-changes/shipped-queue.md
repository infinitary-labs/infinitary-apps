# Shipped queue

Adds the request `inf:repos:queue-answer`, which resumes a project's paused batch or sends one change back, with a reason and the paused batch run it answers; an answer to a run that no longer holds the pause is refused.
Adds the optional `queuePause` to a project's view: the paused batch run, the issue that holds it, when this app first read it, the paused changes and who took the repair, or, when the issue cannot be read, the pause as a paused status shows it, marked `unread`.
Adds the optional `shipped` to a queue workflow: the shipped queue's version its stamp names.
An older side never sends the request, and reads a project and its workflows as before, without the pause or the stamp.
