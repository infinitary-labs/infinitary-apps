The appearance optionally carries `fonts`, the fonts the captain chose in Settings → Appearance for the app's words, for what the crew writes on cards and for code; without it the app writes in Infinitary's own fonts.
The home keeps it in a settings row of its own, so an older build still reads the rest of the look and ignores the choice.
A view from before this change reads the look strictly, so the home leaves `fonts` out of the look it pushes or answers to a view whose hello does not list this change.
A view keeps its own look, its fonts included, and never saves it on the home.
