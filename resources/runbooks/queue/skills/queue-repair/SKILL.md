---
name: queue-repair
description: Repair a paused batch of the shipped queue - claim the pause's issue, read what failed, then fix forward, send one change back, or resume after a flake. Read before repairing a paused batch.
---

# Repairing a paused batch

A red batch pauses every change in it behind one open issue labelled `infinitary-queue-paused`.
The issue names the failed checks, the failed test files and the changes each one touches, and the paused changes.
Every teammate's Infinitary shows the pause, so the claim on the issue says who repairs it.

## Claim it first

1. Read the open issue labelled `infinitary-queue-paused`.
2. Assign it to the signed-in account.
   On GitHub, `POST /repos/{owner}/{repo}/issues/{number}/assignees`.
   On GitLab, `PUT /projects/{id}/issues/{iid}` with `assignee_ids` your user's id, from `GET /user`; GitLab's free plans keep one assignee, so this replaces any other.
3. Read who assigned it first: the earliest assignment keeps the claim.
   On GitHub, the earliest `assigned` event of `GET /repos/{owner}/{repo}/issues/{number}/events`.
   On GitLab, the earliest system note saying "assigned to" in `GET /projects/{id}/issues/{iid}/notes?sort=asc&order_by=created_at`.
4. If that earliest assignment is someone else's, take your own back off - on GitLab, set `assignee_ids` to theirs alone again - report who holds it, and stop.

## Then answer it

Read the failed jobs' logs before judging; never rerun a check to see whether it passes.
On GitHub, before it paused, the queue already ran what failed once more on the same batch, and it failed again, unless the issue says nothing ran again; so a failure that repeated there is most likely real, not a flake.
On GitLab the queue runs nothing again before it pauses, so read the logs for a flake as well.

- **Fix forward.** Open a pull request (on GitLab, a merge request) with the fix and label it `infinitary-queue-fix` before its merge card.
  Once its approver approves it, the queue ends the pause and the next batch takes every paused change, every waiting change and the fix.
  Say in the issue which pull request is the fix.
- **Send one change back.** When one change alone breaks the batch, start the queue's workflow by hand with `action` `send-back`, its number and a reason.
  That change fails with the reason, its own crew repairs it, and the rest resume.
  When the failure lands on a version that already holds the fix, that change's crewmate answers it with check_change, and the change goes back to waiting with no new version and no new click.
- **Resume after a flake.** When the failure does not come from any change in the batch, file the flaky test's owner first, then start the queue's workflow by hand with `action` `resume` and a reason that names that owner.

Starting the workflow by hand is `POST /repos/{owner}/{repo}/actions/workflows/infinitary-queue.yml/dispatches` with `ref` the default branch and `inputs` `{ "action": ..., "number": ..., "reason": ... }`.
On GitLab no pipeline takes an answer, so make the answer's writes yourself through GitLab's API, in this order, the same writes Settings makes:

1. For a send-back, fail that merge request's head: `POST /projects/{id}/statuses/{sha}` with `name` `infinitary/queue`, `state` `failed` and `description` `Sent back: ` and the reason, at most 140 characters.
2. Turn every other paused merge request back to waiting.
   A paused one is open and its head's newest `infinitary/queue` status reads `Paused after batch run` (`GET /projects/{id}/repository/commits/{sha}/statuses?name=infinitary/queue&all=true`).
   Post on its head `state` `skipped` and `description` `Waiting for the batch check`.
3. Post a note on the issue, `The queue was resumed by hand: ` or `!N was sent back by hand: ` and the reason, then close it with `PUT /projects/{id}/issues/{iid}` and `state_event` `close`.
4. Start the next batch: `POST /projects/{id}/pipeline` with `ref` the default branch.

Write `!N`, never `#N`, for a merge request in a status or a note.
Each answer closes the issue with its reason.
