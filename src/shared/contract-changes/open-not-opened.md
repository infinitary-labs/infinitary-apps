`inf:session:open` takes an optional `notOpened` in its spec: an open that fails having left no new conversation on the computer answers `notOpened` with why, and no `state`, instead of failing.
Any other failure still fails, so the home knows a refusal it reads in `notOpened` opened nothing there.
A home sends it only to a computer that lists this change, and passes a model and account over only on that answer (docs/helper.md, "A model that left every level").
An older computer ignores it and fails as before, and the home reads that failure as an open that may have left a conversation there.
