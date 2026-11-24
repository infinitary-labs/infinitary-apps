A crewmate's card from a computer that runs work (`inf:work:card`) gains the optional `asksAgain` `{ card, why }`: its crewmate asks again, on purpose, a question the captain answered on that earlier card (docs/card-threads.md, "A question already answered").
A home without this change drops the field and checks no repeated question, so the card shows as before.
A computer without this change never sends it, so a home with the change checks no repeated question from that computer's crewmates, which could not ask one again on purpose.
