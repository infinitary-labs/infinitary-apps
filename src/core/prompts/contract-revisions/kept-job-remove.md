# The first mate removes a job kept running past its task's close when asked

INF-4381's approved plan, piece 2 (the captain's "Approve and build" on direction A, a recorded keep listed in Automation): a job the captain asked a crewmate to keep running past its task's close is listed in Settings → Automation and the Automation panel under Kept running, and the first mate can remove one when the captain asks.
`app_change` gains the asked action `kept-job-remove` in the `automation` area, over `inf:automation:kept`, whose value is the job's `id` as `app_state` lists it.
It runs the job's own remove on the computer the job runs on, the same change Settings' Remove for good makes, and leaves one feed line saying whether the job was removed or stays listed with how its remove went.
The new action name costs the fixed part 4 tokens by the app's count; with it the fixed part measures 19,852.

The ledger entry that comes with it:

INF-4381. app_change gains kept-job-remove (asked): runs a kept job's remove on its computer, the same change as Settings → Automation's Remove for good, with one attributed trail.
