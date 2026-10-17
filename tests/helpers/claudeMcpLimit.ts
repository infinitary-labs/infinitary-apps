/**
 * INF-113: the installed Claude Code 2.1.299 MCP result guard defaults to
 * 25,000 tokens. It estimates text with Math.round(length / 4), accepts
 * estimates <= half the cap without a token-count request, and otherwise
 * counts tokens before deciding. docs/claude-client.md owns the contract.
 * Keep the real plan fixture within that unconditional acceptance band,
 * not merely a guessed conversion of the full token cap to characters.
 */
export const CLAUDE_MCP_DEFAULT_OUTPUT_TOKENS = 25_000;
const ESTIMATE_CHARACTERS_PER_TOKEN = 4;
const UNCONDITIONAL_CAP_FRACTION = 0.5;
export const CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS =
  CLAUDE_MCP_DEFAULT_OUTPUT_TOKENS * UNCONDITIONAL_CAP_FRACTION * ESTIMATE_CHARACTERS_PER_TOKEN;
