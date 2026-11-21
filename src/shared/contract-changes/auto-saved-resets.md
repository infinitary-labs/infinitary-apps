Adds the request `inf:accounts:use-saved-resets`, which turns a Codex account's Use saved resets on their own on or off, here or on a computer that runs work, signing Codex in to the account first when asked.
Adds the order `inf:sign-ins:use-saved-resets`, which turns it on or off for one of a computer that runs work's own Codex accounts, saved only on that computer, turning it on with Codex's sign-in steps coming back as `inf:work:sign-in` and its end as a `signed-in` step, and turning it off saved and answered at once, with no steps.
Adds an optional `useSavedResets` field to each account view, an optional `autoSavedResets` field to each computer of `inf:devices:sign-ins`, saying it takes the order, and an optional `useSavedResets` field to the shell effect a card's click answers, naming the account whose row turns it on on arrival.
Adds the host operation `use-saved-resets` to the crew's run-out card.
A computer without the change is never sent the order, and the home shows the item dim, saying to update Infinitary there.
A view without the change is never sent the card's Use saved resets on their own, since the account's row it opens would not turn it on there.
