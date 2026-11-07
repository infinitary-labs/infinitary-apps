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
2. Assign it to the signed-in account (`POST /repos/{owner}/{repo}/issues/{number}/assignees`).
3. Read its events (`GET /repos/{owner}/{repo}/issues/{number}/events`): the earliest `assigned` event keeps the claim.
4. If that earliest assignment is someone else's, remove your own assignment, report who holds it, and stop.

## Then answer it

Read the failed jobs' logs before judging; never rerun a check to see whether it passes.

- **Fix forward.** Open a pull request with the fix and label it `infinitary-queue-fix` before its merge card.
  Once its approver approves it, the queue ends the pause and the next batch takes every paused change, every waiting change and the fix.
  Say in the issue which pull request is the fix.
- **Send one change back.** When one change alone breaks the batch, start the queue's workflow by hand with `action` `send-back`, its number and a reason.
  That change fails with the reason, its own crew repairs it, and the rest resume.
- **Resume after a flake.** When the failure does not come from any change in the batch, file the flaky test's owner first, then start the queue's workflow by hand with `action` `resume` and a reason that names that owner.

Starting the workflow by hand is `POST /repos/{owner}/{repo}/actions/workflows/infinitary-queue.yml/dispatches` with `ref` the default branch and `inputs` `{ "action": ..., "number": ..., "reason": ... }`.
Each answer closes the issue with its reason.
