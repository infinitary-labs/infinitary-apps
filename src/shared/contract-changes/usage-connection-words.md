Adds the optional `words` field to the reporting connection's view (`inf:settings:usage-connection:get`) and to its save (`inf:settings:usage-connection:save`): each turn's prompts, replies and tool calls go to that connection too.
The view leaves `words` out while the switch is off, as an older home always does, and a newer window shows it as off; an older home ignores it on a save, so nothing but usage is sent.
An older window leaves it out of a save, which saves the connection with the switch off.
