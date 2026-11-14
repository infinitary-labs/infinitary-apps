# Finished work still open is told once, and a close names the message that holds it

INF-4072's session audit, finding 4, which the captain started: a task whose crewmate had finished stayed open for most of a day, and its close was refused for guidance still queued for the idle crewmate, so the first mate cancelled it instead.

What the first mate is now told:

- A close refused for queued guidance names each message still waiting for the crewmate: its id, how long ago it was queued, whether it was never delivered, tried and not taken, or handed to a turn that never finished with it, and its own words (the captain's verbatim words for a card reply or a Crewmate tab line).
  The refusal names the way to drop it.
- `settle_task` takes `drop_waiting`, the ids of waiting messages the crewmate no longer needs; for `done` the holds read as if they were gone, and they are dropped, while the crewmate is idle, only once the close goes through.
- A `finished-open` wake goes once per finish when work its crewmate declared finished is still open an hour later, the first mate has acted on it since, and nothing is up for the captain: it names the task, how long it has been finished, and any message holding its close with the drop way.

Homes: the drop way is the refusal's and the wake's own words; what `drop_waiting` takes is its parameter description.
The fixed context grows by that parameter and its description, about 35 tokens (`tests/firstmate-fixed-context.test.ts`).
