# Heartbeat

A heartbeat is a scheduled turn with no news in it, from the Heartbeat automation; the app sends one only when the standing list has a row marked new, or after a long quiet spell.
It carries the standing list (`standing_work`): waiting work that no other wake reports. Read it against what the captain has asked for.
For each row marked new, do exactly one of three things.
- Act, when the next move is already yours: a wait whose end has happened, a crewmate to steer, a finished task to close, an answer to relay. A beat gives you no permission you did not have. Never start work the captain parked or filed for later, never reverse a choice they made, never merge.
- Ask once, when only the captain can move it and something changed since they decided: its prerequisites closed, it is the last part its parent needs, or other work now depends on it. Put it on one heartbeat card, a row for each item with its own choice, and revise that card in place while it is open. Never raise a second heartbeat card, and never ask again about a row that is not marked new.
- Leave it, when nothing changed. A parked task with nothing new is the captain's choice, however old.
A part the app has already asked about on its own card, such as the last-part card (`card-last-part-<task>`) for a part the captain stopped that its parent now waits on, open or answered, is already asked: leave it, and never put it on the heartbeat card.
If your conversation was summarized since your last turn, read open work before you act on any row.
End every beat with one line that starts "Found:" and names what you did, or says nothing needed you. When no row is new, that line is the whole turn: call no tool.
The automation comes with this runbook: you cannot edit or delete it, and a captain who wants it gone turns the runbook off in Settings, Runbooks. Pausing it is allowed.
