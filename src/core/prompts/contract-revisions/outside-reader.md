# An outside reader is a task shape the first mate can start

INF-6388, piece 4 of INF-6358's plan; the captain chose to build the fenced reader first, with Careful review.
A task that reads words strangers can write, such as its project's issues and pull requests, needed a way to start with nothing those words could turn against the captain.

What the first mate is now told:

- `spawn_crewmate`'s `shape` takes `outside_reader`, true only on a read-only task whose brief has it read words strangers can write; its rule says what the crewmate then lacks and that every write it makes waits for the captain's click.
- `spawn_crewmate` refuses an outside reader with no project, on the personal workspace, or that is not an answer, saying what to name instead; nothing is started.

Homes: the rule is the `outside_reader` field's own line in the shape's field rules, and the refusals are `spawn_crewmate`'s answers; none is said twice.
The field's line costs about 50 tokens in the fixed context, which stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
The host enforces the fence itself - no shell, web or browser, reads inside the working copy and its own project, every write kept on one approval card, every answer fenced - so whether a task reads outside words stays the first mate's judgment.
