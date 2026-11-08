---
name: queue-setup
description: Plan and build the fix-forward queue Infinitary ships for batched pull requests in a project - the plan card where the captain chooses which checks the batch runs, the stamped files to copy, the project's own batch checks file, and an update to a newer queue. Read before planning or building a project's queue.
---

# Setting up the shipped queue

Batched pull requests merge only once the project's queue passes the approved version.
Infinitary ships that queue: a few files it writes into the project, stamped with the queue's version, which run in the project's own CI.
Every teammate's Infinitary reads the same queue there, so the project is batched for all of them once the queue is on the default branch.

## What the queue does

1. An approver's merge click in Infinitary marks the approved version with the status `infinitary/queue`, waiting.
2. The queue gathers every waiting change that targets the default branch, in approval order, and composes them onto it.
3. It runs the project's batch checks on that one composed batch.
4. Green passes every change, and each approver's Infinitary merges its own.
5. Red first confirms: the queue calls the batch checks once more on the same batch, told which jobs and test files failed.
   A green confirm passes every change, so one flaky test does not hold the batch.
6. A red confirm, or a failure whose log named no test file, pauses every change behind one issue labelled `infinitary-queue-paused`, and no change is blamed.
7. A change labelled `infinitary-queue-fix` ends the pause once it is approved, and the next batch takes the paused changes, the waiting ones and the fix.
8. A resume or a send-back by hand, with a reason, also ends it.

## Planning it

A planning task is read-only: it shows the plan on a card and builds nothing.

1. Read the project's CI files and how its pull request checks run now, on the default branch.
2. List the checks the batch could run: each existing workflow or job, what it covers, and about how long it takes.
3. Show the plan on one decision card, drawn, with the captain's choices as questions on the card:
   - which checks the batch runs, one checkbox each, with the ones that cover what merges together recommended;
   - how the confirm stays short: each check is its own job, so the confirm runs only the jobs that failed, and where the project's test runner can run named files, one small job runs only the failed files instead;
   - anything those checks need changed to run on a composed batch, such as a longer timeout or a different runner;
   - each secret a chosen check needs, named one by one: the batch gets no secret the team did not name here;
   - each write a chosen check needs where the project lives, such as publishing a package, named with the permission it takes: the batch gets no write the team did not name here, and a write the batch gets could also mark its own batch passed, so the card says that beside each one;
   - whether the project's branch rule should require the `infinitary/queue` status, which keeps a merge outside Infinitary from skipping the batch.
4. Say on the card what the captain's team will notice: approvals wait for the batch, and a red batch pauses everyone's changes until a fix.
5. Leave room for feedback: revise the same card when the captain replies, and keep their answers on the next revision.
6. The captain's Approve and build starts the build; a planning task never edits the project itself.

## Building it

1. Copy each stamped file in this skill's `github/` folder, byte for byte, to the path `github/files.md` names; never edit a stamped file beyond the team's grants in step 3.
2. Write the project's own `.github/workflows/infinitary-batch-checks.yml` from the plan's chosen checks.
   It runs `on: workflow_call` with three string inputs, `batch`, `base` and `tree`, and each job checks out the batch in place of its own checkout:

   ```yaml
   steps:
     - uses: actions/checkout@v4
       with:
         fetch-depth: 0
     - uses: ./.github/actions/infinitary-batch
       with:
         batch: ${{ inputs.batch }}
         base: ${{ inputs.base }}
         tree: ${{ inputs.tree }}
     # then the check's own steps
   ```

   Reuse the project's existing check jobs: move their steps into this file, or make the existing workflow callable and call it from here, as the plan chose.
3. Make the confirm cheap. The file also declares two optional string inputs, `failed_jobs` (the failed jobs' names, one a line) and `failed_files` (the failed test files, separated by spaces), each with `default: ""`; GitHub refuses the queue's call to a file that does not declare them.
   Both are empty in the batch's own run, and the queue fills them only in its confirm.
   Give each job a condition, so the confirm runs only what failed:

   ```yaml
   if: inputs.failed_jobs == '' || contains(inputs.failed_jobs, 'Unit tests')
   ```

   Where the test runner can run named files, the plan may add one job that runs only in the confirm (`if: inputs.failed_jobs != ''`) and runs `failed_files` a few rounds, while every other job skips itself (`if: inputs.failed_jobs == ''`).
   The queue reads failed files from Vitest, Jest and Playwright output; a check on another runner is confirmed by its job alone.
   A file with no conditions still works: its confirm runs every check again.
4. As copied, the queue file gives the batch checks a read of the project and nothing else, and a called workflow can only narrow what its caller grants, never ask for more.
   The team's grants are the one edit a project makes to a stamped file, the same in the queue file's `checks` and `confirm` jobs, where its comments mark them:
   - each secret the plan named is passed there by name, `NAME: ${{ secrets.NAME }}` under `secrets:`, stored as a repository or organization secret, and declared under `on.workflow_call.secrets` in the batch checks file;
   - each write the plan named is added under that job's `permissions:`, and the batch checks file's job that needs it asks for it too.
   GitHub hands a called workflow only the secrets its caller passes: a secret not passed there reaches no batch check, even one kept in an environment the check's job names, and `secrets: inherit` would pass every secret, so the queue never uses it.
5. The queue opens one issue for each pause, so the project keeps Issues turned on; check it before building, and say on the plan card if it is off.
6. Ship it the way the project's changes go now: its pull request never waits on a queue that exists only inside it.
7. A branch rule that requires `infinitary/queue` is the captain's to add after the queue merges; name it as a required action when the plan chose it.

## Updating it

When Infinitary's queue is newer than a project's stamp, copy the newer stamped files over the old ones, carry the team's grants in the queue file's `checks` job over unchanged, into its `confirm` job too, and say in the pull request which version it moves to.
A batch checks file that does not declare `failed_jobs` and `failed_files` yet gets them in the same pull request, with the job conditions of "Make the confirm cheap"; change nothing else.
A project whose own workflow already answers `infinitary/queue` keeps working; replacing it is the same build, plus removing the old workflow once the plan says what it checked.
