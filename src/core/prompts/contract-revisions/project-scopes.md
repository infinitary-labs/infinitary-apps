# Project scopes and context lifetime

INF-1117, approved direction A with the captain's smart-injection change: project-settings accepts optional scope text and the first mate uses project scopes to choose where new work goes.
A named project wins and a follow-up stays with its work's project; otherwise the first mate asks when no scope or multiple scopes fit.
The context carries every project's name, id and scope, or "not set", on first attachment and when the snapshot changes.
An unchanged next turn omits scopes, and successful backend compaction invalidates the shown snapshot so the next turn carries it again.
A new or rebound session and an app restart start without a shown snapshot.
The ordinary per-turn project list and focus hint do not repeat scope text.
The personal workspace has no scope, and the host makes no scope-fit judgment.
