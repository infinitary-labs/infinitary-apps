# Required-action failure conversations

INF-1137 friction 2 gives a required-action card an ordinary It failed action beside its completion action and keeps its output and repair conversation on the card.
The first mate's per-turn context for a reply on a required-action card owns the rule: answer with the same id, `task_id` and `reply`, arrange repair through the crew, and keep repair status in that thread without confirming for the captain.
The host preserves its instructions and completion controls rather than accepting a replacement body.
The relevant turn grows by about 60 tokens; unrelated turns and the fixed tool descriptions do not grow.
