# Checks allowed to fail

A check in a reading of a change's checks may carry `failureAllowed: true` beside the state `neutral`: it failed or was cancelled where its project allows it to fail, such as a GitLab job with `allow_failure`, and it holds nothing, as GitLab's own pipeline passes with it.
A GitLab job like that reads `neutral` instead of `failure` or `cancelled`, so it no longer reads red or holds the merge.
An older view ignores `failureAllowed` and shows the check as neutral.
A view on this change shows a reading from an older home's GitLab job allowed to fail, which reads `failure`, as failed; the home's own merge reads the checks again, so only the view's words differ.
