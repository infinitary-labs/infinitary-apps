# A journeys request replaced by a newer one

`replaced-run.json` projects GitHub's answers for two identical `journeys.yml` requests on one task branch, which `tests/workflow-request-groups.test.ts` replays against the workflow's own replacement job.
Both requests named the same twenty-one journeys on both platforms, the selection whose concurrency group of 461 characters had failed an earlier request at creation.
`inputs` is the `inputs` context both runs' first job logged; GitHub left the unset `mac_runner` out of it.
The older request is run [42981277717](https://github.com/infinitary-labs/infinitary/actions/runs/42981277717), attempt 1, which started, marked itself with artifact `13836934646` and placed its Linux and Mac jobs.
The newer request is run [42981591991](https://github.com/infinitary-labs/infinitary/actions/runs/42981591991), attempt 1, which marked itself with artifact `13837488240`, logged "Run 42981277717 requested this selection before run 42981591991; cancelling it." and cancelled the older run.
`marks` is the artifact list GitHub answered for that mark's name after both runs marked themselves, keeping each artifact's id, name, run id and branch.
`runs` is GitHub's reading of each run before the newer one replaced the older, keeping the id, status, attempt and branch; both were waiting for runners.
The test varies a run's status or attempt from these readings to cover a run that ended or is being rerun.
