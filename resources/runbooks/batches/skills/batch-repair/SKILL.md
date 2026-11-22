---
name: batch-repair
description: Repair a held batch of the captain's approved changes - account for every failed test against every change in the batch, then send back the changes at fault, fix forward, merge a version that passed on a rerun, or run the failed checks again for a flake that still gets an owner. Read before repairing a held batch.
---

# Repairing a held batch

A project that merges approved changes together combines the captain's approved changes into one batch pull request, one commit for each change, in the order they were approved.
When the batch's checks fail, the batch holds: nothing in it merges, and changes approved meanwhile wait in line behind it.
Your brief names the batch's pull request and the version that failed.
The app runs no check again and files no issue, label or claim: this task is the repair.
The Batches panel and Settings name this task as the batch's repair and show your latest report's first sentence beside it, so make that sentence say, for the captain, what you found and what happens next, such as "The date parser change breaks two journeys; a fix is on its way."

## Account for every failure first

1. Read the batch's failed checks and their logs: `read_workflow` for a run, its jobs and a job's log, and `github_read` for the pull request, its commits and its files.
2. List every failed test, not only the first one a log shows.
3. List every change in the batch from the pull request's commits: one commit for each change, in order.
4. Check every failed test against every change: which changes touch the test, the code it exercises, or what that code depends on.
   One clear cause does not clear the other changes: finish the accounting before you answer.
5. Check each failure against the default branch the batch was combined onto: a test that already fails there is not the batch's.

Never run a check again to see whether it passes before this accounting is done.

## Then answer it once

Once the accounting has found the cause, fix forward by default, and send a change back only when the fix belongs with the change's own crewmate.
Choose by what the fix has to touch, not by which change caused the failure.

In these rules, the code under test is what makes the project do what a change says: the code it runs, builds or ships.
The tests, test data, generated files, check lists, pinned versions and comments around it are not.

- **Fix forward.** This is the default whenever the code under test is right and the fix is small and clearly right.
  - Changes that meet badly: each change passes alone and the failure is where they meet, such as a new rule or check that flags a file another change adds, a generated file left stale once the changes are combined, or an import one change moved that another still uses.
  - One change at fault whose code under test is right: it left tests, test data, a generated file, a check list, a pinned version or a comment out of date, such as a test that still expects words the change removes on purpose.
    Show from that change's own story, commit message or task that its new behavior is intended, and say so in your fix's story.
    If you cannot tell whether the test or the change is wrong, send the change back.
    Bringing what a test expects up to the intended behavior is a fix; weakening, skipping or deleting a test is not, so a change that needs one goes back.

  Make the fix this task's own change and declare it with `check_change` `batch.fix`.
  Build the fix on the batch's branch at the held version your brief names, not on the default branch, so it can change lines a change in the batch added or changed: the batch takes only the fix's own difference from that version, and each change keeps its own commit.
  Give that held version as your story's base, so the merge card shows only the fix.
  Keep every later version of the fix on top of that version, without rewriting the commits it carries: once its approval or the batch has measured the fix from it, a version that no longer builds on it is left out of the batch, and this repair stays measured from that version.
  A fix that must start again from the batch's newer version is a new repair's, not a rebuild of this one.
  A fix built on the default branch still joins when it touches nothing a change in the batch wrote.
  Push it, confirm its story with `open_change` and show its merge card as for any change: once approved, it joins the held batch with every change waiting in line behind it, and ends the hold.
  A change already approved at its current version joins as you declare it, with no new merge card.
- **Send back.** Only when a change at fault needs its code under test changed, when the fix needs a decision only its crewmate or the captain can make, or when the fix is not small.
  Send each such change back with `check_change` `batch.sendBack`: each change's task key, and the reason its crewmate reads, saying what its change broke.
  Each keeps the captain's approval and its own crewmate repairs it: a repair it declares unchanged goes back in line once its checks pass, and a changed one comes back to the captain on a new merge card.
  The rest combine again with the changes that waited in line, and the checks run again.
  Name every change at fault in one declaration, so the batch is combined once.
  In each reason, also name the batch's checks that were cancelled or never ran, so its crewmate proves those too before showing the change again.
  Before sending a change back, read its task for earlier send-backs: one already sent back for a collision is better fixed forward than sent round again.
- **Both at once.** When some changes must go back and the rest can be fixed forward, give `batch.sendBack` and `batch.fix` in the same declaration.
  The named changes leave, and the batch stays held at its version, combining nothing, until your fix is approved, even once every change has left it; then it is combined once, with the fix and every change waiting in line, without the changes sent back.
  Build that fix on the held version too: the batch takes only its own difference, never the work of a change sent back.
- **Merge the version that passed on a rerun.** When a rerun already passed every failed test on the held version, such as a step of the batch's own run that runs the failed tests again, or the failed checks run again where the project lives, the version merges as it is.
  Declare it with `check_change` `batch.passed`, naming the held version by its full commit id: the failed checks it held for are answered at that version, and the batch merges once every other check passed.
  A check that fails later, one you did not answer, holds it again.
  A fix that only changes tests, such as one for the flaky test that failed, does not hold the batch: declare it beside (`batch.fix` with `batch.passed`), or later as usual, and once approved it goes to the next batch with the changes waiting in line.
  Never beside `batch.sendBack`: the held version still carries the changes sent back.
  When a change's code under test must change, the version does not pass as it is, whatever a rerun said: fix forward or send it back.
- **Run the failed checks again, for a flake.** Only when the accounting shows that no change in the batch caused the failure and the evidence shows it is intermittent, and no rerun has passed them yet.
  Run the failed checks again where the project lives with `github_write`, recording the judgment first with `check_change` `rerun`: on GitHub, `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`; on GitLab, `POST /projects/{id}/jobs/{job_id}/retry`.
  Once they pass, the batch merges by itself, even when a fix of yours was approved meanwhile: that fix goes to the next batch.
  A flake still gets an owner: name the flaky test, its evidence and its owner (the app, the test or the runner) in your report, and file it with `file_followup` unless a task already owns it.
  Do not add retries or sleeps, or weaken, skip or delete a test to make the batch pass.

`batch.evidence` says how the accounting came out, in a sentence or two.
When you cannot establish the cause, keep the hold, report the failed checks, the accounting so far and what is missing, and ask the first mate to coordinate what you cannot run.
The captain may answer the hold too, from Settings, with Try again or Send back with a reason, and the first mate may try it again: when the batch is no longer held at the version your brief names, read it again before answering.
