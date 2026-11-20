# Withdrawing a phone's notifications

A phone's registration for `inf:devices:push` may carry the new optional field `withdrawals: true`, saying the phone removes the notifications a sealed withdrawal names (docs/phone-push.md, "Withdrawals").
The computer keeps the flag beside the registration and, for a phone that set it, posts a withdrawal to the relay's withdraw request once a card it pushed there was seen or left the stage.
A sealed card push also gains the optional field `push`, a random name for that push, which a withdrawal names for each card so the phone removes only the pushes named and keeps any other push of the same card; a phone without this change ignores it.
A computer without this change does not list it, so a phone sends it no flag, since that computer's registration refuses unknown fields, and that phone's notifications stay until Infinitary opens there.
