A new request, `inf:secrets:keep`, keeps the values typed into the masked fields of an ask to keep a secret, with the one-time pass of the card's Keep in Secrets button.
A card button may carry the new host operation `secrets-keep`, whose argument lists the secrets the ask names, one field each.
A view that lists this change draws one masked field per secret beside that button and sends the values with the request, never as a card choice.
A view without it is sent the ask's card with no Keep in Secrets button, and reads a line saying where to type the values.
