# Check for updates

The local app accepts `inf:update:check`, which reads the release source for its own installation now, past the saved answer, and answers its update status.
A check that could not read the source answers the `error` phase with its problem, never "no update"; a successful one carries the result's notice on every copy.
An older client never asks it, and a controlling Mac answers it for its own installation rather than forwarding it to its home.
