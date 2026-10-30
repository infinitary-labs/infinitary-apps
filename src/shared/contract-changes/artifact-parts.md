# Artifact parts

A crewmate on a computer that runs work may list a workflow artifact's files and save only selected ones (docs/forge.md, "Workflow logs and artifacts").
`inf:work:download-artifact` adds three optional fields: `list`, `files` and `offset`.
`inf:working-copy:artifact` adds an optional `part`, twelve hexadecimal digits that name a selection's archive beside the whole one, `artifact-<id>-<part>.zip`.
A computer that runs work refuses a listing or a selection, sending nothing, when its home does not list this change, since an older home would drop the fields and save the whole archive.
A home refuses a selection, downloading nothing, for a computer that does not list this change, since an older computer would drop `part` and write the selection where the whole archive goes.
