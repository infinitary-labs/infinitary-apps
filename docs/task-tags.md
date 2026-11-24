# Task tags

Each project keeps its own list of tags, and a task carries any of its project's tags.
A tag has a name and a description that says which tasks qualify, such as `bug`: "Something that used to work and is broken now".
Tags help a person find and group work; nothing in the app acts on a tag by itself.

## A project's tags

A name is required, and unique in its project ignoring case, so `Bug` and `bug` are one tag.
A description is required.
Tags list alphabetically everywhere, ignoring case (`byTagName`, `src/shared/tags.ts`).
They have no color and no fixed limit on their number.

`ProjectTagStore` (`src/core/storage/projectTagStore.ts`, reached as `ProjectStore.tags`) is the one writer of `project_tags`.
A tag keeps its id for life, so a rename keeps it on every task that carries it.
Each new description raises the tag's `revision`; a rename alone does not.

Removing a tag takes it off every task that carries it, in the same write, and writes one quiet line on each of those tasks' timelines.
Settings asks once first, naming how many tasks carry it.

A project's view (`projectViewSchema`, `src/shared/tasks.ts`) carries its tags in `tags`, each with its description, revision and how many tasks carry it now; the field is absent while the project has none.

## Where a project's tags are changed

- **Settings.**
  A project's page in Settings → Projects has a Tags box between Project and Repositories (`ProjectTags`, `src/renderer/src/settings/ProjectTags.tsx`; design skill `components/projects/ProjectPage`).
  Each row names a tag, how many tasks carry it and its description, with Edit and Remove; Add a tag ends the box.
  Edit and Add a tag open a form in the row's place with the name and which tasks qualify; Enter saves, and Escape or Cancel puts the row back.
  Remove turns its row into one question with Cancel focused, so Enter never removes.
  The form refuses an empty name, an empty description and a name the project already has in the person's own words before anything is sent.
- **The first mate.**
  The `project-tags` line of the action catalog (`src/shared/tagActions.ts`) sends the same request Settings sends, `inf:projects:tags`, on the captain's ask; its current value lists every project's tags with their descriptions and how many tasks carry each.

## The tags a task carries

`task_tags` holds one row per task and tag: on or off, who set it, the tag's description revision the decision model judged it at, and when.
`TaskService` is its one writer, through `setTaskTags` and `changeProjectTags` (`src/core/tasks/taskTags.ts`); `TaskTagStore` (`src/core/storage/taskTagStore.ts`) reads and writes the rows for it.

Who set a tag is one of three setters (`tagSetterSchema`):

- `captain`: a person, with Edit tags on the record.
- `firstmate`: the first mate, with create_task's or update_task's `tags`.
- `decision`: the decision model.

A tag a person or the first mate set or removed is theirs for good: the decision model never changes that row, and a row turned off by hand stays, so a tag removed by hand stays removed.
A tag already in the asked state is left as it is and writes nothing.

Each change to a task's tags writes one quiet `note` on its timeline for each direction, tags added or tags taken off, naming who did it ("You tagged this task bug."), with `news: false` and no feed line, so it raises no card and no Activity line.

A task reads a tag only while the tag belongs to its own project.
Moving a task to another project deletes its tag rows, on and off, in the same write as the move (`src/core/tasks/projectMove.ts`).
A purged task's rows go with it.

A task's view (`taskViewSchema`) carries the tags it carries in `tags`, alphabetical, each with its id, name and setter; the field is absent while it carries none.
Until any task carries a tag, building a row's view reads nothing more (`TaskTagStore.viewsOf`).

## Where a task's tags are changed

- **The record.**
  The Info tab's Tags row follows Project once the project has tags or the task carries one: the tags it carries, then Edit tags, a menu of the project's tags with each ticked on or off (`RecordTags`, `src/renderer/src/cards/RecordTags.tsx`).
  A tick saves at once, by `inf:task:tags` with every tag the task should carry, and leaves the menu open.
  Edit tags in command search (`task.edit-tags`) opens the same menu on the shown record.
- **The first mate.** create_task and update_task take `tags`, the project's tag names the task carries, exactly; an empty list clears them.
  On update_task they apply after the call's other edits, so a move to another project comes first.
  The tasks tool lists a task's tags by name.

## Saved data and older sides

The tags migration adds both tables; an existing record upgrades with no step for the person, and every task starts with no tags (`docs/saved-data-compatibility.md`).
A record opened at an older version has neither table, and both stores read nothing from it.
An older window, view or phone never sends either request and reads neither `tags` field, so it draws no tags and behaves as before (`src/shared/contract-changes/project-tags.md`).
