A home answers a paired view the captain's panels: the request `inf:plugins:files` is new, and answers one panel's built files with the version of the app they were built for, or null for a panel the home does not serve at exactly that version.
The ten panel requests `inf:plugins:personal:list`, `inf:plugins:personal:mounts`, `inf:plugins:invoke`, `inf:plugins:db`, `inf:plugins:fetch`, `inf:plugins:integrations`, `inf:plugins:retry`, `inf:plugins:update`, `inf:plugins:ask-again` and `inf:sql:query` now have `reach` `views`.
A view shows the pushes those follow: `inf:plugins:personal` and `inf:plugins:db`, which every home already sends it, and reads the home's panels switch from `inf:shell:preferences`.
A home answers a view no panel being built, and keeps only its own computer's window's word on where each panel was drawn.
A home without this change refuses those requests from a view, as before, and a view that knows its home does not list this change shows no panel of the captain's.
