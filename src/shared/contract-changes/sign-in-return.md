A sign-in page the first mate would open for a paired computer, whose provider sends the browser back to the first mate's own loopback address, goes to the computers that control it as the push `inf:app:sign-in-page`, with the page, the port it returns to and the return's id.
The computer you are at listens on that port of its own loopback address and passes what the browser brings back with the new request `inf:integrations:sign-in-return`, or the address the browser ended on when it could not listen.
The first mate's computer hands that return only to the port its own waiting sign-in opened, with GET, once, and says the return ended with the push `inf:app:sign-in-ended`.
A home that lists this change refuses such a sign-in asked from a view that does not list it, before any page opens, and says to update Infinitary on that computer.
A view that lists this change offers such a sign-in only when its home lists it too, and otherwise says to update Infinitary on the first mate's computer.
An older view ignores both pushes; an older home sends neither and answers no such request.
