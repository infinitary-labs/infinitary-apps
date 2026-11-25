# Taking back a message: the refusal and the undo wake

The first part of a plan the captain approved: the captain may take back their newest message to the first mate within one minute, and the first mate undoes what it did for that message and says what it did.
The captain chose that the first mate undoes and tells, and a one-minute window.

What the first mate is now told, each rule in one home:

- A wake, `taken-back`, stage `held`: served at once into the turn that holds the message. It says not to carry out the message, that every call credited to it is refused from now on, including one naming no message, that work for another message names that message's `ask_id`, and that the app lists what the message caused once the turn ends.
- A wake, `taken-back`, stage `ended`: served once per message after no turn holds it. It gives the message's words and when they were sent, lists what the message caused by tool, and each task by the id its tools take and its key, names the undo for each kind (drop a task it filed, stop a crewmate it started and keep its work, close a card it raised, tell a crewmate it steered to ignore the words, cancel a schedule, retire knowledge or a direction it recorded), says to set `ask_id` to "" on those calls, and asks for one closing line saying what it undid and what it cannot undo. When the captain replaced the message, it gives the new words and says to keep what they still ask for.
- A tool refusal, from the core's gate beside the answer-only gate: a work-changing call credited to a taken-back message answers that the call was refused and nothing happened.
- An `ask_id` refusal, from `ask_id`'s own check on every tool: naming a taken-back message is refused, with the way to name another message or set `ask_id` to "".

The prompt, the tools' descriptions and their parameters are unchanged, so the fixed context does not grow.
A wake is served only after a take back, so its words cost nothing on any other turn.
