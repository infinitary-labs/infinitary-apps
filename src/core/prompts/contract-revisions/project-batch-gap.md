# A batched project can wait between batches

From the captain's "Approve and build" on a plan to run a batched project's batch check less often, with more changes in each run.
`app_change project-settings` gains `batchGap`: a batched project's least minutes from one batch's start to the next, or null to start one as soon as a change is approved, as before.
A held batch's repair never waits for the gap.
The project's current gap reads as `batchGap` in its settings value, null when it has none.
The captain makes the same change with Settings → Projects' When a batch starts.
The words live in the project-settings action line, its one home; the fixed part grows by about 35 tokens by the app's count.
