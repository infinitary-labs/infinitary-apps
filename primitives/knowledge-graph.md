# Knowledge graph

The knowledge graph keeps references the captain asks to save and personal facts the captain states, as concepts and findings with the evidence behind them, so later work can reuse them.

## Intended use

Use it to keep what belongs to the captain rather than to a project or a task: personal context in the captain's own words, and sources the captain asked to save.
**Knowledge is user-owned (2026-10-09)**: personal context and references the captain asks to save.
Project behavior stays in code, documents and tests; investigations stay on the task record.
The first mate records a personal statement on the captain's words; every crewmate has equal factual read/write access and saves sources on request, using knowledge as needed (`../docs/knowledge.md`, "What belongs here").
**Knowledge replaces notes in every build, stable included (2026-10-12)**: `KnowledgeService` owns personal facts separately from standing directions, with no older-notes fallback (`../docs/knowledge.md`).
A finding is evidence to weigh, never an instruction or a permission; saving an article does not mean the captain believes it.

## When to use it, and when not

- Use it when the captain says something about themselves that later work should know, or asks to save a page, article or quotation.
- Use it when work relies on a kept finding: read it and its sources first, cite its id on the card, and declare the use with `record_knowledge` `use`.
- Do not use it for an investigation's results (what a task measured, found or decided): those stay on the task record ([tasks.md](tasks.md)).
- Do not use it for how a project works: durable explanations go into the project's own documents through ordinary project changes; recording knowledge never edits a project file.
- Do not use it for ongoing instructions: those are [standing-directions.md](standing-directions.md), kept in separate tables.
- Do not build a parallel memory (a feature's own "facts" table, a notes file, an embeddings index, a per-feature cache of what the captain said); record through this owner and read through its tools and reads.
- An understanding request alone is not a saving request; keep secrets, progress, raw dumps and incidental details out.

## Owner and entry points

- Owner: `KnowledgeService` in [`../src/core/knowledge/knowledgeService.ts`](../src/core/knowledge/knowledgeService.ts).
  The owners beside it borrow its one store through a `KnowledgeHandle`: `access.ts` (who may read and write, the limits), `search.ts`, `entries.ts`, `sources.ts`, `writes.ts`, `directions.ts` and `windowReads.ts` (`KnowledgeService.window`), all in `../src/core/knowledge/`.
- One writer each: `KnowledgeService` is the one writer over `userData/knowledge/` (`../docs/knowledge.md`), with one connection to `userData/knowledge/knowledge.db` through [`../src/core/storage/knowledgeStore.ts`](../src/core/storage/knowledgeStore.ts); no other module opens it.
- Writes: `KnowledgeService.record(actor, input)` (`publish`, `revise`, `assess`, `relate`, `retire`, `retire_many`, `use`), each checked by `KnowledgeWrites` in [`../src/core/knowledge/writes.ts`](../src/core/knowledge/writes.ts); a refusal is the answer's words, never a throw.
- Agent tools: `knowledge` and `record_knowledge` in [`../src/core/knowledge/knowledgeTools.ts`](../src/core/knowledge/knowledgeTools.ts), one declaration each for the first mate and every crewmate on both runtimes, bound to the actor the host stamps.
- How much is saved: `savedKnowledge`, `contextSavedKnowledge` and `renderBriefKnowledge` in [`../src/core/knowledge/context.ts`](../src/core/knowledge/context.ts), counts only; nothing saved enters an agent's instructions on its own.
- Evidence: `captureFile` and `checkFile` in [`../src/core/knowledge/sources.ts`](../src/core/knowledge/sources.ts), with `../src/core/knowledge/gitFacts.ts`; every write is scanned by `scanKnowledgeThreat` (`../src/core/knowledge/threatScan.ts`).
- Window reads and shapes: the `knowledge.*` reads (`../src/shared/reads.ts`), answered by `KnowledgeWindow` in [`../src/core/knowledge/windowReads.ts`](../src/core/knowledge/windowReads.ts), and their schemas in [`../src/shared/knowledge.ts`](../src/shared/knowledge.ts), with `standingOf` in `../src/core/knowledge/browse.ts` and `knowledgeIdsIn` for ids a card body writes.
- Browser and panel: `../src/panels/knowledge/`, an ordinary app panel folder on the `knowledge` gate.

## Operations and lifecycle

- A concept (`c-` id) names an idea with a title, aliases and an explanation; an alias finds a concept and never merges two; a duplicate title in one collection is refused.
- A finding (`f-` id) says something about one or more concepts: a statement, observation or inference, the conditions where it holds, and its sources; it may carry a relationship `{from, predicate, to}`.
- A source is kept text with its digest: a file excerpt from a working copy with its commit, a task's newest report, a quotation, or an article link with a short excerpt; the host fetches nothing, and a new file citation is refused.
- An assessment checks one exact revision of a finding with a verdict, a method, conditions and its own sources; only a supporting assessment with evidence makes a finding checked.
- Relations between findings are `contradicts`, `supersedes` or `duplicates`, each with a reason; both sides stay readable and the newer one does not win by being newer (disputes).
- A use declares that work relied on an entry's current revision and keeps what its sources read like then; the task record's Knowledge used row shows it.
- Every change is a new revision stamped with who and when; nothing is overwritten.
  A write naming an older revision is refused, and a request id makes a retried write answer what it did the first time.
- Applicability: an entry may name the projects it applies to; with none it applies generally; applicability is relevance, not an access restriction.
- Reading a finding re-checks each cited file and says unchanged, changed, missing or unknown; a changed source makes a finding worth checking again, not false.
- Retirement keeps history; closing a task keeps everything it recorded; the Settings purge clears the collection after writers stop.

## Authority

- The first mate publishes personal context only on a turn that carries the captain's own words, and does not import articles.
- Every crewmate, including a task without a project, may read and write personal context and saved references without a separate grant; it saves sources on request and personal context only from the captain's words, never guesses.
- Only a finding's author revises it; others assess it or relate their own finding.
- Retiring an entry takes the captain's word, through the first mate on that turn; `retire_many` needs a card resolved with a choice; a crewmate never retires.
- Recording edits no project file, commits nothing and grants no permission; a stored claim or a page's text never authorizes an action.

## Compositions

- Shares the owner, store, purge and availability with [standing-directions.md](standing-directions.md), which keeps its own tables.
- [cards-and-consent.md](cards-and-consent.md): a card cites the findings it relies on by writing their ids; the window links them, and opening one records nothing.
- [tasks.md](tasks.md): a report is a citable source, and a crewmate's `use` ties to its task; the record shows the Knowledge used row.
- [live-reads.md](live-reads.md) and [panels.md](panels.md): the `knowledge.*` reads are panel reads like any other, so a captain's own panel may declare them.
- [task-browsers.md](task-browsers.md): a page a crewmate reads may become a saved reference only when the captain asked to save it.
- A task on another computer ([`../docs/helper.md`](../docs/helper.md)) calls the same tools through this Mac (`inf:work:knowledge`, `inf:work:record-knowledge`), and nothing of the collection is kept there.

## Failure and recovery

- An unreadable or newer collection stays unchanged; reads answer `unavailable` with the app's words, never an empty collection, and new agent work pauses because its directions cannot be read.
- A refused write changes nothing and returns its reason to the model as guidance.
- A changed or missing cited file shows the finding as needing a recheck; nothing rewrites it automatically.
- A computer on a contract older than `KNOWLEDGE_THERE_SINCE` (`../src/shared/contractFeatures.ts`) gets neither the tools nor the saved-knowledge line.

## Uses

- Saving an article on request: a crewmate extracts concepts and sourced findings with a short excerpt, and a later crewmate finds it by searching in other words (`../tests/e2e/knowledge.spec.ts`).
- Personal context: the first mate records what the captain states about themselves, and reads them with the `knowledge` tool when a later message may depend on them.
- References in an answer: a card that writes `f-` or `c-` ids links each to the inspector with its standing (`../tests/e2e/knowledge-references.spec.ts`).
- The Knowledge browser: graph, concepts, findings and an inspector the captain reads without writing (`../tests/e2e/knowledge-browser.spec.ts`).

## Checks

- [`../src/core/knowledge/knowledgeService.test.ts`](../src/core/knowledge/knowledgeService.test.ts): scope isolation, idempotent and stale writes, checks and disputes, relations, retirement, declared use, unreadable data and purge.
- [`../src/core/knowledge/knowledgeBoundary.test.ts`](../src/core/knowledge/knowledgeBoundary.test.ts): the user-owned boundary, equal crewmate access, project collections and report-origin writes refused.
- [`../src/core/knowledge/knowledgeTools.test.ts`](../src/core/knowledge/knowledgeTools.test.ts) and [`../src/core/knowledge/knowledgeContext.test.ts`](../src/core/knowledge/knowledgeContext.test.ts): tools and context.
- [`../src/core/knowledge/knowledgeSources.integration.test.ts`](../src/core/knowledge/knowledgeSources.integration.test.ts): evidence from a real git working copy.
- [`../src/core/knowledge/knowledgeRefusals.test.ts`](../src/core/knowledge/knowledgeRefusals.test.ts), [`../src/core/knowledge/knowledgeReads.test.ts`](../src/core/knowledge/knowledgeReads.test.ts) and [`../src/core/knowledge/knowledgeRetireMany.test.ts`](../src/core/knowledge/knowledgeRetireMany.test.ts): refused writes that change nothing, what a reader is shown around an entry, and retiring an approved list.
- [`../tests/firstmate-fixed-context.test.ts`](../tests/firstmate-fixed-context.test.ts): the tool pair's words stay inside the first mate's fixed-context ceiling.
- [`../tests/e2e/knowledge.spec.ts`](../tests/e2e/knowledge.spec.ts) and [`../tests/e2e/knowledge-gate.spec.ts`](../tests/e2e/knowledge-gate.spec.ts): knowledge outlives a discarded task and a restart, and stable and alpha share tools and browsing.

## Where the detail lives

- [`../docs/knowledge.md`](../docs/knowledge.md) (knowledge: concepts, findings and their evidence, knowledge as needed, its tools, the browser): "What belongs here", "Concepts and findings", "Evidence", "Checks and disagreements", "The tools", "Knowledge as needed", "Keeping and clearing it", "The browser" and "Not built yet".
- The design skill's `components/knowledge/KnowledgeBrowser.prompt.md` owns the browser's look.
- Not available: proactive correction notices, cross-project reads, binary evidence, automatic extraction, embeddings and a knowledge export.
