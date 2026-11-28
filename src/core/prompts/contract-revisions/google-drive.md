# Google's row reaches Drive, and its saved content is Google content

Drive joins the Google row as piece 2 of the plan that moves Google onto its MCP servers, with the captain's answers: all of Drive, and a sign-in that leaves Drive out keeps Gmail and Calendar.

What the first mate is now told:

- The `integration-add` line says `google` connects Gmail, Calendar and Drive.
- The `delete-outside` line, and what it answers when done, call what it deletes Google content, as the Data row in Settings now does.
- A Drive action on a sign-in without Drive is refused before any approval card, with words naming Sign in again on the Google row; Gmail and Calendar keep working.

Home: the two `app_change` lines (`src/shared/integrationActions.ts`), and the refusal from a typed fact the host holds (the sign-in's granted permissions), never from reading the place's words.
The fixed context does not grow: the lines are served only when the first mate reads those areas.
