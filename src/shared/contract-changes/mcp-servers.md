# MCP servers as integrations

`inf:integrations:add` is a new home-only change: it adds an MCP server from the person's name for it and what it runs, and answers the new row's id with the integrations view (`docs/integrations.md`, "MCP servers").
The integrations view admits the kind `mcp`, and two optional fields on a row: `runs`, what an MCP server runs, and `events`, what a row can tell a listening rule.
Every integrations request is answered only on the home, since its reach is the home, so no paired device asks for the view or sends the change.
The `inf:integrations` push still reaches a paired device unchecked, and an older view that draws it shows an MCP server's row the way it shows GitHub's, with no form to add one.
