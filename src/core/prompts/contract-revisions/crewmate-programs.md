# A crewmate starts a program; the first mate writes no script

INF-3022, the plan "allow crewmates to dynamically initiate a program when needed"; the captain chose "Approve and build" and added that the first mate should not write a program's script and hand it to a crewmate just to start it, but nudge the crewmate to use `start_program` and let it work out the rest.
The captain's answers: the crewmate's task always waits on its program, the first mate's own filing is retired in the same change, and the bound and the end reach the crewmate first, then the first mate.

What the first mate is now told:

- `create_task` no longer takes `program`; `update_task program_bound` stays for a held program the captain raises on the first mate's turn.
- The Programs guide sends "use a workflow", a loop to a stop condition, an audit, deep research and a migration of each item to one crewmate in the project with a constraint like "use start_program to do this", and says never to write the script.
- The served sequences guide's routing line now says a programs ask goes to one crewmate.
- The `program-bound` wake reaches the first mate only for a program no crewmate waits on, and says the bound was reached rather than proposed by the first mate.
- The `program-ended` wake reaches the first mate only for a program no active crewmate waits on; otherwise the crewmate's report says the outcome.
- A crewmate's report names the programs it started that turn.
- A crewmate's report also names each finished program it started that returned a branch, with the branch part's key to name in `branch_from`, since shipping it stays the first mate's.

Homes: the routing rule is the Programs guide's, the dialect and shapes are the Programs crew skill's (outside the first mate's fixed context), and the wakes are their renderers'; none is said twice.
The guide is shorter than the one it replaces, so the first mate's fixed context shrinks (`tests/firstmate-fixed-context.test.ts`).
The host adds no verdict: the crewmate judges the script, the bound and when to ask the captain.
