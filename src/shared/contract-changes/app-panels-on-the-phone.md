# The app's own panels on the phone

A view may ask `inf:plugins:app-panels` for the app's own panels whose gate is open now, each with its title, place, reads, cards, header buttons and the version of its files.
The push `inf:plugins:app-panels` carries the same answer whole each time that set changes.
A view may ask `inf:plugins:app-panel-files` for one of those panels' compiled files at that version, each with its build pin.
An older side neither answers nor asks them, so a view of an older computer draws only the panels its panel list names.
