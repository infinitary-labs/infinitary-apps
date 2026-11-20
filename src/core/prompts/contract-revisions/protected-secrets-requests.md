# Protected Secrets requests and outcomes

INF-1109 implements INF-30's exact-use approval and separation of secret access from external-action consent.
A crewmate receives `CREWMATE_SECRETS_LINE` from `src/core/secrets/commandWords.ts` only when its local task channel actually grants the closed Secrets command facade.
That line owns reference discovery, exact requests, status and cancellation, the refusal to collect values in a card or conversation, and ending a turn while a request waits.
A crewmate on another computer whose task channel lists the home's catalog receives `CREWMATE_SECRETS_CATALOG_LINE` instead: discovery only, no request, and a use the work needs goes in its report.
The `secrets-use-ended` wake in `src/core/orchestrator/wakes.ts` owns the terminal-result notice: it conveys metadata after cleanup, never values, new-use approval or permission to repeat an unknown effect.
A restart requires reading status and reconciling an unknown outcome rather than replaying the request.
No fixed first-mate context grows; the additional command instructions are conditional on the actual granted capability.
