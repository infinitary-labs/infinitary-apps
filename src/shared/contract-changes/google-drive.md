# The Google row says whether its sign-in has Drive

A Google row's `client` in `inf:integrations:list` and the `inf:integrations` push may carry `withoutDrive: true`: the sign-in left out Drive, so Drive, Docs and Sheets actions are refused while Gmail and Calendar work (`integrationClientViewSchema`, `src/shared/integrations.ts`).
Its `client.mcp` may carry `off`, every Google MCP service that is off, Drive, Docs and Sheets included; `services` still names the Gmail and Calendar ones among them.
A view from before has neither field: it shows a sign-in without Drive as connected with no line, and names only Gmail and Calendar when services are off.
