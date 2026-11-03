# Update panel on a paused panel

The panels snapshot gives a panel of the captain's own an optional `paused` field when the app refused its `server.ts` because it is written for a panel API this version no longer serves: the API it names, the APIs served, and whether the captain already asked to update it.
The new core request `inf:plugins:update` is the captain's Update panel on such a panel: the first mate is told and starts the update, and it answers false when nothing was told.
An older side reads a snapshot without `paused` and never asks the request, so it draws no Update panel and shows the panel as before.
