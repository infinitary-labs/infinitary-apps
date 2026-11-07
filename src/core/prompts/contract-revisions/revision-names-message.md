# A crewmate's revision names the message it answers

INF-2884, the captain's pick: "Keep the mark; name it in the steer's do-this sentence, and refuse a revision whose answer neither names your message nor is marked as a progress note".
On INF-2883 a crewmate revised its card twice with a `reply` that named no message, so the captain's reply kept waiting and the stage kept the version they replied under, beside "has not answered yet", after the crewmate had answered.

What the crew is now told:

- The crewmate thread steer preamble's do-this sentence says the answer names the captain's message in `answers_message`, by the number the per-card line gives, and that until a line does the card keeps showing the version they replied under.
- The crewmate's `emit_card` has a top-level `interim` parameter: its `reply` is a progress note, and the captain's reply still waits.
- While the captain's reply waits, the host refuses a crewmate revision whose `reply` neither names that message nor is marked `interim`, writing nothing; the refusal names the message number and both ways on.

Homes: the judgment is the steer preamble's, the mark the parameter's, and the refusal the host's, which checks only the typed fields.
The first mate's contract is unchanged; the crewmate's fixed context grows by about fifteen tokens for the parameter.
