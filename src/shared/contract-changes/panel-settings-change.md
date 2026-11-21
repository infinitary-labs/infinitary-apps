# Panel settings change

Adds the request `inf:plugins:settings:change`: a panel's change of one setting its manifest's `actions` grant names, asked by this computer's own window on the captain's press in the panel and run as the captain.
Adds the optional `panel` field to the `personalized` and `repo_configured` pushes: the title of the panel the captain changed the setting in.
An older side never asks the request, and an older reader drops the `panel` field and shows the line without the panel's name.
