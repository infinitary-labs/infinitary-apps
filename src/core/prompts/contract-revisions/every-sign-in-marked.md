# A crewmate marks every sign-in, account creation included

A planning task traced why a task's browser asked the captain to sign in to one site three times: a handoff where the captain created an account was not marked a sign-in, so it opened outside the kept browser profile and the sign-in ended with that browser.
The captain approved the plan to close that gap with the other three in one change.

The crewmate's `emit_card` `browser_sign_in` parameter now says to mark a handoff whenever the captain will sign in to the site or create an account there, where it said "when what you need from the captain is a sign-in to the site".
The rule's one home stays that parameter's description; the first mate's served text is unchanged.
The wording is two words longer, so the crewmate's fixed context grows by a few tokens (`tests/crewmate-fixed-context.test.ts`).
