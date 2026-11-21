The look may carry `ambientOwnStyles`, the person's own ambient music styles, each a checked list of settings with its id; `ambientStyle` may then name one of them.
Views without this change are not sent the field, and an older build, which keeps no such row, plays the default style when `ambientStyle` names an own style.
