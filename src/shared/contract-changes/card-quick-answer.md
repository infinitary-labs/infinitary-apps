Adds an optional `quick` mark to a card on the stage (`Card`): true on a crewmate's card whose task was sorted as a quick answer, which a view draws as the Quick answer chip.
The home computes it from the task's recorded kind on each snapshot and never stores it on the card.
A view or phone without the change ignores it and draws the card without the chip, and a home without it never sends it.
