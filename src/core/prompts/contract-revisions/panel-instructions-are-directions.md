# Panel instructions are standing directions

INF-1054, from the captain's "Approve and build" on its plan (shape A, "One store, one way in: panel instructions are ordinary directions"): a lasting instruction about the panels built for the captain is an ordinary standing direction scoped to the personal workspace, kept through `app_change` with the `direction` line like any other.
`personalize` loses its `instruction` action and its `text` parameter; it only removes a surface now.
The operate move in the core prompt says so: removing a surface is one personalize call, and a lasting instruction for the panels built for the captain is one `app_change` direction scoped to the personal workspace.
The context block's surfaces section no longer carries a `standing_instructions` count, because the directions themselves are served whole on every turn.
The personal workspace is a project from the first start, so its id is in the context block's `repos` before any panel exists.
The fixed part shrinks: the tool loses a sentence and a parameter, and the core's sentence grows by about the same.

The ledger entry that comes with it:

INF-1054. personalize keeps only remove; a panel instruction is an app_change direction scoped to the personal workspace, and the surfaces section drops standing_instructions.
