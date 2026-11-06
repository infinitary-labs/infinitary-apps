# Careful proves once, after the code review

INF-2672, the captain's Approve and build of direction A: review the code first, prove once, and the reviewer reads that proof once.
Careful used to run its live proof before the review, and every fix round made a new version that proved again and had its proof reviewed again, even rounds that changed only documents or comments.

What the first mate is now told changes in one wake and the care guide:

- The passed-review wake (`review-passed`) names the builder's live proof at the passed head when it planned scenarios: whether it is accepted, its latest run and whether this review read it.
  While the proof is not accepted, the wake's step is `REVIEW_PROOF_NEXT` instead of `REVIEW_PASSED_NEXT`: steer the builder to prove once without pushing, start the one proof read with `review_of` when it reports the run, send a failed or short proof back as a repair that gets a review of its own difference, and finish proof that only runs on a pushed branch beside the checks after the push.
- The care guide (`resources/runbooks/care/guide.md`) says the code is reviewed first and the proof runs once after it, and that the push follows the proof read.

Its homes are the wake and the care guide, never the core. The wake costs its words only when a review passes; the care guide, which the first mate carries on every turn, grows by one sentence and a longer step, about 60 tokens (`tests/firstmate-fixed-context.test.ts` still passes).
