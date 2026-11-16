# Automation rule notes

Adds the `inf:automation:notes` request, which reads a rule's newest notes version (`current`) or every version, newest first (`all`).
Adds the `inf:automation:notes-save` request, which saves the captain's notes for a rule and answers the version it saved.
An automation rule itself is unchanged, so an older side reads rules as before and never asks for notes.
