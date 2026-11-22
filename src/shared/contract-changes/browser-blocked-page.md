# A task browser's page on a refused address

A task's open browser fact (`TaskBrowserFact`, `src/shared/taskBrowser.ts`) adds the optional field `blocked`: `local`, `private` or `insecure` while its page rests on an address that browser refuses, such as a sign-in's return to a program on its computer.
A view with this change shows why the page is blocked in the line under the browser's row.
A view from before has no field of that name and shows the page as before, with no reason.
A home from before never sends it.
