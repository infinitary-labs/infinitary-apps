# Personal-panel lint fixtures

One directory per `pluginLint` rule (`src/core/plugins/pluginLint.ts`), each a
panel written the way an author actually gets the rule wrong, plus `clean/`,
which must produce no finding at all. `pluginLint.test.ts` runs the real lint
over these files; they are deliberately not part of any tsconfig project, so a
fixture stays exactly as written.
