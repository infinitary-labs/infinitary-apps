# The first mate hands the captain an MCP server's sign-in

From the plan for MCP servers at an address that ask for a sign-in: the sign-in is made in the captain's browser, never from the first mate's turn.
`integration-add` now takes kind `mcp` with a name and the server's https address, and its card opens the MCP form in Settings → Integrations filled in, where the captain's Connect opens the sign-in page.
`integration-add-mcp`'s line says such a server is refused, and that `integration-add` with kind `mcp` offers it instead.
The home of the new words is each line in the action catalog (`src/shared/actions.ts`); no other text changes.
