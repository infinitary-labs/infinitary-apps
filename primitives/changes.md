# Changes

A change is the host's typed record of one unit of work offered to a project: where it is, its handle where the project's host keeps one, who raised it, each version pushed with the facts the host held at it, and its receipt once merged or closed.

## Intended use

Record every change a task carries as one record with a stable id, so the pull request, its checks, its reviews, its story, the consent given and the merge are facts about the change at a version rather than fields scattered over the task.
Give each version pushed its own row in the order the host saw it, holding the checks read, the review verdict declared with its findings and its reading, the story prepared and published, and the consent given there.
Let the tools, the completion card and a review name the change by its id, and let every surface read what the host knows about it from the record ([the task record](../docs/task-record.md), "A task's change").

## When to use it, and when not

Use the change whenever a feature needs a fact about a pushed version: a check reading, a verdict, a story, a consent or a receipt.
Do not put a judgment in it: every value is a fact the host held or was told, and the crew's readiness, flake, settlement and stopping judgments stay in the delivery guidance (`resources/runbooks/delivery`), what each care asks in the care guidance (`resources/runbooks/care`).
Do not keep a second copy of a version's facts on a card, a feed line or a feature's own row; read the change.
Do not make the host enforce a care through it: the care is a name on the task's policies, the review and live validation Careful's guidance orders are recorded here when they happen, and the host reads them only to attest a pull request ([the forge seam](../docs/forge.md), "No-mistakes' attestation").
Work that ships nothing - an answer, a review the host raised, work in the personal workspace - carries no change.

## Owner and entry points

- The record: `ChangeStore` in [`../src/core/storage/changeStore.ts`](../src/core/storage/changeStore.ts) (`get`, `forTask`, `list`, `project`, `deleteFor`, `deleteAll`), written only by `TaskStore` beneath `TaskService`.
- Its shape: `changeRecordSchema`, `changeVersionSchema`, `changeChecksSchema`, `changeReviewSchema`, `changeStorySchema`, `changeConsentSchema` and `changeReceiptSchema` in [`../src/shared/change.ts`](../src/shared/change.ts), published in `docs/contract.json`.
- The projection from a task's record: `projectChange`, `carriesChange` and `isHostRaisedShape` in [`../src/core/storage/changeProjection.ts`](../src/core/storage/changeProjection.ts).
- Reading it: `TaskService.changeFor` over `changes.forTask` for a task, and `CardService` over `changes.get` for the card that offers a version.
- Naming it: `open_change` (`repository`, `base`), `check_change` (the change's id) and `prepare_change` in the crewmate's tools ([`../src/core/pi/crewTools.ts`](../src/core/pi/crewTools.ts)), and a review commissioned with `spawn_crewmate review_of`.

## Operations and lifecycle

A change comes into being when its task first carries one - work on a project the app manages, on a branch of its own, not building in place and not raised by the host on another task's change, while the task is open - and `TaskStore` projects it again on every write that can move it.
Each head the project's host saw makes one version, in order: a check read, an owned merge review, a published story, a merge click and the repairs it was carried to, a completion offer, or an override given for one version.
A review, a reading of the working copy or a story prepared at a head the host has not seen pushed makes no version; they attach once it is pushed.
A version once recorded stays, dated when the host first saw it; a reading of the checks replaces the last whole, a review replaces the last whole, and the consent's click, carried approval and override each follow their own newest fact.
A fact the task no longer names is kept, never erased, so the record accumulates what the delivery facts forget.
The receipt closes it with the task's closed reason once the change is merged, discarded or closed.
A task's hard delete takes its change; a project removed keeps what its changes recorded.
In this piece the record is still a projection: the delivery fields stay their writers' and readers' slot, and the change record keeps no second source (INF-1868 piece 5); dropping those fields waits for readers that read the change first.

## Authority

A change holds facts, never permission: consent at a version is the captain's click on a card, an approval carried to a repaired version by a declared repair, or an override given for that version alone, and an override given for the whole task sits on the change ([delivery rigor](../docs/delivery-rigor.md), "The record and its holds").
The host's holds read the record's typed facts - the checks, a kept approval's version, consent for an effect - and never the care's name.
What a care asks of the crew - Default's procedure, Careful's review and live proof - is served guidance, and the host neither orders nor refuses by it (the captain, INF-1868: "the host only knows the three names as typed fact - a metadata").
A reading of a referenced pull request writes into the same slot, and an approval of it is consent to merge that pull request, never this change; the record binds every fact by the pull request's number, never by its head.

## Compositions

- Tasks carry a change and inherit its project; a review is a task the host raises on a change at a version ([tasks.md](tasks.md)).
- Projects and working copies supply where the change lives and its delivery posture ([projects-and-working-copies.md](projects-and-working-copies.md)).
- Cards and consent: the completion decision offers one version, and the captain's click is consent at that version ([cards-and-consent.md](cards-and-consent.md)).
- The forge seam reads the checks and opens, publishes and merges the change ([the forge seam](../docs/forge.md)).
- The served guidance that judges the change: the delivery judgment and the care sections, selected by the task's typed facts ([runbooks](../docs/runbooks.md)).

## Failure and recovery

A database without the tables reads as no change (`ChangeStore.exists`), so migration tests on an older schema change nothing.
A reading or a version override an older release saved before its writer stamped it is this change's only in a slot that records no referenced pull request; in one that does, the host cannot tell whose it was, and the record leaves it out ([saved-data compatibility](../docs/saved-data-compatibility.md), "The change record").
A version the host has not seen pushed carries nothing until it is; a reviewer's pass at an unpushed head waits on the record for the push.

## Uses

- Every direct-pr task's pull request, its checks, its story and its merge.
- A requested merge of another pull request, read into the same slot as a referenced pull request ([the forge seam](../docs/forge.md), "A requested merge").
- The attestation a github.com story carries when a review passed and live proof was accepted at its version.

## Checks

- [`../src/core/tasks/changeRecords.test.ts`](../src/core/tasks/changeRecords.test.ts): the projection, the versions, the binding by number and the receipt.
- [`../src/core/tasks/taskDeliveryRecords.test.ts`](../src/core/tasks/taskDeliveryRecords.test.ts): the delivery facts the record is read from.
- [`../src/core/orchestrator/prCi.test.ts`](../src/core/orchestrator/prCi.test.ts): the readings, the story and the attestation at a version.
- [`../tests/holds.test.ts`](../tests/holds.test.ts) and `scripts/holds.ts`: every hold the host places reads a typed fact, none the care's name.

## Where the detail lives

- [The task record](../docs/task-record.md): "A task's change", "A task's change evidence and permissions".
- [The forge seam](../docs/forge.md): "Check facts and crew judgment", "Saved change stories", "A requested merge", "No-mistakes' attestation".
- [Delivery rigor](../docs/delivery-rigor.md): "The three care names", "The review", "The record and its holds", "The holds".
- [Runbooks](../docs/runbooks.md): the delivery judgment and the Care levels runbook.
