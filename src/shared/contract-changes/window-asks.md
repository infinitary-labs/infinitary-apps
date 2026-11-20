# The first mate asks a window

The live frame `inf:view:ask` asks the window of one computer to answer one of its own Settings requests: its look, its panels' layout, its update and its key reminder (`windowAskSchema`, `src/shared/windowAsks.ts`).
The window answers with the new request `inf:view:answer`, naming the ask's id: what its own request answered, or why it could not.
A home sends the frame only to a window that lists this change; a window from before is never asked, and the first mate says so instead of waiting.
