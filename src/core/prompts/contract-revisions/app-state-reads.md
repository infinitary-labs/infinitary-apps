# The first mate reads what Settings shows beyond the action list

INF-5326's approved plan, piece 3 (the captain's "Approve and build"): the first mate can read what a person sees in Settings that the action list's current values leave out.
`app_state` gains two top-level parameters, `read` and `args`, and the area `reads`, which lists each named read with what it answers and the args it takes.
With `read`, it answers one named read on demand instead of the action list: `usage.summary` and `usage.tasks`, `automation.history`, `automation.kept`, `automation.preview`, `update.status`, `computers.resources`, `keyboard.keys`, `devices.copies`, `devices.copy-ready` and `devices.move-ready`.
The reads the window's read catalog names run through that entry's own args and request; the rest read the core request Settings already asks.
`keyboard.keys` answers the map the window installed, as Keyboard settings shows it, the panels' commands included; with no window it answers the saved keys for the app's own commands and says so. It is read only: the first mate still never changes keys.
A read changes nothing and joins no context a turn builds; a name off the list or args the read refuses answers words.
The `automation-edit` line now names the placeholders a saved prompt may hold, from the app's own list.
The rule's one home is the `app_state` description; the names and their args are listed on demand by `area: "reads"`, so the fixed part carries only the pointer to them.
To keep the fixed part under its budget, `app_state` says who may act and the tiers' meanings in fewer words, and `app_change` says its proposal rule in fewer words; the evidence rule keeps its words, and every rule is unchanged.
By the app's count the fixed part measures 19,766 against 19,759 on the main line it builds on, under the first mate's budget of 19,772.

The ledger entry that comes with it:

INF-5326 piece 3. app_state gains read, args and area reads: eleven named reads on demand (usage, automation runs, kept jobs and next dates, update, computers, keyboard keys, copies and moves); automation-edit names the schedule placeholders.
