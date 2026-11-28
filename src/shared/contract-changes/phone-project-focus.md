# The phone's project focus on its messages

The phone's `inf:converse` and `inf:cards:reply` now carry `focusedProjectId` while the phone is focused on a project, as a window's do; at All projects they carry neither filter field.
A home now reads a phone's `focusedProjectId` as the phone's filter instead of dropping it.
An older home reads every phone message as every project, as before.
