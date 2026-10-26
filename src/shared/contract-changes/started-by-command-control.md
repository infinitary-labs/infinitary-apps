# Control of a first mate started by a command

A home started by a command (`infinitary run`) says so in a view's welcome with a new optional `startedByCommand: true` (`docs/run.md`, "Control from another computer").
It then answers a view every `home` request but those that stay there (`RUN_HOME_ONLY_CHANNELS`, `src/shared/ipc.ts`), as the captain at another computer.
It sends a new push, `inf:app:open-page`, with the address of a page it would have opened in a browser, such as a sign-in's, and each computer that controls it opens the page.
An older view ignores the field and the push and asks only `views` requests, as before.
A view on this change controlling an older home, or a home with its window, reads no field and asks only `views` requests.
