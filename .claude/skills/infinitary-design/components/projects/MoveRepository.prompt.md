The Repositories panel on a project's page in Settings → Projects carries a Move line under Details, just above the Remove line (`RemoveProject.prompt.md`) and separated by the same hairline.
Its title names the repository it moves, “Move {name} to another project”, with the description “Its folder, settings and tasks go with it.”
Beside them sit a select and a small secondary Button, “Move”.
The list, Scratch and the personal workspace's page never carry it.

The select reads “Choose a project” until one is chosen, and Move stays disabled until then.
It lists every other live project that holds a repository, as “{name} ({key})”, then “A project of its own” when the repository shares its project with others.
Scratch and the personal workspace are never listed.

Move turns the line into one question in place, the move card's own title (“Move {name} into {project}?” or “Move {name} into a project of its own?”), then “Its folder and settings stay with it, and its tasks join with their keys.”
Cancel (secondary, focused, so Enter never moves) sits beside the primary Move.
While it runs the button reads “Moving...”.
It runs the same move the first mate's move card applies (`ChangeCard.prompt.md`), at once on the captain's click, as Add a repository does; no card goes up.
A refusal, such as an open task and its open part that would end up in different projects, shows in danger text under the line and nothing moves.

When done the page shows the project the repository joined, with its tab chosen and “Moved {name} into {project}.” in the panel.
The feed says “Captain · Moved {name} into {project}”.

Every control is reached with Tab and draws the focus ring; a letter typed on the select chooses the project it starts.
