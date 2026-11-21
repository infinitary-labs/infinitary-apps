# The Batches panel's read

The new request `inf:batches:list` answers each project on batched pull requests with its line, its open batch, the changes left out and the batches that ended in the last day (`batchesViewSchema`, `src/shared/batches.ts`).
A project's batch record adds the optional `finished`, the batches that merged or closed in the last day, and an open batch adds the optional `holds`, how many times it was held.
The new push `batch_checks` says the open batch's checks reading changed, and `runbooks_changed` says which runbooks are on may have changed.
A view from before never asks the new request and ignores the two pushes; a home from before refuses the request, and a view's Batches panel then reads as having nothing to show.
