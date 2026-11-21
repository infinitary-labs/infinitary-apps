# Credits past the allowance

Provider answers the credits fact, and Codex's saved resets, are read from (`docs/quota.md`, "Credits past the allowance").
Each file is one whole answer as the provider sends it, read by `src/core/quota/credits.test.ts`, `src/core/claude/claudeEvents.test.ts` and their neighbours.

- `claude-usage.json`: Claude's usage reading of a Max account with extra usage switched off, captured live.
- `codex-usage-credits.json`: ChatGPT's Codex usage reading of a Pro account with credits and one saved reset that does not apply yet (`docs/quota.md`, "Saved resets"), captured live and trimmed of the account's identity.
- `claude-rate-limit-*.json`: the reading the Claude client pushes mid-session, on extra usage and out of credits, written from the client's published `SDKRateLimitInfo` type, not captured live.
