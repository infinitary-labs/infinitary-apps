# Panels read the app's settings

The new request `inf:settings:current` answers the named app settings a panel may read, each cut to its panel value (`src/shared/panelSettings.ts`), and refuses any other name.
It serves the new read `settings.current`.
Infinitary on iPhone and iPad asks its home for every name.
A window on another computer answers the settings its own look holds (the look's lines and the panels switch) from that look, and asks its home only for the rest (`ViewBackend.settingsNow`).
An older home has no such request: a window's read of its own look's settings still answers, a read naming any other setting gets an error and shows nothing, and every other read is unchanged.
A view lists this change in its hello: Infinitary on iPhone and iPad and every desktop that has it do.
A view without this change decodes a panel's reads as a closed list, so its home leaves out every panel, and every panel being built, that declares `settings.current` from the panel list it answers, pushes and replays to that view; the view's other panels arrive unchanged.
