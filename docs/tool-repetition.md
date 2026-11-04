# Completed-operation repetition

INF-1996's accepted three-total choice observes exact completed operations, not whether work is useful.
The original result plus two unchanged repeats sends one possible-repetition wake directly to the first mate through the lifecycle router and durable inbox.
The first mate judges the evidence against the original task: prescribed repeated tests, rereads and polling may be legitimate, and steering or interruption stays within the original scope.
There is no automatic interruption, no-edit judgment, spending cap or quiet-time delay.

## Source and identity

The work-side session owner follows the original durable transcript through `followCompletions`, for Pi and Claude alike, before deriving compact facts for delivery.
Pi persists messages after notifying display listeners, so observation runs after that notification rather than trying to recover arguments or pictures from display events.
Claude refreshes its existing incremental transcript copy before observation.
`readSessionDelta` in the existing session reader visits only appended whole lines and retains only an incomplete current line, not accumulated history.
A first activation checkpoints completed existing history without scanning it; later activations recover the uncheckpointed suffix.
An incomplete or unavailable source supplies no positive repetition evidence.

`SessionCompletionStore` owns the derived `completions.sqlite` adjunct in the task root, outside the copied session-record folder, including its source cursors, in-flight argument digests and pending compact observations.
Each whole source line atomically commits its byte position, affected in-flight pairing and pending observation.
A previously checkpointed source is rejected before content fingerprinting.
A conversation's file name is its stable stream identity, so moving the task folder rebinds its location without recounting the kept recovery copy.
If the existing deletion owner replaces a transcript, observation anchors at its new end and discards incomplete pairing, without replaying the rewritten content or inventing new completions.
The source's call and record references stay available for inspection, while transport identifiers and timestamps are excluded from content identity.

`completionDigest` incrementally hashes typed values with SHA-256.
Object keys are sorted, array and content-block order are preserved, and scalar types remain distinct.
The operation digest covers the tool name and canonical arguments; the result digest covers returned content and error status, including image media type and content.
Hashing uses bounded pieces of the existing strings without decoding or rereading image files.
After pairing and hashing, only compact digests and references remain in the detector's records.

## Task state and delivery

`TaskService` is the sole writer of `task_repetition_cursors` and `task_repetitions`, through `TaskRepetitionStore`.
One indexed operation row retains the latest result digest, streak count, first/latest call references and times, and notice identity.
An unchanged completion increments only that operation's streak; a changed result or error starts its streak at one.
Other operations do not reset it, so `A → B → C → A → B → C → A` notifies for A on its third unchanged completion.
Further unchanged completions update the count without sending another logical notice.
Delivered guidance retires the previous observation period's operation rows without deleting original sessions or notice evidence.
Normal compaction, including Claude's compact summary, does not reset counts.

The consumer accepts each stream's durable sequence in order, ignores redelivery and refuses gaps until the existing recovery path supplies them.
Its transaction commits the processed sequence, affected operation row, notice identity and the inbox's once-named wake together.
The work-side source acknowledges its pending observation only after its downstream owner has kept it.
A crash therefore retries the same notice identity without incrementing counts or rehashing pictures.
This is logical notice deduplication through the existing inbox, not an exactly-once promise about model execution.

A work computer retains observations in the existing numbered outbox before acknowledging its local source.
`PlacedSessions` already waits at event gaps and rejects duplicate delivery before the home consumes observations.
The work computer always sends these observations, since it takes work only from a home on its own contract major.
The home never fingerprints its copied transcript again.

The first mate's wake includes the first/latest inspectable calls, count and elapsed time, plus the latest available ledger reading through the existing usage owner.
That reading is the newest by reading time, with the last recorded row breaking a tie; the existing task/time usage index serves the lookup.
That reading is labeled as a reading, not a lifetime total; absent measurements and cost remain unknown.
Raw pictures and argument values never appear in the wake.

## Work and retained state

Across N completions, B new argument/result bytes, canonicalization work C and U current distinct operations, observation targets `O(B + C + N log(U+1))` work.
Appending one completion does not enumerate or rehash previous conversation results or operation records.
Task operation state is `O(U)` fixed-shape indexed rows, with durable source positions and only unacknowledged compact facts and in-flight pairs in the work-side adjunct.
Observation retains no completed image buffers and imposes no approximate eviction of distinct operations.
Period retirement deletes the previous period's derived operation rows; session records and inbox semantics stay unchanged.

The behavior and deterministic work checks live in `src/core/pi/repetition.contract.test.ts`, including actual read-tool picture results, both source dialects, interleaving, changed errors, guidance, compaction, ordering, duplicate delivery and crash/restart.
