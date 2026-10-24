# Project focus

The saved layout gains an optional `focusedProjectId`: the project the window is focused on (`docs/project-focus.md`).
A turn (`inf:converse`) gains an optional `focusedProjectId`, which the home's first mate reads as a hint for where new work belongs.
An older home strips the turn's field, so its first mate gets no hint, and drops the layout's field, so the focus is not kept across a restart.
An older view sends neither, so its turns carry no hint.
