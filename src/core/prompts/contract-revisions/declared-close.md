# The declared close

INF-2490, the build of INF-2489's plan (the captain's direction B, "change-per-pr", with the first mate's merge and the served words folded in).
Every pull request a task names is one of its changes, whoever opened it; a merge card names one change, and the app writes on the card whether its click closes the task.
The completion card's settle merge is the finishing merge: it merges the task's current change and closes the task.
A `request_merge` card is a continuing merge: the task stays open and its crewmate hears the outcome once.

What the first mate is now told:

- `settle_task` merge-pr merges the task's current pull request, or closes the task as merged when that pull request is already merged and none of its pull requests is still open, with autonomy on or off; its home is the tool description.
- The card contract no longer says "Other PR: request_merge.": a crewmate's tools say how a merge of another pull request is asked, and a first mate settle merge card on a task with a published story now carries that story instead of being refused.

The fixed context grows by about 20 tokens for settle_task's words and shrinks by about 6 for the removed sentence.
