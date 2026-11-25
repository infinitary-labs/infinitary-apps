# Project and task tags

Adds `inf:projects:tags`, which adds, edits or removes one of a project's tags, and `inf:task:tags`, which sets which of its project's tags a task carries.
Adds an optional `tags` field to a project's view, its tags with a description and a count of the tasks carrying each, and to a task's view, the tags it carries with who set each.
An older side never sends either request and reads neither field, so it draws no tags and behaves as before.
