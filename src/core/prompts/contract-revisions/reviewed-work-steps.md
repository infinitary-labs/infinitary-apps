# Reviewed-work steps where they arise

FI3-566, the captain's Approve and build of the four recommended cuts, delivered in two changes.
This second change implements cut C, the reviewed-work steps; the first change (`reader-specific-fixed-context.md`) made the other three.

The core's rigor rule keeps when to commission a review (`spawn_crewmate` with `review_of` once the builder reports its work committed), says its wakes name each later step, and keeps carrying the captain's latest decision into every fix and review steer.
The finding-fix preamble moves to the builder's reviewed brief (`REVIEW_FIX_RULES` in `renderRigorSection`), so a steer relays the findings verbatim without restating it.
The later steps ride the review wakes, the way `CHECK_DIAGNOSIS_NEXT` rides a failed check:

- A findings or blocked verdict names the relay of every auto-fix finding, that info findings never block, how an ask-user finding is decided or carded once per round, and that a reviewer is steered only to re-review at a new head.
  A builder whose care rose to reviewed after its brief, or a row an older build queued, has the steer carry the preamble instead.
  The findings wake the review cap rides keeps only the cap's words.
- A builder's report names its open review, that review's last verdict and the head it read, and the re-review a new head asks for, with the captain's declined findings under `user_chose_to_ignore`.
- A reviewer's verdict-less report says an idle reviewer needs no stand-by and no status.
- A pass names the steer to push, open the PR and drive CI green.

The plan estimated about 338 tokens; that count included the latest-decision sentence the plan itself kept, and the core now says in seven words that the wakes carry the rest.
The served prompt and live tool census measure 18,541 tokens before and 18,243 after, by the app's characters divided by four: 298 fewer.
The new budget is 18,250, just above that size.
Wakes and briefs are not fixed context: each step costs its words only when it arises.
Recorded replay is host-contract evidence, not a live-model demonstration of the new wording.
