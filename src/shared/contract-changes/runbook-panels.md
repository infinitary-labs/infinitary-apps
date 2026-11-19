# Runbook panels

A runbook view may name the panels its runbook shows while it is on, in an optional `panels` list of each panel's id and title.
A personal extension view may name the runbook whose panel it is, in an optional `runbook` field, beside its `installed` source.
An older side reads neither field: it lists a runbook without its panels and shows a runbook's panel as an added one.
The personal snapshot may name the runbooks' panels it left off the rails, in an optional `refused` list of each panel's id, its runbook's name and why.
An older side reads none of them, so a runbook's panel left off is not in its list of refused panels.
