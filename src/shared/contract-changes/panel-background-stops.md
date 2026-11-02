# Panel background stops

Adds `inf:plugins:retry`, the captain's Retry on a panel whose background work the app stopped.
Adds the optional `stopped` field to each panel in `inf:plugins:personal`, saying why and at which code version its background work was stopped.
Widens a panel manifest's `api` to accept 2, under which a panel's `server.ts` runs in a process of its own and its store answers asynchronously.
An older side reads no `stopped` field, so it draws no Retry, and never asks the new request.
