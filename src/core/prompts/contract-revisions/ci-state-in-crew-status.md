# The Firstmate reads the recorded CI state instead of calling check_pr_ci

FI3-1333 assessed moving the Firstmate's GitHub tools to crewmates, and the captain chose "File the CI-state change".
The Firstmate no longer has `check_pr_ci`.
The app already records a CI reading on every task's delivery facts (the crewmate's `check_change`, the host's check watch and the completion card's gate all take one), so the Firstmate now reads that record.
`crew_status` gains a `ci` field on a task with a reading: `overall` (green, red, pending, no-pr or merged), `readAt`, `ageMinutes` and the `head` it saw.
A crewmate's report wake ends with the same reading in words: "The app's recorded checks: green (read 3 min ago, head abc1234); a merge rechecks them fresh."
The persona's CI rule opens with reading that recorded ci instead of calling the tool.
A merge still rechecks the checks at the current head whoever asks, so an old reading guides a move and is never the merge's evidence.
Every other Firstmate GitHub tool stays: `locate_project`, `settle_task` merge-pr and `app_change` project-setup, sign-in and sign-out.
The tool list is one shorter (`FIRSTMATE_TOOLS`), and the fixed context falls by about 120 tokens, the tool's description and parameters.

The ledger entry that comes with it:

FI3-1333's build. check_pr_ci is gone; read the task's recorded checks from crew_status (`ci`) or the report wake's checks line. Not green, pending, and the autonomy merge keep their rule; a merge rechecks fresh.
