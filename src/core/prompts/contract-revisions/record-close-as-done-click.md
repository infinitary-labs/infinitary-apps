# The captain's Close as done on a task's record

INF-3169's plan, piece 3; the captain chose "Approve and build" on the plan's Close as done button, with one confirm, on a started task's record.
A press of Close as done closes the task through the one close as done as the captain's own close from the task card, so it reaches the first mate's next turn like the record's other buttons (contract 4.71).
Before this revision the host would have listed that close as a Start, the word it gave every other captain status change on a task card.

What the first mate is now told:

- The context block's `captain_resolutions` list carries a line for the press, in its button's words: the captain closed the task as done from its record (Close as done), with its age, and that its unmerged work is kept and an open pull request stays open.

Home: the host's own context block, beside the other task card click lines (`FirstmateContext.taskCardClickLine`).
The prompt text and the tools are unchanged; the line appears only on a turn after such a press.
