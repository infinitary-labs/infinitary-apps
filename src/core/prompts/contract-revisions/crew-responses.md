# Default correlated crewmate responses

INF-2214's accepted default policy makes every first mate tool message to a crewmate expect a response unless explicitly guidance-only.
The rule's home is steer_crewmate's description and response_mode parameter, with explicit cancellation references beside it; dispatch briefs and host operational wakes keep their existing semantics.
The report tool's responses parameter names each request, stable response identity and final or not-yet-answered status; the inbox owner saves its exact text and wake immediately, without needs_firstmate or turn-end conditions.
The response-request wake teaches correlation, the requested-response wake identifies the actual contributor, and response-missing reports a consumed clean turn's absence without treating unrelated reports as answers.
Queued, backend-confirmed delivery and clean handling remain different facts, and a handling acknowledgement proves no judgment about correctness.
The first mate tool surface grows by roughly 100 tokens for default response tracking and explicit cancellation; the crewmate response schema and wake instructions are outside the first mate's fixed context.
