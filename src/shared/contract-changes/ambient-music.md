The look may carry `ambientMusic` and `ambientVolume`: whether the ambient music plays in the window, and how loud, 0 to 100 percent; without them it is off at 40 percent.
The home keeps them in a settings row of their own, so an older build still reads the rest of the look and ignores them.
A view from before this change reads the look strictly, so the home leaves both out of the look it pushes or answers to a view whose hello does not list this change.
A view keeps its own look, the ambient music included, and never saves it on the home.
