# Check approval and one checklist for a version's gaps

INF-1824's accepted plan, direction B, with the captain's written-in answer that the approval stays generic and never names a sign-in.
A check in a Careful task's list of live checks may declare its resources, what a run uses or reaches, and the cost of one run.
`CAREFUL_LIVE_VALIDATION` in `prompts/liveValidation.ts` now tells the builder to ask once with a typed check request, kept on the check by its id for every later run and version while it declares the same resources and cost; a pick or written-in answer on a card bound to that request approves it with no separate approval card.
The same text asks about every gap of one version on one card through `emit_card.validation_request.gaps`, drawn by the app as a checklist, and keeps an accepted gap until that check runs and fails or leaves the list of checks.
The reviewer's Careful paragraph judges rewordings and runs against the declared resources and cost.
The crewmate's `emit_card.validation_request` parameter gains `gaps`, and its description, `report.validation`'s description and the verdict description are shorter, leaving the rules they repeated to the Careful brief, so the crewmate's fixed context stays inside its budget; the Firstmate's fixed context is unchanged.
Separate persistent-effect requests, write approvals, browser handoffs, merge consent and the review allowance remain unchanged.
