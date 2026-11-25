# Automation rule brought

Adds the optional `brought` field to an automation rule (`inf:automation:list`, `inf:automation:save`, `inf:automation:state`): `heartbeat` marks the rule the Heartbeat runbook brings, which the host refuses to edit or delete and removes when the runbook is turned off.
An older side never reads the field, so it shows the rule as an ordinary one; an edit or delete it sends is refused with words naming Settings, Runbooks.
