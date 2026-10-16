# Schedules can be drafts, and a scheduled wake can say it waited

FI3-1517, the last of Automation version one from FI3-1457's plan, which the captain approved to build for scheduled automations only.
The plan says an underspecified request stays a draft and new ongoing rules need the captain's direction.
`schedule_prompt` gains `draft`: Firstmate passes it when the captain's ask leaves details open, and the captain turns the rule on in Settings → Automation after a review.
A recurring schedule made outside a captain's own turn is saved as a draft whatever Firstmate passes, and the tool's answer says so; a one-time reminder still runs.
The context block's schedule list marks a draft `(draft)` as it marks a paused one `(paused)`.
A scheduled wake carries its run's id, unrendered, and a delivery that later occurrences folded into while it waited unsent reads "missed while Firstmate was closed or busy" instead of "closed".

The tool's description pays for the new words: "recurring or once" (the parameters say it) went, and "Fires only while the app runs; missed fires run once at the next launch, flagged as catch-up." became "Runs only while the app does; missed runs fold into one.", since the wake itself says catch-up.
The fixed context stays inside its 18,250 budget.

The ledger entry that comes with it:

FI3-1517. schedule_prompt takes draft; a recurring schedule made outside a captain's turn is a draft; a scheduled wake carries its run and says when it waited.
