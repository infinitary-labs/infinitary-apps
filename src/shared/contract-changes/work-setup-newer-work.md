# A Mac's window reports newer saved work and a copy that was gone

A Mac's window may report its work half blocked with the new reason `newer-work`: a newer Infinitary saved the work there, which the app there cannot read and leaves as it is (`workSetupReasonSchema`, `src/shared/workSetup.ts`).
A report may also carry `copyGone: true`: the copy of the app the work folder recorded was no longer there, so its background now starts the app that checked.
A window sends either only to a home that lists this change; to a home from before it sends `newer-work` as `not-reached` and leaves `copyGone` out.
A view from before reads `newer-work` on a device as `not-reached`, as it reads any reason it does not know.
