# Something reached a crewmate

The `task_event` push admits an optional `reached` field, `true` on an announcement that something sent reached the crewmate: words entered its turn, its turn was stopped, or its task closed under it or was edited (INF-759).
Such a push has `kind` `reached`, empty `text` and `feed` false, and is never a timeline event.
The center draws its spark out to the crewmate on it, and no longer on a recorded message.
An older view never reads the field, so it draws no spark for these pushes and keeps sparking on a recorded message as it did before.
