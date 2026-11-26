The look may carry `colorTheme`, the id of a built-in color theme laid over Dark or Light; without it the window shows plain Dark or Light.
The look's `theme` stays the theme's base, so whatever reads only `theme` keeps drawing Dark or Light.
Views without this change are not sent the field, and an older build reads the base from the unchanged appearance row and never sees the theme's own row.
