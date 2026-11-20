# Memory warning ID

INF-4182's accepted plan gives each memory warning one ID: memory, the computer, and when the warning began on the home's clock.
The captain chose that a warning is told once until the computer has read normal for 30 minutes, that its end reaches the first mate with one Activity line and no card, that a card returns after an answer only for a new warning, and that only a first turn to critical speaks again.
The resource-pressure wake now carries `warning: { id, since }` and says it is told once, what would be told again, and to offer at most one card per warning ID.
A new `memory-warning-ended` wake tells the warning's end once and asks for no card, and to take down an offer about that warning that nobody answered.
The Computer cleanup guide says the same for its offers.
The fixed context does not grow: the new words ride wakes and the runbook guide.
