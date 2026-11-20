# Schedules run on chosen weekdays in a time zone, and name their rule and project

FI3-1512, the rest of Automation version one from FI3-1457's plan, which the captain approved with "Approve and build" for scheduled automations only.
`schedule_prompt` gains `days` (weekdays, `sun` to `sat`, with `daily_at`), `time_zone` (an IANA zone, defaulting to this computer's), `name` and `project` (a project key from the tasks index).
"Every Sunday at 7:00 AM" is now one schedule, and a daily or weekly schedule keeps its zone when the computer travels.
A scheduled wake now names the rule it came from and its project: `[fm-op] scheduled by automation <id> "<name>" for project <KEY> (<name>): <prompt>`, and a saved prompt's schedule details (`{{scheduled time}}`, `{{time zone}}`, `{{missed runs}}`) arrive filled in.
`cancel_schedule`'s description and three parameter descriptions that the tool's own description already says were cut to pay for the new parameters, so the fixed context stays inside its 18,250 budget.

The ledger entry that comes with it:

FI3-1512. schedule_prompt takes days, time_zone, name and project; a scheduled wake names its automation and project, with schedule details filled in.
