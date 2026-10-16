# Firstmate can name a new project's task key when it proposes the project

FI3-1787, step 4 of the Infinitary rename plan in FI3-1780, whose captain answered "INF, as you chose; keep step 4": the app derives `INFI` from "infinitary", so a project could not take the key the captain chose.
`app_change project-setup`'s value now takes an optional `key` beside `kind` and its spec, the same field Settings' Add project sends.
The setup card shows it as a "Task key" fact, and its Add project, or its fresh-clone choice, adds the project with that key.
A key that is not 2-4 letters or digits, or that any project has, Scratch and removed projects included, is refused at the ask in words, and no card goes up.
`app_state`'s `project-setup` line now says to pass `key` only when the captain chose the task key; the app derives one otherwise.
The served prompt and every tool description are unchanged, so the fixed part costs nothing more.

The ledger entry that comes with it:

FI3-1787, the chosen task key. project-setup's value takes an optional key (2-4 letters or digits) that the captain chose; the setup card shows it and its Add project uses it, and a key another project has is refused in words before any card.
