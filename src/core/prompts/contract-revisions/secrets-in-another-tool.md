# Secrets already in another tool

INF-4718's approved plan, piece 2, with the captain's ruling that the move guidance is not read on every session and loads only when a person wants to move secrets.
The first mate's `ask_secret` description now ends with one sentence: never ask for a secret the captain keeps in another tool, because a crewmate moves it with the `bring-secrets` skill.
That sentence's one home is the `ask_secret` description; the procedure itself lives only in the skill, which the built-in runbook Moving secrets in holds with no first-mate or crew section, so no fixed context carries it.
The description's first sentence says the same rules in fewer words to make room.
The fixed context grows by about 18 tokens (`tests/firstmate-fixed-context.test.ts`).
