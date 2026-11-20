# The card's lifecycle in a steer's response context

INF-4165's session audit found that passing the captain's card reply to a crewmate was refused on the first try every time: steer_crewmate's `response_context` asked for the card's lifecycle, which the first mate is never shown, so it guessed and was refused.
The captain chose to start the fix.

- steer_crewmate's `response_context` now carries only `card_id` and `captain_message_id`; the `lifecycle` field is gone, and its description no longer asks for one.
- The host fills in the card's current lifecycle and still refuses a message that is not the captain's in it. The refusal names the card's current captain messages and says to name one of them or leave `response_context` out.
- The fixed context shrinks by a few tokens.
