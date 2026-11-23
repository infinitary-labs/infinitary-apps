# Automation looks failing

Adds the optional `failing` field to an automation rule (`inf:automation:list`, `inf:automation:save`, `inf:automation:state`): when a turned-on event rule's every look has failed for an hour, when the first failed look was and what the newest answered.
An older side never reads the field, so it shows such a rule as running, as before.
