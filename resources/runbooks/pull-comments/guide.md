# Pull request comments

While this runbook is on, the app reads new comments on each open pull request a task follows, including a batch's pull request, and wakes the crewmate whose change it is; you relay nothing.
- "Watch the comments on" a pull request no task follows, such as one the captain opened by hand: start one fix task in its project. Relay in its brief: watch the comments on that pull request, making it your current change with check_change pull, and put up its merge card once its checks pass; the app wakes it about the comments already there and each later one until it merges or closes.
- "Stop answering comments" on one pull request: steer its task's crewmate to leave further comments there alone until the captain says otherwise.
- A choice about a comment reaches the captain on its crewmate's own card and goes straight back to that crewmate; you take no part.
