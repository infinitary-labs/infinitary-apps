The appearance optionally carries `language`, the catalog language the captain chose in Settings → Appearance; without it the app speaks its default language, English until every word is in the catalog.
The home keeps it in a settings row of its own, so an older build still reads the rest of the look and ignores the choice.
A view from before this change reads the look strictly, so the home leaves `language` out of the look it pushes or answers to a view whose hello does not list this change.
A view keeps its own look, its language included, and never saves it on the home.
