# One answer counts for every message it answers

INF-6769, from INF-6749's audit, finding 3, which the captain chose to build: "one answer can name every message it answers, and a crewmate's answer to a passed-on question counts for the captain's message".
On one day a question got two answers in the same card thread twice.
A question and its one-word correction were answered by one line that named only the correction, so the question got the one retry and a second line.
A question the first mate passed on to the crewmate whose card it was about was answered there with a progress note and no response; the first mate took the request back, so the message had no answer and it wrote one of its own.

What the first mate is now told:

- `emit_card`'s `ask_id` takes a list: the open_asks ids of every message one card or line answers, such as a question and its correction. Each named message records the card or line, so none of them gets the retry. The other tools keep one id.
- The `requested-response` wake, when the crewmate wrote its answer as a line in a card's thread, names that line and says it is the answer to the captain's message, so the first mate does not write it again. A response given only in a report keeps the old sentence: answer the captain on the original card.

What the crew is now told:

- The response-request steer says that when the answer belongs in the crewmate's card's thread, it writes it there with `reply` and `response`: that line is its response and the captain's answer, which the first mate does not repeat, and an interim line is neither.

The host still reads only typed facts: which messages a call named, and which card line carried an answered response (`InboxStore.answeredLine`). A message whose request was answered on a card line ends on that card (`AskEnding.state`); a message with no answer still gets its one retry.

Homes: the list's rule is `emit_card`'s `ask_id` parameter; the crewmate's way is the response-request steer; the no-repeat fact is the `requested-response` wake.
The first mate's fixed context grows by about thirty tokens for the parameter's description.
