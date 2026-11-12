# Changes

A change is the host's typed record of one unit of work offered to a project: where it is, its handle where the project's host keeps one, who raised it, each version pushed with the facts the host held at it, and its receipt once merged or closed.

## Intended use

Record every change a task carries as one record with a stable id, so the pull request, its checks, its reviews, its story, the consent given and the merge are facts about the change at a version rather than fields scattered over the task.
A task carries one change on its own branch and one for every other pull request it names, whoever opened it (INF-2490): one change per pull request.
A fork may use the same branch name as the task; its source and request number keep the review, checks and story separate.
Surfaces show the current pull request; the task record's Info tab and its `pullRequests` list name every one with its own checks, and which merge closes the task.
Each change keeps its own saved story, so a story on one pull request never blocks another's.
Give each version pushed its own row in the order the host saw it, holding the checks read, the review verdict declared with its findings and its reading, the story prepared and published, and the consent given there.
Let the tools, the merge card and a review name the change by its id, and let every surface read what the host knows about it from the record ([the task record](../docs/task-record.md), "A task's change").

## When to use it, and when not

Use the change whenever a feature needs a fact about a pushed version: a check reading, a verdict, a story, a consent or a receipt.
Do not put a judgment in it: every value is a fact the host held or was told, and the crew's readiness, flake, settlement and stopping judgments stay in the delivery guidance (`resources/runbooks/delivery`), what each care asks in the care guidance (`resources/runbooks/care`).
Do not keep a second copy of a version's facts on a card, a feed line or a feature's own row; read the change.
Do not make the host enforce a care through it: the care is a name on the task's policies, the review and live validation Careful's guidance orders are recorded here when they happen, and the host reads them only to attest a pull request ([the forge seam](../docs/forge.md), "No-mistakes' attestation").
Work that ships nothing - an answer, a review the host raised, work in the personal workspace - carries no change.

## Owner and entry points

- The record: `ChangeStore` in [`../src/core/storage/changeStore.ts`](../src/core/storage/changeStore.ts) (`get`, `forTask`, `allForTask`, `list`, `project`, `deleteFor`, `deleteAll`), written only by `TaskStore` beneath `TaskService`.
- Its shape: `changeRecordSchema`, `changeVersionSchema`, `changeChecksSchema`, `changeReviewSchema`, `changeStorySchema`, `changeConsentSchema` and `changeReceiptSchema` in [`../src/shared/change.ts`](../src/shared/change.ts), published in `docs/contract.json`.
- The projection from a task's record: `projectChange`, `projectOtherChange`, `otherChangeNumbers`, `carriesChange` and `isHostRaisedShape` in [`../src/core/storage/changeProjection.ts`](../src/core/storage/changeProjection.ts).
- Reading it: `TaskService.changeFor` over `changes.forTask` for a task's own change, `TaskService.changesFor` over `changes.allForTask` for every change it names, and `CardService` over `changes.get` for the card that offers a version.
- Naming it: `open_change` (`repository`, `base`, `branch`), `check_change` (`pull`, or one of the task's change ids), `prepare_change` and `show_merge_card` in the crewmate's tools ([`../src/core/pi/crewTools.ts`](../src/core/pi/crewTools.ts)), and a review commissioned with `spawn_crewmate review_of`.
- Which change is current: the task's own, or the one `delivery.checkTarget` selects, which `check_change pull`, a named change id, a successful `open_change` (its `branch`, or the checked-out branch when it names none), a saved-story merge card for the checked-out branch's change and the captain's click on a merge card naming a review set.

## Operations and lifecycle

A change comes into being when its task first carries one - work on a project the app manages, on a branch of its own, not building in place and not raised by the host on another task's change, while the task is open - and `TaskStore` projects it again on every write that can move it.
Another pull request's change comes into being when the task first names it, by a review, a selection or an approval of it on another branch.
One the task opened in another project the app manages is that project's change: its review names the project (`MergeReview.repoId`), and the record keeps it under that project's id (INF-2510; [the forge seam](../docs/forge.md), "A change in another project").
Each head the project's host saw makes one version, in order: a check read, an owned merge review, a published story, a merge click and the repairs it was carried to, a merge card, or an override given for one version.
A plain branch's confirmed story and a local story's committed-head completion binding also make a version, without inventing a hosted request or upload.
A review, a reading of the working copy or an unbound prepared story makes no version; they attach once its head is observed.
A version once recorded stays, dated when the host first saw it; a reading of the checks replaces the last whole, a review replaces the last whole, and the consent's click, carried approval and override each follow their own newest fact.
A fact the task no longer names is kept, never erased, so the record accumulates what the delivery facts forget.
The receipt closes it with the task's closed reason once the change is merged, discarded or closed, and the task's close reaches only the current change.
Every change takes a merged receipt from its own merge on the record, never from the task's close.
A task's hard delete takes its change; a project removed keeps what its changes recorded.
In this piece the record is still a projection: the delivery fields stay their writers' and readers' slot, and the change record keeps no second source (INF-1868 piece 5); dropping those fields waits for readers that read the change first.

A merge card names one change.
Its merge effect's `after` says what follows (INF-2744): `close` is a finishing merge, which closes the task once nothing else on it is open; `continue` keeps the task open and its crewmate hears the outcome once.
A task may have several merge cards up at once, one per pull request.
The host writes on each merge card which it is (`mergeClosesLine`, [`../src/shared/cards.ts`](../src/shared/cards.ts)), from the card's own actions.
A merge made elsewhere closes the task as merged when the crewmate's open merge card for it declared `after: close` and nothing is left, or when the first mate settles it and none of the task's pull requests is still open ([the forge seam](../docs/forge.md), "A requested merge").

## Authority

An outgoing contribution's saved story is a note without merge actions, while the existing change watcher follows the upstream maintainers' activity and confirmed outcome ([the forge seam](../docs/forge.md), "Contributing through an owned fork").
Its fork route is a project choice captured on the task, never permission to merge upstream or mark its queue.
A change holds facts, never permission: consent at a version is the captain's click on a card, an approval carried to a repaired version by a declared repair, or an override given for that version alone, and an override given for the whole task sits on the change ([delivery rigor](../docs/delivery-rigor.md), "The record and its holds").
The host's holds read the record's typed facts - the checks, a kept approval's version, consent for an effect - and never the care's name.
What a care asks of the crew - Default's procedure, Careful's review and live proof - is served guidance, and the host neither orders nor refuses by it (the captain, INF-1868: "the host only knows the three names as typed fact - a metadata").
A reading of another branch's pull request writes into the same slot, and an approval of it is consent to merge that pull request, never another change; the record binds every fact to the change of the pull request it names, by its number, never by its head.

## Compositions

- Tasks carry a change and inherit its project; a review is a task the host raises on a change at a version ([tasks.md](tasks.md)).
- Projects and working copies supply where the change lives and its delivery posture ([projects-and-working-copies.md](projects-and-working-copies.md)).
- Cards and consent: the merge card offers one version, and the captain's click is consent at that version ([cards-and-consent.md](cards-and-consent.md)).
- The forge seam reads the checks and opens, publishes and merges the change ([the forge seam](../docs/forge.md)).
- The served guidance that judges the change: the delivery judgment and the care sections, selected by the task's typed facts ([runbooks](../docs/runbooks.md)).

## Failure and recovery

A database without the tables reads as no change (`ChangeStore.exists`), so migration tests on an older schema change nothing.
A reading or a version override an older release saved before its writer stamped it is the task's own change's only in a slot that records no other branch's pull request; in one that does, the host cannot tell whose it was, and the record leaves it out ([saved-data compatibility](../docs/saved-data-compatibility.md), "The change record").
A remote version the host has not seen pushed carries nothing until it is; a reviewer's pass at an unpushed remote head waits on the record for the push.

## Uses

- Every direct-pr task's pull request, its checks, its story and its merge.
- A requested merge of any pull request the task names, a change of its own ([the forge seam](../docs/forge.md), "A requested merge").
- The attestation a github.com story carries when a review passed and live proof was accepted at its version.
- The merge line on the story note of a task that merges on its own, and when that held note shows: the card stack draws both from the change's receipt, which keeps the merge's time even when the task stays open ([card authoring](../docs/card-authoring.md), "Work that closed without the captain's click").

## Checks

- [`../src/core/tasks/changeRecords.test.ts`](../src/core/tasks/changeRecords.test.ts): the projection, the versions, the binding by number and the receipt.
- [`../src/core/tasks/taskDeliveryRecords.test.ts`](../src/core/tasks/taskDeliveryRecords.test.ts): the delivery facts the record is read from.
- [`../src/core/orchestrator/changeChecks.test.ts`](../src/core/orchestrator/changeChecks.test.ts): the readings, the check watch's side of them and the change a reading names.
- [`../src/core/orchestrator/changePublication.test.ts`](../src/core/orchestrator/changePublication.test.ts) and [`../src/core/orchestrator/changePublication.stories.test.ts`](../src/core/orchestrator/changePublication.stories.test.ts): opening a change, the story and the attestation at a version.
- [`../src/core/orchestrator/mergeReviews.test.ts`](../src/core/orchestrator/mergeReviews.test.ts): a review of a pull request named by its number, a merge past the branch rules, and the captain's click on either.
- [`../src/core/orchestrator/changeMerge.test.ts`](../src/core/orchestrator/changeMerge.test.ts): the merge and its checks at the put-in, what a kept merge stops on, a lost answer read back before anything is sent again, and a project's queue answering a review's click.
- [`../tests/holds.test.ts`](../tests/holds.test.ts) and `scripts/holds.ts`: every hold the host places reads a typed fact, none the care's name.

## Where the detail lives

- [The task record](../docs/task-record.md): "A task's change", "A task's change evidence and permissions".
- [The forge seam](../docs/forge.md): "Check facts and crew judgment", "Saved change stories", "A requested merge", "No-mistakes' attestation".
- [Delivery rigor](../docs/delivery-rigor.md): "The three care names", "The review", "The record and its holds", "The holds".
- [Runbooks](../docs/runbooks.md): the delivery judgment and the Rigor levels runbook.
