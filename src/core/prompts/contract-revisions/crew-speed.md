# Crew speed

FI3-1573 implements the accepted FI3-1572 choice: per-model speed in Models, shared across supporting accounts, with a task override.
`app_change crew-speed` sets a Codex offering's default; `spawn_crewmate.shape.override_speed` and `update_task.crew_speed` carry only the captain's explicit task choice.
A null update restores the model default.
Ultrafast consumes 8× included allowance or 6× purchased credits and stays off by default.
The choice reaches crew requests and their conversation summaries, never Firstmate or separate Decisions.
Unavailable speed uses Standard on the same model and account, with a task-timeline explanation.
The speed fields cost about 100 tokens; references to their one rule owner and shorter task descriptions offset them within the unchanged fixed-context budget.
The fixed persona text does not grow, and every existing task-editing rule remains served.
