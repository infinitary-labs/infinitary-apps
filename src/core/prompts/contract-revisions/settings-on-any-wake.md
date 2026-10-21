# The first mate applies a setting the captain asked for, whatever began its turn

INF-751, filed from INF-638 as the rest of the captain's "i think we still have a pending workstream to fix the rigidness - can you add that to the scope?": every asked and own-words line of the app action catalog refused his choice when a crewmate relayed it in a report, and refused a message he sent while a turn ran, because the dispatcher read only the wake that began the turn.
The dispatcher no longer reads the wake for those tiers: the first mate applies one at any wake with his ask as its evidence, the way INF-638 lets it keep his directions on its own judgment, and a change with no evidence is refused with "Give the captain's words, choice or schedule that asked for this change."
A project change the first mate declares with `on_words` applies at any wake too, except in the turn a click on its own card began, where the app's exact-change card still applies it.
`app_change`'s description now says "evidence quotes the captain's ask, whatever began the turn: his message, his choice on any card (a crewmate relays one) or a schedule he set, never your own; ... need his typed words", in place of "Asked actions quote a captain message or captain-set schedule, never autonomous or legacy schedules; ... need the captain's typed message".
`app_state`'s description says "asked means the captain asked in any form, own-words in his typed words, at any wake".
The first mate's fixed context is about 9 tokens larger, 19,303 by the app's count (`tests/firstmate-fixed-context.test.ts`).
