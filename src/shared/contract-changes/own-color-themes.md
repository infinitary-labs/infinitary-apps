The look may carry `ownColorThemes`, the person's own color themes, each an id, a name and six checked colors; `colorTheme` may then name one of them by its `own-` id.
Views without this change are not sent the field, and a view that has `color-theme` but not this change shows a `colorTheme` naming an own theme as its base, Dark or Light.
An older build keeps no such row and reads the base from the unchanged appearance row.
