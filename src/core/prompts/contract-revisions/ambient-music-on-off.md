# The ambient music is on or off, with no pause

INF-6406, the captain's approved plan to show the sound button on the main screen whether the music is on or off, makes the button, its key and Settings' switch one on/off.
The pause the button kept apart from the switch is gone, so the first mate is no longer taught it.

What the first mate is now told, in the `ambient-music` action's own description in the catalog `app_state` serves:

- Play or stop the music: `on` true plays it and `on` false stops it, as its sound button and its Settings switch do.
- The value has no `paused` field any more, and the action's current value and its Activity line say on or off.

The fixed context does not change: the catalog is read through `app_state`.
