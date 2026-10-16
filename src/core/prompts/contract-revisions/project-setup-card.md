# Firstmate proposes a project, and the captain adds it on the app's setup card

FI3-1532's build, grounded on FI3-1531's plan (the captain's "Approve and build", direction A, with every project Firstmate adds getting the card, all four settings on it, link with a clone offered, and the waiting work started once it is added).
`project-setup` was an asked line, so Firstmate could add a project only on the captain's own message, a schedule he set, or his click on a Firstmate card; a crewmate's report could not ask for one, and Firstmate had to ask the captain to type a line.
It is now a `hands` line that proposes: `app_change project-setup` is open at every wake, changes nothing, and answers with the id of the setup card the host writes from the checked request; a Firstmate actor on `fm:repos:setup` is refused.
Its value gains Firstmate's suggestions - `delivery`, `autonomy`, `rigor`, `runsOn` - and `work`, the waiting work it starts once the project is added; `app_state` reads it as allowed now at every wake.
The captain's Add project sets the project up with the card's settings, and Firstmate hears once through a new `[fm-op]` wake, `project-setup`: added with its settings and the work to start now, already on the list, not now, or failed with the reason and any typed sign-in refusal.
The `app_change` description now says hands actions put up the captain's card, project-setup's at any wake, in place of "open a Settings tab"; the prompt is unchanged.
The description costs the fixed part 2 tokens by the app's count; with it the fixed part measures 18,248, under the 18,250 budget.

The ledger entry that comes with it:

FI3-1532, the setup card. project-setup is a hands line that proposes at any wake: app_change checks the request, adds nothing, and puts up the host's setup card - source, how it lands, Runs on, Where changes go, Ask before merging and Care, Firstmate's suggestions selected - whose Add project alone adds it. The project-setup wake tells Firstmate the answer once.
