# First-release reports

The optional `declared.firstRelease` on `inf:work:report` carries a verified earliest published release and its merged task keys, source-membership evidence and optional correction version.
The home records the same-project attributions together through the task owner, preserving existing first releases unless a correction names the previous version.
A newer work computer refuses this declaration before sending anything to a home that does not list `first-release-reports`; the crewmate reports that verification gap to the first mate.
An older work computer's ordinary reports are unchanged and carry no release attribution.
The crewmate's `inf:work:tasks.input.skip` pages task lists so release verification can collect every task key before writing attributions; a newer work computer refuses pagination against a home without this change rather than silently repeating the first page.
