Adds `crewmate` to a card's optional `answeredBy` (`Card`), beside `firstmate`.
The app sets it on its own card for a crewmate's ask - a secret to keep or use, secrets to move in, an integration call - so a reply under the card reaches the crewmate that asked.
It rides `inf:cards:list` and the `inf:cards` push.
A desktop view whose hello does not list the change reads `answeredBy` as a closed set, so a home leaves a `crewmate` answerer out of the cards it sends there, and such a view draws the card with no reply row; before, it drew one answered by the first mate on a secret ask, use or move-in card.
A view that lists the change keeps a card with a secret's masked field free of a plain field beside it, so a home also leaves any answerer off such a card for a view that does not list it, the phone included.
