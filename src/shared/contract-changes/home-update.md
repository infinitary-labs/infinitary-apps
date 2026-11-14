A home answers three new requests about its own update from any paired view, a phone or a Mac that controls it: `inf:home-update:status` reads it, `inf:home-update:install` starts it and `inf:home-update:later` lets it go (`src/shared/homeUpdate.ts`).
They have `reach` `views`, and their names and shapes never change, so a view asks them on any major; Update and Update later pass the read-only gate (`READ_ONLY_ASKS`, `src/shared/contractFeatures.ts`).
A view reads an older home by this name, and a home on `HOME_UPDATE_FOLDED` or later by its major, since the major after this one folds the name in.
A first mate a command started asks its own window the new `update` kind of `inf:own-window:ask`, which the window answers with the new `update` answer, since only a program in the person's session replaces the copy on a Mac.
The new push `inf:update:asked` tells this computer's window that a view started the update, and the update status gains the optional `askedFrom`, the view's name; a view never hands that push on to its own windows.
A home without this change refuses the requests as unknown, and a view shows no update control for it.
