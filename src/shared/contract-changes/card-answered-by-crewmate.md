Adds `crewmate` to a card's optional `answeredBy` (`Card`), beside `firstmate`.
The app sets it on its own card for a crewmate's ask - a secret to keep or use, secrets to move in, an integration call - so a reply under the card reaches the crewmate that asked.
It rides `inf:cards:list` and the `inf:cards` push.
A desktop view whose hello does not list the change reads `answeredBy` as a closed set, so a home leaves a `crewmate` answerer out of the cards it sends there, and such a view draws the card with no reply row, as before.
A phone reads the field as text and takes the reply once it reads the new answerer.
