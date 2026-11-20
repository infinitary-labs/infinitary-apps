# Each message ends on a card the captain accepts

INF-1610 piece 2, from the captain's Approve and build on the plan "each of your asks ends on a card you accept", with their words: "we've previously done a lot of surgical fixes for this problem. i think this is now the more robust solution, so while we do this, we should aim to remove previous logic that should be replaced by this, to simplify our codebase".
Their round answers: a card goes up every time, a reaction answers a message that asks nothing, a closed note is accepted and a decision closed without a choice is not, and a missing answer is asked of the crewmate whose task ends last, then the first mate, then the app's notice.

What the first mate is now told:

- The `answer-missing` wake asks for `emit_card` with `answering` true. When the message's work ended with no card that answers it, the wake opens with that and names the work, and offers `link_tasks` to the task that took the work over.
- During that retry `link_tasks` is no longer refused; the refusal's words name it and the answering mark.
- Its context block carries `open_asks`: each message still waiting for its accepted answer, by id and when it was sent, how it stands and the work still running for it, newest first and bounded like the task list. It never repeats the captain's words.

What a crewmate is now told: a finished report from the last running work of a message with no answer up or accepted is refused once (`CREWMATE_ANSWER_ASK`), asking for the card with `answering` true or why it cannot show one.

The host's own closing note follows one rule, at most one for each message (`docs/task-capture.md`, "How a message ends"), which replaces the separate rules of INF-547, INF-1137 and INF-1219 for asked work; `internal_step` still keeps the drop of work the captain did not ask for off their stack (`fleet-started-work-stays-quiet.md`).
The served first mate prompt is unchanged, so the fixed part does not grow; `open_asks` is per-turn context, at most twelve short rows.
