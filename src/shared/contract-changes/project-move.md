# Repositories move between projects

The new request `inf:repos:move` moves one or more repositories into another project, named by its task key, or into a project of their own, and answers the project they joined and how many tasks joined with them (`repoMoveTargetSchema`, `repoMoveResultSchema`, `src/shared/repos.ts`).
An optional third argument, a move card's digest of what it showed, refuses the move when that changed.
Each repository in a project's `repos`, in `inf:projects:list` and the board, adds its `id`.
A view from before never sends the request and ignores the new field.
A home from before refuses the request as unknown, and sends no `id`.
