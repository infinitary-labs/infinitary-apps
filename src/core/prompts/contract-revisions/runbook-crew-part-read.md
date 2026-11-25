# The first mate reads a runbook's crew part

INF-6749's session audit, finding 4, which the captain chose to build: the first mate answered a question about a runbook from its own first-mate section and said the runbook does not do what its crew section tells crewmates to do.
`app_state` gains the named read `runbooks.crew`, which answers one runbook's crew part by its id or name, on or off: each crew section's text with the selector that serves it, and its skills' names.
The `app_state` description now says the reads include a runbook's crew part, which the first mate's runbook text leaves out.
The rule's one home is the `app_state` description, with the read's own `about` saying when to read it; the read changes nothing and joins no context a turn builds.
The fixed part grows by 17 tokens: the core measures 20,234, up from 20,217, against the first mate's budget of 29,658.

The ledger entry that comes with it:

INF-6749 finding 4. app_state gains the read runbooks.crew, a runbook's crew sections with their selectors and its skills' names.
