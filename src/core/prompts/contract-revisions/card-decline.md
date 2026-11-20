INF-3108, the captain's approved plan: decisions get a way to say no to every choice.
The emit_card `actions` parameter now names an optional `declines` on an action and says to set it on the author's own way to say no, such as Not now or Abandon, and that without one the app adds Decline, which reaches the author as no to every choice.
The card-choice wake for that Decline adds one sentence, `DECLINE_WORDS`: the captain declined every choice, go on without them, and ask again only with something new.
The record's Dismiss on a first mate question is now that Decline: the question closes as answered with the captain's no, and the first mate hears it as a card choice, where before it was dropped without a wake.
The old close ids (`later`, `keep`, `dismiss`) stay ordinary replies on a card, since no corner closes a card any more.
The new words add about forty tokens to the `actions` parameter, which every emit_card carries.
