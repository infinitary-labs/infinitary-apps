A new request, `inf:secrets:bring`, brings secrets from another tool into Secrets on the captain's press of a bring card's Bring into Secrets button: it carries the button's one-time pass and the ids of the rows the captain ticked, never a value.
A card button may carry the new host operation `secrets-bring`, whose argument lists the rows the window draws, one tick box each.
A view that lists this change draws the tick rows beside that button and sends the ticked rows with the request, never as a card choice.
A view without it is sent the bring's card with no Bring into Secrets button, and reads the card's words saying where to answer it.
A secret's history item may carry the new optional field `brought`, naming the tool a bring read.
