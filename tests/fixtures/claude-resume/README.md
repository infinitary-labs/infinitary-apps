# A resumed Claude session's results

The result messages one Claude session's clients wrote, read by `src/core/claude/claudeEvents.test.ts` ("a turn's usage, model by model").
Claude Code 2.1.325 ran in a throwaway home with a dummy subscription token against the local stub of the Anthropic API (`tests/helpers/anthropicDialect.ts`), which answers every request with 42 input and 7 output tokens, so nothing was billed.

- `results.json`: `firstClient` is the result of the session's first turn; that client then exited.
  `resumedClient` holds the two results of the client that resumed the session next.
  Its `modelUsage` starts from the totals the first client left (84, then 126 input tokens), while each `model_usage_since_last_result` states that result's own calls (42 input tokens).
  Each message is whole, as the client wrote it.
