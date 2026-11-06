# Files on another computer

New orders, `fileOrders` (`src/shared/files.ts`), let a home read a file on a computer that runs work: `inf:files:list` lists a folder, `inf:files:snapshot` sets one file aside whole, `inf:files:read` reads it piece by piece and `inf:files:release` lets it go.
New work requests, `inf:work:files` and `inf:work:copy-file`, let a crewmate on a computer that runs work name the captain's computers, list a folder on another of them and copy one file into its hand-over folder, through `infinitary-files-axi`.
The placed spec adds optional `files`, which gives a task's shell there that command.
A home never sends these orders or `files` to a computer that does not list this change: its files cannot be read from elsewhere, and its crewmates have no files command.
A computer never asks these requests of a home that sent it no `files`.
