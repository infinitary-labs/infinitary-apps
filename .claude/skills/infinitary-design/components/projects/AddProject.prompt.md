Settings → Projects' one list box ends with an Add project row, in the Add account foot shape, with the projects folder's line under it (`ProjectsFolder`): a wrapping row of small secondary pill Buttons with a plus, “Folder on this computer”, one “{host name} repo” per ForgesView.hosts, then “New project”.
No host or sign-in is required.
The personal workspace is never a choice.
The row ends with a labeled "Task key" field, pushed to the right and wrapping with the pills: a mono Input the height of a small Button, just wide enough for its placeholder "From its name".
It keeps only letters and digits, in capitals, at most four, and the next project added from this row - folder, repo or new project - takes it.
While it holds a key, a quiet line under the row says "Tasks in the next project you add are numbered INF-1, INF-2 and so on."
An added project empties it; a refusal, such as a key another project has, keeps it for correcting, and typing in it again clears the refusal.

Folder opens the system picker immediately, links in place and opens the resulting project accordion.
A plain folder is initialized and the quiet status below says so.
Duplicate additions open the existing row.
Repo and New project buttons reveal forms below the same row, separated by a hairline; switching forms clears refusal/status.
Forms use labeled Input and small Buttons, never a modal: a modal is for consent alone (`components/core/ConsentDialog.prompt.md`).
A ghost Close hides the form without cancelling an addition.

A signed-in host lists “Your {host name} repos”, newest first, with “Find a repo” and an Add button per row (or “added” for existing projects).
Below: “Or paste a {host name} link”.
Without sign-in, the host selector offers a small secondary Sign in to <host> button above the link field; it opens Integrations with that host's form ready.
Link accepts only this host; other hosts are added by asking the first mate.
New project has Name and Start project.
A quiet line names the projects folder and says new projects merge on this computer.
Pending additions say “Adding...”; refusal and success are polite live text under the control.
Settings may close while setup continues.
Adding never wakes the first mate.
