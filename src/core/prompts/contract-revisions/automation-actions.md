# The first mate changes Automation's rules through the catalog

INF-752, found while auditing INF-638: everything the captain can do to a schedule in Settings → Automation, the first mate can now do through the same path, and Automation's own changes leave the same trail.
`app_change` gains four actions over `inf:automation:list`, in a new `automation` area: `automation-edit` (asked) edits a rule by id and turns a draft or a paused rule on with `enable`; `automation-state`, `automation-pause-all` and `automation-delete` pause, resume, pause all and delete.
Those three are a new tier, `judgment`: the first mate's at any wake, with its own reason as evidence rather than the captain's ask, since making a schedule is already its own judgment (captain decision Q4).
`app_state` says "judgment on your own reason, each at any wake", and `app_change` says an action's evidence is the captain's ask "never your own, except a judgment action's, which gives your reason".
`cancel_schedule` keeps its name and words and now runs `automation-delete`, so its feed line names the first mate and its operation is the catalog's.
`schedule_prompt`'s draft answer says a draft is turned on in Settings → Automation, or with `automation-edit` when the captain asks.
The four action names, the area and the two clauses cost the fixed part 45 tokens by the app's count; with them it measures 19,380, under the 19,772 boundary.
