# An MCP server's sign-in in the person's browser

`inf:integrations:add` takes an optional second argument, `{ signIn: true }`, with which a server at an address that asks for a sign-in opens its page in the person's browser; without it, such a server is refused as before.
`inf:integrations:sign-in-again` signs an MCP server's row in again in the browser, and `inf:integrations:sign-in-page` opens the waiting sign-in's page once more.
`IntegrationsView` gains `signingIn`, the waiting sign-in's name and page, and a row gains `signIn` when its server signed in.
An older side never sends the new argument or requests, and ignores the new fields.
