# Crewmates fix what their pictures show wrong before the story

INF-3826 builds direction B of INF-3814's plan, which the captain chose: the change story waits until every fault the crewmate notices is fixed.
The captain had named a visible fault in a merge card's own After picture on four cards in six days, each picture already opened by its crewmate, because the served picture rule asked only whether a capture was whole.

The served picture rule in the crewmate core now asks for two looks.
The first is the author's: does the picture show what it means to, whole, and not blank, half-drawn or cut off.
The second is a person's who uses the view and has never seen the change: what would that person call wrong, such as covered words, clipped text, crowded spacing or something out of line.
The crewmate fixes every fault its change caused, takes the picture again and gives the new take both looks before showing it, and fixes what it doubts.
A fault that was there before the change is not fixed in passing, and a choice the captain's words or an approved plan made is not a fault.

`prepare_change`'s `story` description says each After picture or poster carries `faults`, the crewmate's answer for that final take, and the parse refuses a story while any fault's cause is `change`.
Its one home is the story parameter's description; the shape and refusal are `src/shared/changePresentation.ts`'s.
The Firstmate's prompt and tools do not change.
