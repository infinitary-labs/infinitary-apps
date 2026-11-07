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
5. Red pauses every change behind one issue labelled `infinitary-queue-paused`: nothing runs again and no change is blamed.
6. A change labelled `infinitary-queue-fix` ends the pause once it is approved, and the next batch takes the paused changes, the waiting ones and the fix.
7. A resume or a send-back by hand, with a reason, also ends it.

## Planning it

A planning task is read-only: it shows the plan on a card and builds nothing.

1. Read the project's CI files and how its pull request checks run now, on the default branch.
2. List the checks the batch could run: each existing workflow or job, what it covers, and about how long it takes.
3. Show the plan on one decision card, drawn, with the captain's choices as questions on the card:
   - which checks the batch runs, one checkbox each, with the ones that cover what merges together recommended;
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
3. As copied, the queue file gives the batch checks a read of the project and nothing else, and a called workflow can only narrow what its caller grants, never ask for more.
   The team's grants are the one edit a project makes to a stamped file, in the queue file's `checks` job, where its comment marks them:
   - each secret the plan named is passed there by name, `NAME: ${{ secrets.NAME }}` under `secrets:`, stored as a repository or organization secret, and declared under `on.workflow_call.secrets` in the batch checks file;
   - each write the plan named is added under that job's `permissions:`, and the batch checks file's job that needs it asks for it too.
   GitHub hands a called workflow only the secrets its caller passes: a secret not passed there reaches no batch check, even one kept in an environment the check's job names, and `secrets: inherit` would pass every secret, so the queue never uses it.
4. The queue opens one issue for each pause, so the project keeps Issues turned on; check it before building, and say on the plan card if it is off.
5. Ship it the way the project's changes go now: its pull request never waits on a queue that exists only inside it.
6. A branch rule that requires `infinitary/queue` is the captain's to add after the queue merges; name it as a required action when the plan chose it.

## Updating it

When Infinitary's queue is newer than a project's stamp, copy the newer stamped files over the old ones, carry the team's grants in the queue file's `checks` job over unchanged, change nothing else, and say in the pull request which version it moves to.
A project whose own workflow already answers `infinitary/queue` keeps working; replacing it is the same build, plus removing the old workflow once the plan says what it checked.
