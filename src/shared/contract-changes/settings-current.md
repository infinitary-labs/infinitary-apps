# Panels read the app's settings

The new request `inf:settings:current` answers the named app settings a panel may read, each cut to its panel value (`src/shared/panelSettings.ts`), and refuses any other name.
It serves the new read `settings.current`, which a view asks of its home like any other read.
An older home has no such request: a panel that reads settings on a view of it gets an error and shows nothing, and every other read is unchanged.
A view without this change decodes a panel's reads as a closed list, so its home leaves out every panel, and every panel being built, that declares `settings.current` from the panel list it answers, pushes and replays to that view; the view's other panels arrive unchanged.
