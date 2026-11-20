# Ask the first mate to plan a queue workflow

INF-2885's build, grounded on its plan (the captain's "Approve and build", direction B, "Wake at the choice; switch on only once the queue merges", with their words that the app shows a card saying the project is not set up for it yet and offers to ask the first mate to plan it).
Choosing batched pull requests for a project whose workflows the app reads and finds nothing to answer its queue status now waits: the project keeps where its changes go, and the app's card offers Ask the first mate to plan it.
The new `queue-plan-asked` wake owns the rule: the captain pressed it, so the first mate starts one read-only planning task in that project at once, with no card first, whose goal is a plan for a workflow that answers the queue status, and starts nothing when a task is already planning it.
Since the project's delivery has not changed, the plan's builder ships the way the project's changes go now, and the app switches the project once a merge in it finds the workflow; no served exception is needed.
The project rows carry `delivery_waiting` only while a choice waits.
The wake costs about 250 tokens per press; the fixed context does not grow.
