# The Google row names what Google's MCP servers refused

Each Google row and addable entry in `inf:integrations:list` and the `inf:integrations` push may carry `client.mcp`: Google's Gmail or Calendar MCP server refused the sign-in's calls though the sign-in stands, because the client is not marked for an AI-powered agent (`agent`) or the named services' MCP servers are off (`service`), with the Google Cloud page that fixes it (`integrationClientViewSchema`, `src/shared/integrations.ts`).
A view from before has no field of that name and shows the row as connected, with no line or link.
