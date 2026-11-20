# The first mate asks a window

The live frame `inf:view:ask` asks the window of one computer to answer one of its own Settings requests: its look, its panels' layout, its update and its key reminder (`windowAskSchema`, `src/shared/windowAsks.ts`).
An ask that changes the look or the layout names each field it changes with the value the first mate read (`changes`); the window changes nothing when one reads otherwise there, and otherwise sets only those fields.
The window answers with the new request `inf:view:answer`, naming the ask's id: what its own request answered, with its value from just before a change (`before`), or why it could not.
A home sends the frame only to a window that lists this change; a window from before is never asked, and the first mate says so instead of waiting.
