# The first mate names any open message on the work that serves it

INF-2664, the investigation of a notice that said the first mate had not answered a message its crewmate's card had answered; the captain chose "Approve and build" with direction "Accept any open question by name", "withdraw" for a notice an answering card follows, and "yes" for the close fact.
The first mate had named the message twice, from the step that handled the captain's click and from a later one, and `ask_id` refused both times because it accepted only a message the current step's input carried in.

What the first mate is now told:

- `ask_id` names the open message the action serves in any step, and the first mate names it on work that comes from a click on its card or a report on its work.
  The host accepts any open message a finished reply has read, a notice-up one included; it refuses a message still waiting for its own step, and one that has ended, with a reason saying it ended.
- `close_card`'s answer adds one line when the close leaves an open message with no answering card up and no work running for it, naming the message by id and its words.
  It is a fact, never a refusal.

Homes: the naming rule is `ask_id`'s description, shared by every attributing tool; the close fact is `close_card`'s answer.
The description is rewritten at its old length, since it repeats on each attributing tool's parameters and the fixed context sits at its boundary (`tests/firstmate-fixed-context.test.ts`); "even in a captain turn" gave way to "if unrelated".
Which message the work serves stays the first mate's judgment: the host checks only that the message is open and was read.
