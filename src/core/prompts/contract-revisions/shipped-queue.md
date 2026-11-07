# The shipped queue's wakes

The shipped fix-forward queue's build, grounded on its approved plan (the captain's answers shipped-queue, claim-issue, quiet and keep-and-offer, with their words to make the fix-forward behavior the default for everyone using batched pull requests and to have the first mate's queue offer plan the setup with room for feedback and customizing the checks).
The `queue-plan-asked` wake now asks for a planning task whose brief names the queue-setup skill, and whose plan card lets the captain choose which of the project's checks each batch runs and revise the plan by feedback; it no longer describes a workflow the planner designs from scratch.
The new `queue-paused` wake owns the pause rule: a batch with one of this app's changes failed, so the first mate starts one repair task with the queue-repair skill and no card, unless a teammate already took the pause's issue, and puts up no card about the pause.
The new `queue-offered` wake owns the offer rule: a project whose shipped queue is older than this Infinitary's, or whose own workflow answers the queue status, is offered the update or the replacement once on a decision card.
Each wake costs about 150 to 250 tokens when it fires; the fixed context does not grow.
The `app_change` catalog adds `project-queue-answer`, an own-words action that resumes a project's paused batch or sends one paused change back with the captain's reason and the paused run it answers, the same answer Settings sends; its line costs about 45 tokens of fixed context.
