# The captain decides and the fleet does the work

INF-863, approved with home A (one shared text) and the captain's later request not to assume a user's gender.
`FLEET_WORK` in `src/core/prompts/fleetWork.ts` is the single home for the approved principle, served once after each persona core.
It replaces the first mate's narrower Settings/manual-work and click-a-card sentences.
The shared rule asks agents to check whether work is already done, do what the fleet can do, and ask only for the captain-only contribution, as one click where available.
A cost to weigh asks for consent, not manual work.
The `required_actions` parameter is the home for its application to required actions: only captain-only contributions; post-merge fleet work becomes a `Continue: …` filing.
Consent gates, sign-in and signing boundaries, card effects and escalation paths are unchanged.
Both personas, tool descriptions, task briefs, wakes, refusals and instruction documents refer to the captain without assuming gender.
Historical quotations and prior contract revision records remain evidence of their original wording.
The shared paragraph adds about 150 tokens per persona, less the two removed first-mate sentences; wording-only substitutions also change the fixed context's size.

The added rule would cross the existing fixed-context allowance without trimming.
The gender-neutral card-reply and time-zone sentences are expressed more concisely with the same duties and boundaries; the allowance and conversation promise stay unchanged.
