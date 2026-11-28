# A failed turn's model refusal

A `turn_failed` event may carry `refused`, with the provider's `category` when it named one: the model refused the conversation, as the Claude client typed it with `stop_reason` `refusal`.
The host counts it as a refusal toward "Stuck at its provider", so three in a row stop the retry and tell the first mate.
An older side ignores `refused` and keeps retrying such a turn as an outage, as it did before.
