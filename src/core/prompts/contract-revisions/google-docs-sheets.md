# Google's row reaches Docs and Sheets

Docs and Sheets join the Google row as piece 3 of the plan that moves Google onto its MCP servers, under the captain's earlier answers: all of Drive, and a sign-in that leaves Drive out keeps Gmail and Calendar while Drive, Docs and Sheets wait for a new sign-in.

What the first mate is now told:

- The `integration-add` line says `google` connects Gmail, Calendar, Drive, Docs and Sheets.

Before and after, the one served sentence this alters:

- Altered, kept: "Connect an integration when asked (kind: github, gitlab, github-enterprise, google for Gmail, Calendar and Drive, ...)" now reads "google for Gmail, Calendar, Drive, Docs and Sheets"; nothing else in it changes.

Home: the `app_change` line (`src/shared/integrationActions.ts`).
The actions themselves are the row's own descriptions, which the integrations command serves when an agent reads the row; they are not part of this contract.
The fixed context does not grow: the line is served only when the first mate reads that area, and it is three words longer.
