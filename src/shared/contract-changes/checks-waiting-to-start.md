# Checks waiting to be started

A check in a reading of a change's checks may carry `manual: true`: it waits for a person to start it, such as a GitLab manual job that blocks its pipeline, and it holds the change until someone does.
A finished `neutral` check without it, such as a report bot's GitHub check run, now counts as finished, as GitHub's required checks pass on success, skipped or neutral.
A GitLab manual job the project marks optional reads `skipped`, as GitLab leaves it out of the pipeline's status.
An older view ignores `manual` and shows a neutral check held, as before, so it may show a GitHub neutral check as held while this home reads it passed.
A view on this change shows a reading from an older home's GitLab manual job, which carries no `manual`, as finished; the home's own merge reads the checks again, so only the view's words differ.
