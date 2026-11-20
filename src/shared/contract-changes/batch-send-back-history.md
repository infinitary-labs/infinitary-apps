A project's batch record keeps every send-back of an open task's change (`sentBack`), and a held batch keeps the checks that never ran to an end at its version (`hold.notRun`).
Both are new optional fields.
A record without `sentBack` has no send-backs; a hold or a send-back without `notRun` does not say which checks never ran, which is not the same as none.
