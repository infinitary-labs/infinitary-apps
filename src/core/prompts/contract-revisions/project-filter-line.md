# The project filter line on every input

INF-6860, the plan for the captain's "when i chat with you in this main chat input, are you aware of the project filter i set at the top of the desktop app?"; the captain chose "Approve and build" with question 1 "New work, answers and actions, naming what it left out" and question 2 "Every project: say it came from the phone, which shows them all".
Before, a window focused on one project sent a `focused_project` hint that spoke only of new work, All projects sent nothing, and a reply under a first mate card or Ask again cleared it.

What the first mate is now told:

- The per-input key `focused_project` is renamed `project_filter`, and it rides every input after any captain message that said a filter, until the next one says otherwise.
- With a project: the line names the project filter at the top of the captain's window, the order that decides a message's project (their words, the card they replied under, the shown record or card, then the filter), the scope where nothing stronger names a project (new work goes there, answers cover its work and say how much waits elsewhere, actions on many tasks act on its tasks alone and name what they left out), to say so when the filter decided something, and never to change the filter.
- With All projects picked while the pill shows: a line says nothing narrows new work, answers or actions.
- From the phone: a line says the captain's latest message came from their phone, which has no project filter and shows every project.

Home: the per-input `project_filter` line in the core (`projectFilterLine`), so only inputs with a filter pay for it; no tool description or fixed instruction repeats it.
The fixed context does not grow.
The host reads only typed facts - the window's picked project or All projects, and whether a paired phone sent the message; weighing the captain's words against the filter stays the first mate's judgment.
