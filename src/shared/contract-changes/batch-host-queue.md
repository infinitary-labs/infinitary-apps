Adds an optional `queued` field to a project's open batch: the version of the batch that the host's own merge queue took, which the host merges or removes later.
A side without the change sends no `queued` field and ignores one, so it shows such a batch as one whose checks have not passed yet.
