# Project repositories

A project may hold several repositories, each naming the one project it belongs to.
The board's project view (`inf:tasks:board`, `inf:projects:list`) adds an optional `repos` list: every repository the project holds, first first, each with the fields `repo` has.
`repo` stays the project's first repository, so an older side that reads only `repo` still reads a project as before.
The project rows of `inf:work:tasks` add an optional `repositories` list, each repository's name and folder, sent only for a project that holds several; `folder` stays the first repository's.
An older side sends neither, read as a project of one repository.
An after-merge step (`inf:work:prepare-change`, `inf:work:open-change`, `inf:work:show-merge-card`) adds an optional `repository`, the repository a new step works in, by name.
An older home drops it and files the step by the old rule: the origin's repository in the origin's project, else the repository the named project was made with.
