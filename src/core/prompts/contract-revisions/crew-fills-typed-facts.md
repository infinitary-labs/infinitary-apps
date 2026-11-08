# The app fills the typed facts it holds instead of refusing a crewmate

INF-3060's finding 2, the captain's pick "Start now: serve the full tool names and fill the three typed facts".
In one day 44 of the crew's calls to the app's own tools were refused, and 25 of those refusals named an answer the app already held.

What the crew is now told and answered:

- A Claude crewmate's backend note names its output tools as the client serves them (`mcp__infinitary__report` and the rest) and says that every short name in its instructions is called as `mcp__infinitary__<name>`.
- A report whose `waiting_on_captain` names a card of the crewmate's own that is already closed, while no card of its is open, is taken with no card named, and its receipt says so; with a card of its open, or a name that is no card of its own, it is still refused with the open cards' full ids.
- A saved-story merge card whose `risk` or `required_actions` repeats its saved revision exactly is shown from that revision, and the answer says the copy was left out; a copy that differs or does not read, a `body` or `body_file`, browser controls and any other action set are still refused. A computer that runs work sends such a copy only to a home that lists `story-fact-copies` (`src/shared/contract-changes/`), and otherwise refuses as before.

Homes: the note is the Claude crewmate's backend note; the two fills are the host's, which reads only typed facts it holds.
The captain's later words, "we should not take any guesses here", keep every fill to a fact with one possible answer.
Judgments stay refusals, and so does a revision's reply that names no captain message (INF-2884): which message it answers, or whether it is a progress note, is the crewmate's to say, so the app does not guess it.
The first mate's contract is unchanged; a Claude crewmate's fixed context grows by about sixty tokens.
