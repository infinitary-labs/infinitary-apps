# User-owned knowledge

FI3-1421 builds the boundary the captain saved on FI3-1338 ("Save this direction", boundary user-owned, writers split).
Knowledge keeps personal context and references the captain asks to save.
How a project works stays in its code, documents and tests, and what an investigation found stays on the task record.
Firstmate records a personal statement or correction only on the captain's words, and does not import an article.
A crewmate records an import or a reconciliation only when the task was granted `references` (`knowledge_access` on `spawn_crewmate`'s shape, and on `create_task`).
That grant reads and writes saved references only, not personal context.
The `knowledge` and `record_knowledge` descriptions say this boundary, and an article source is `{url, title, excerpt, author, published}`.
A saved link keeps one concept, a short excerpt, and no fetched page.
The tool descriptions stay short so the fixed context remains inside its ceiling.
The import procedure is in the granted crewmate's brief, not in the fixed context.
The shape group's one new rule is one sentence.
