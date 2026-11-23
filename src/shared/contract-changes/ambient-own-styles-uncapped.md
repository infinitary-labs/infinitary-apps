The look's `ambientOwnStyles` may hold any number of the person's own styles, where it held at most 12.
Views without this change are not sent the field, since they read at most 12, and play the default style while `ambientStyle` names an own style, as an older build does.
