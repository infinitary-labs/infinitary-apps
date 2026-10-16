# A task's title says what it does

INF-19, recreated from FI3-1819 on the captain's words "Recreate them in INF now."
The captain's ask: "make it so that when our plan breaks down tasks, the tasks' titles are descriptive, not a step number like this that's really hard to understand which step is doing what", beside a picture of the Tasks list reading "Rename step 1 of 16" through "Rename step 16 of 16".
The plan behind those tasks (FI3-1780) named every step, but the first mate filed them as "Rename step N of 16" and asked each crewmate to rename its own task when it started, so every step not yet started read as a number.

- `create_task`'s `title` now reads: Sentence-case title saying what it does (max 64 chars), e.g. "Ship the bridge to alpha", not its place in a plan.
  The example names an action with no step number, no word "step" and no project-name prefix: in a live check, an example that held "Rename step 5 of 16" as what to avoid led the first mate to title sixteen steps "Rename step N: …".
  `spawn_crewmate`'s and `update_task`'s `title` say "As create_task's title.", so one rule covers every task the first mate files, starts or renames.
- The sequences preamble said "name each step by its kind (plan, retrieval, research, reproduce, implement, fix)", which reads as a title rule that gives every step the same few words.
  It now says each step is one kind, and the title rule lives on the title.
- `create_task`'s `goal` and `user_words` say "As spawn_crewmate's goal." and "As spawn_crewmate's user_words.", where the same words already live, which pays for the rule.
- Nothing in the host reads a title: it still stores whatever the first mate passes.
- Cost: the fixed context measures 19,736 of its unchanged 19,745 budget (`tests/firstmate-fixed-context.test.ts`).
