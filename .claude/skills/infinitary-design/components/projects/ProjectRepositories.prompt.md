A project can hold several repositories, and each task still works in exactly one of them (the app's `docs/architecture.md`, decision D5a).
Settings → Projects lists projects one line each, and every project, of one repository or several, opens the same page (`ProjectPage.prompt.md`).

**The project's line.**
A project of several names itself in the UI font, then, in quiet mono words, its task key and how many repositories it holds: "Harbor Ledger  HBL · 2 repositories", with a chevron pointing right.

**On its page.**
The Project box holds the project's Name: an Input and a small secondary Save, with the description "Your project keeps its key HBL and its history.
Each repository keeps its own name."
It names the project alone; renaming a repository never renames a project of several.
The Repositories panel has one tab per repository along its top edge, and holds the chosen repository's settings: Where changes go, Ask before merging, Rigor, Cost limit, Runs on, its Details, Move and Remove.
Those settings stay with each repository, so one repository can take Careful while another takes Default.
In a project of several, the repository's own Name sits in its Details.

**Add a repository.**
The button follows the last tab on every project's page, and its form, inside the panel in place of the settings, is `AddProject.prompt.md`'s, with the label "Add a repository", the same pills (Folder on this computer, one "{host name} repo" per host, and New repository in place of New project) and no Task key field.
A quiet line under the pills says "A repository added here joins Harbor Ledger, and its tasks take the task key HBL."
A project of one offers it after its one tab, so its second repository can be added from Settings.
A ghost Cancel under the form brings the settings back.
Adding says "Added harbor-ledger-api to Harbor Ledger." in the panel and chooses the new repository's tab.
The feed line reads "Project Harbor Ledger · added harbor-ledger-api".
Scratch and the personal workspace never offer it.

**Words.**
A project's repositories are called repositories wherever a project holds several or can take another: "2 repositories", "Add a repository", "Repositories".
What work, task keys and Tasks belong to is still the project.

**The task record.**
The record's Project fact names the project; in a project of several it adds the repository the task works in: "Harbor Ledger · harbor-ledger-api".

**The phone.**
The phone's Projects page draws a project of several as its own list, with the project's name as its section label and its key and count as a caption above its rows; each row opens the repository's page as before.
The phone adds no repository: adding stays on the computer, as adding a project does.

A repository moves to another project on the move card (`ChangeCard.prompt.md`) or from its Move line in Settings (`MoveRepository.prompt.md`), keeping its name, folder and settings and its tasks' keys; it is never removed and added again to move.
