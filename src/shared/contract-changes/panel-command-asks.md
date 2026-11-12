# A panel command may ask its panel

A panel manifest's command may name `asks` instead of `emits` or `presses`: a name of the panel's own, with no header button, that the command opens the panel and asks it by.
The Tasks panel's Collapse all parts and Expand all parts use it.
An older side does not know `asks`: its strict check refuses such a command, and the panel keeps what it keeps when its cards and commands are refused.
