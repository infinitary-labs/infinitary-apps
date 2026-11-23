`inf:secrets:action` takes `copy`, which puts one secret's value on the home computer's own clipboard after its system confirmation, and `clear-copy`, which takes it off again.
The Secrets view may carry `copy`, whether this computer can confirm a copy, and `copied`, the secret on the clipboard now and when it clears; an entry may carry `lastCopied` and a use in the history `copied`.
A view without the change offers no Copy value and ignores the new fields, and a home without it refuses both actions as input it does not take.
The first mate's `secrets-page` handover may name one `secret` instead of a page, which opens that secret's row; a view without the change opens Secrets as it is.
