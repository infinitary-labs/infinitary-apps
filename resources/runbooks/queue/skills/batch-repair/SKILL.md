---
name: batch-repair
description: Repair a held batch of the captain's approved changes - account for every failed test against every change in the batch, then send back the changes at fault, fix forward, or run the failed checks again for a flake that still gets an owner. Read before repairing a held batch.
---

# Repairing a held batch

A project that merges approved changes together combines the captain's approved changes into one batch pull request, one commit for each change, in the order they were approved.
When the batch's checks fail, the batch holds: nothing in it merges, and changes approved meanwhile wait in line behind it.
Your brief names the batch's pull request and the version that failed.
The app runs no check again and files no issue, label or claim: this task is the repair.

## Account for every failure first

1. Read the batch's failed checks and their logs: `read_workflow` for a run, its jobs and a job's log, and `github_read` for the pull request, its commits and its files.
2. List every failed test, not only the first one a log shows.
3. List every change in the batch from the pull request's commits: one commit for each change, in order.
4. Check every failed test against every change: which changes touch the test, the code it exercises, or what that code depends on.
   One clear cause does not clear the other changes: finish the accounting before you answer.
5. Check each failure against the default branch the batch was combined onto: a test that already fails there is not the batch's.

Never run a check again to see whether it passes before this accounting is done.

## Then answer it once

- **Send back.** When one or several changes cause the failures, send them back with `check_change` `batch.sendBack`: each change's task key, and the reason its crewmate reads, saying what its change broke.
  Each loses its approval and its own crewmate repairs it; the rest combine again with the changes that waited in line, and the checks run again.
  Name every change at fault in one declaration, so the batch is combined once.
- **Fix forward.** When the failure is in how the changes meet, or the fix is small and clearly right, make the fix this task's own change and declare it with `check_change` `batch.fix`.
  Push it, confirm its story with `open_change` and show its merge card as for any change: once approved, it joins the held batch and ends the hold.
- **Run the failed checks again, for a flake.** Only when the accounting shows that no change in the batch caused the failure and the evidence shows it is intermittent.
  Run the failed checks again where the project lives with `github_write`, recording the judgment first with `check_change` `rerun`: on GitHub, `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`; on GitLab, `POST /projects/{id}/jobs/{job_id}/retry`.
  Once they pass, the batch merges by itself.
  A flake still gets an owner: name the flaky test, its evidence and its owner (the app, the test or the runner) in your report, and file it with `file_followup` unless a task already owns it.
  Do not add retries or sleeps, or weaken, skip or delete a test to make the batch pass.

`batch.evidence` says how the accounting came out, in a sentence or two.
When you cannot establish the cause, keep the hold, report the failed checks, the accounting so far and what is missing, and ask the first mate to coordinate what you cannot run.
The captain may answer the hold too, from Settings, with Try again or Send back with a reason: when the batch is no longer held at the version your brief names, read it again before answering.
