# Repositories joining a project

A repository's setup (`inf:repos:setup`) may name an existing project by its task key in `project`, never together with `key`, and the repository joins that project instead of getting its own.
An older home refuses the field as an unknown one, and Settings shows that refusal under Add a repository.
`inf:projects:rename` names a project of several repositories and answers its id, its new name and the name it had; an older home has no such request, and its projects are named with their repository.
The `repo_setup` push may carry `project`, the name of the project the repository joined; an older side reads the line as a project added.
