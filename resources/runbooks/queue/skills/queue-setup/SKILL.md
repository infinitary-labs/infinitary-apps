---
name: queue-setup
description: Plan and build the fix-forward queue Infinitary ships for batched pull requests in a project on GitHub or GitLab - the plan card where the captain chooses which checks the batch runs, the stamped files to copy, the project's own batch checks file, the queue's key on GitLab, and an update to a newer queue. Read before planning or building a project's queue.
---

# Setting up the shipped queue

Batched pull requests merge only once the project's queue passes the approved version.
Infinitary ships that queue: a few files it writes into the project, stamped with the queue's version, which run in the project's own CI.
Every teammate's Infinitary reads the same queue there, so the project is batched for all of them once the queue is on the default branch.
The queue has a part for GitHub (this skill's `github/` folder) and one for GitLab (`gitlab/`), on gitlab.com and on a team's own GitLab server; a project on any other host is not offered it.
On GitLab a pull request is a merge request, named `!N`.

## What the queue does

1. An approver's merge click in Infinitary marks the approved version with the status `infinitary/queue`, waiting.
2. The queue gathers every waiting change that targets the default branch, in approval order, and composes them onto it.
3. It runs the project's batch checks on that one composed batch.
4. Green passes every change, and each approver's Infinitary merges its own.
5. On GitHub, red first confirms: the queue calls the batch checks once more on the same batch, told which jobs and test files failed.
   A green confirm passes every change, so one flaky test does not hold the batch.
6. On GitHub, a checks result other than success or failure, with no passing confirm, returns the changes to waiting and starts a fresh batch.
   If a member's preceding batch also returned no verdict, it pauses instead; successful jobs alone never pass a batch without its verdict.
7. A red confirm, a failure whose log named no test file, or a red batch on GitLab, which has no confirm yet, pauses every change behind one issue labelled `infinitary-queue-paused`, and no change is blamed.
8. A change labelled `infinitary-queue-fix` after the pause began ends it once it is approved, and the next batch takes the paused changes, the waiting ones and the fix.
   A label put on before the pause began, such as one left from an earlier pause, ends nothing.
9. A resume or a send-back by hand, with a reason, also ends it.
10. A successful send-back from a still-running batch that already has a failed check cancels that run and starts the next batch immediately with the remaining changes.
   On GitLab it cancels both the parent and its checks child pipeline.
   Without a failed check the run continues; failure alone also leaves it alone.

## Planning it

A planning task is read-only: it shows the plan on a card and builds nothing.

1. Read the project's CI files and how its pull request checks run now, on the default branch.
   On GitLab, also read whether the queue's key can be made, before planning anything else: the project's `permissions` must give the sign-in the Maintainer role or higher, and on gitlab.com the project's namespace (`GET /namespaces/<id>`) must name a `premium` or `ultimate` plan; a team's own GitLab server needs no plan.
   Without the key every approved change in a batched project waits forever, so when either fails the card says so first, names what the team needs, and offers no build until it is in place.
   When the plan cannot be read, the card says the key may be refused and the build makes the key before anything else.
2. List the checks the batch could run: each existing workflow or job, what it covers, and about how long it takes.
3. Show the plan on one decision card, drawn, with the captain's choices as questions on the card:
   - which checks the batch runs, one checkbox each, with the ones that cover what merges together recommended;
   - on GitHub, how the confirm stays short: each check is its own job, so the confirm runs only the jobs that failed, and where the project's test runner can run named files, one small job runs only the failed files instead;
   - anything those checks need changed to run on a composed batch, such as a longer timeout or a different runner;
   - each secret a chosen check needs, named one by one: on GitHub the batch gets no secret the team did not name here; on GitLab it sees every CI variable not scoped to another environment, so the card lists those too, says only a change a Maintainer marked or approved joins a batch, and asks which to scope away;
   - each write a chosen check needs where the project lives, such as publishing a package, named with the permission it takes: the batch gets no write the team did not name here, and a write the batch gets could also mark its own batch passed, so the card says that beside each one;
   - on GitHub, whether the project's branch rule should require the `infinitary/queue` status, which keeps a merge outside Infinitary from skipping the batch;
   - on GitLab, what the project's own pipeline gives up: its jobs leave out the queue's pipelines, and a merge made in GitLab itself is not held by the queue, since GitLab's free plans cannot require an outside status.
4. Say on the card what the captain's team will notice: approvals wait for the batch, and a red batch pauses everyone's changes until a fix.
5. Leave room for feedback: revise the same card when the captain replies, and keep their answers on the next revision.
6. The captain's Approve and build starts the build; a planning task never edits the project itself.

## Building it on GitHub

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

## Building it on GitLab

GitLab starts a pipeline for nothing the queue writes, and gives a pipeline no key that may write a commit status.
So Infinitary starts each queue pipeline itself, through GitLab's API on the default branch, and the queue's jobs write with a project access token Infinitary keeps in the project's CI settings.

1. Copy each stamped file in this skill's `gitlab/` folder, byte for byte, to the path `gitlab/files.md` names; never edit a stamped file.
2. In the project's own `.gitlab-ci.yml` (or the CI file its settings name):
   - include the queue: `include: - local: .gitlab/infinitary-queue.yml`;
   - add the stage `infinitary-queue` to its `stages:` list, after its own;
   - leave the queue's pipelines out of every job of its own, with a rule such as `- if: $CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` and `when: never` first in each job's `rules:`, or in `workflow: rules:` only where it still lets that pipeline run for the queue's jobs;
   - check that no `workflow: rules:` stops a pipeline the API starts on the default branch, or the queue never runs.
3. Write the project's own `.gitlab/infinitary-batch-checks.yml` from the plan's chosen checks.
   It runs as the queue's child pipeline, and each job checks out the batch in place of its own checkout by extending the queue's template:

   ```yaml
   unit:
     extends: .infinitary-batch
     script:
       - npm ci
       - npm test
   ```

   A job with a `before_script:` of its own starts it with `- !reference [.infinitary-batch, before_script]`.
   Reuse the project's existing check jobs: copy their scripts into this file, as the plan chose.
4. The batch gets no write of the queue: the queue's key reaches only the queue's own jobs, which name the `infinitary-queue` environment.
   Never name the `infinitary-queue` environment in a batch check, which would hand it the queue's key.
   The batch does run on the protected default branch, so its jobs receive every CI variable not scoped to another environment, protected ones included, not only the secrets the plan named.
   The queue takes a version into a batch only once a Maintainer marked that version or approved the merge request after it was pushed, so only code a Maintainer let in reaches those variables; the plan card names the project's variables the batch will see, and a secret no batch should see is scoped to an environment of its own.
5. The queue's key needs the default branch protected, since its variable is protected; GitLab protects the default branch unless someone turned it off.
6. The queue opens one issue for each pause, so the project keeps Issues turned on; check it before building, and say on the plan card if it is off.
7. Ship it the way the project's changes go now: its merge request never waits on a queue that exists only inside it.
8. Name the queue's key as a required action for the captain: after the queue merges, Settings, Projects shows "Make the queue's key" under the project's "Where changes go", one click with their own sign-in.
   Making it needs the Maintainer role on the project, and on gitlab.com a Premium or Ultimate plan; a team's own GitLab server needs no plan.
   Until it exists, every queue job fails at its start, saying the key is missing.

## Updating it

When Infinitary's queue is newer than a project's stamp, copy the newer stamped files over the old ones, carry the team's grants in the queue file's `checks` job over unchanged, into its `confirm` job too (GitHub), and say in the pull request which version it moves to.
A GitHub batch checks file that does not declare `failed_jobs` and `failed_files` yet gets them in the same pull request, with the job conditions of "Make the confirm cheap"; change nothing else.
Each host's part has its own version, so a newer GitHub part leaves a GitLab project's stamp as it is, and the other way round.
A project whose own workflow already answers `infinitary/queue` keeps working; replacing it is the same build, plus removing the old workflow once the plan says what it checked.
