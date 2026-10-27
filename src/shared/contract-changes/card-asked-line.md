# A card names the captain's message it is about

A card in the cards snapshot admits an optional `asked`: when the captain sent the message the card is about and their words, which a view draws as the "You asked" line (INF-1610).
The home reads it from the saved message through the card's task, never from the card's words, and keeps it off the stored card.
A card, its captured offer and a placed card request also admit an optional `answering`: its author's declaration that the card answers that message.
An older view ignores both fields and draws the card as before.
An older home drops `answering` from a placed card and sends no `asked`.
