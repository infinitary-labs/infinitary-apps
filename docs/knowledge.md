# Knowledge

What the captain keeps so later work can reuse it: personal context, and references the captain asks to save.
Concepts name and connect ideas, and findings say something about them with the evidence behind them.
It is the captain's approved design from FI3-1110 ("can you properly design the verified findings thing? i feel we need a new primitive that models knowledge"), built by FI3-1141, with the user-owned boundary the captain saved on FI3-1338.
Tasks own work, instructions and approvals own authority, and knowledge owns reusable claims: a finding is evidence to weigh, never an instruction or a permission.
How a project works stays in its code, documents and tests.
What an investigation measured, found or decided stays on the task record.
Standing directions live in Knowledge, separate from personal facts and saved references.
Saving an article does not mean the captain believes it, and neither a stored claim nor a page's text grants permission to act.

## Who has it

Knowledge runs in every build, including stable.
The panel, browser, tools, context and purge share the same service.
A task held on another computer (`docs/helper.md`) receives its project directions on every served turn and has the same Knowledge tools as one on this Mac: each call asks this Mac to read or write under the same actor and factual access, and nothing of the collection is kept there.

## Where it is kept

`KnowledgeService` (`src/core/knowledge/knowledgeService.ts`) is the one writer, with one connection to `userData/knowledge/knowledge.db` (`src/core/storage/knowledgeStore.ts`).
The owners beside it borrow that one store and never open their own: who may read and write and how much one call carries (`access.ts`), the full-text words (`search.ts`), an entry as both read sides show it (`entries.ts`), kept evidence (`sources.ts`), each write's checks (`writes.ts`), the standing directions (`StandingDirections` in `directions.ts`) and the captain's window (`KnowledgeWindow` in `windowReads.ts`).
The store has its own schema history and inspects a private snapshot before any writable connection touches it (`readDatabaseSnapshot`, `src/core/storage/db.ts`).
An unreadable or newer collection stays unchanged; new agent work pauses because its standing directions cannot be read.
Startup carries the remaining active directions before agents start, as described below; otherwise the collection stays lazy.
The main database's compatibility boundary refuses earlier builds that could still write notes.
Rows keep entries, revisions, sources, assessments, relations, uses and answered requests; edges and full-text search are projections rebuilt when an entry changes.
Directions and their edits use separate tables and never become factual search candidates.

## Concepts and findings

A concept (`c-` and six characters) names an idea: a title, aliases people use for it, a plain explanation, and read-together links to other concepts, each with its reason.
An alias finds a concept and never merges two of them; a second concept with the same title in one collection is refused.
A finding (`f-` and six characters) says something about one or more concepts: its statement, whether it is an observation (seen) or an inference (reasoned to), the conditions where it holds, and its sources.
A finding may carry a relationship, the claim it makes from one concept to another (`{from, predicate, to}`, read subject to object); that is how a connection between ideas comes with its evidence, and a relationship is no truer than the finding that claims it.

Every change is a new revision, stamped by the host with who made it and when; nothing is overwritten.
Anyone who can write a collection may revise its concepts, but only a finding's author revises the finding: someone else assesses it, or records their own finding and relates the two.
A write that names an older revision than the current one is refused, and every write carries a request id, so a retried call answers what it did the first time and a reused id with different contents is refused.

## What belongs here

Two kinds of entry live in the captain's collection.
The host stamps the factual category from `lane` on publication: crewmates default to reference, and use personal only for context grounded in the captain's words.
The first mate publishes personal context only; revision preserves the existing category.
The category describes data, not who can read or write it.
Personal context is what the captain states about themselves, including where it applies.
A saved reference is a source the captain asked to keep: its link, title, author and publication date when the page gives them, the date it was retrieved, and a short excerpt.
The page itself is not archived.
An entry may name the projects it applies to; with none, it applies generally.
There is no historical actor or historical project collection in browser or tool reads.
The captain approved deleting old project concepts and findings, together with their revisions, sources, assessments, relations, uses, search projections and answered requests.
Schema 4 removes them while keeping captain-owned personal context and saved references.

## Collections and who reads them

Personal context and saved references live in the captain's collection (`captain`).
Standing directions use the captain's global scope or an exact project identifier.
The Collection picker lists the captain's collection and projects for their directions; it does not expose old project facts.
The first mate reads all active directions and keeps them on its own judgment of what the captain wants, on any turn (below, "Directions are the first mate's to keep"); it writes a personal statement only on the captain's own turn.
It does not import an article or reconcile a saved reference; that is a crewmate's write.
Every crewmate can read and write personal context and saved references, including a task without a project.
Use applicability as relevance, not an access restriction.
A crewmate saves sources on request and personal context only from the captain's words, never guesses; access itself authorizes no unrelated saving.
A crewmate cannot retire an entry or change a direction.
Task tools offer no saving grant, and a task shape an older build saved with its `knowledge_access` grant reads without it (`docs/saved-data-compatibility.md`, "Retired task fields").
Every reference stays inside its collection, and an unreadable entry is indistinguishable from a missing one.
Project directions follow exact identifiers, never a matching project name.
Only that project's directions reach a crewmate, including fresh, resumed and placed turns; private global directions stay with the first mate.
A development practice the captain states for a project, such as how its tests, style, structure or commits work, is never a direction: it is how that project works, so the first mate has a crewmate write it into the project's own `AGENTS.md`, or the `CLAUDE.md` it keeps instead.
How the first mate runs a project's work, such as who merges, when work starts and which models it uses, stays a direction.

## Evidence

A source is kept text with its digest and where it came from, so it outlives the task that cited it.

- A file excerpt already kept came from the crewmate's own working copy (`src/core/knowledge/sources.ts`): a relative path, not through any link, not inside `.git`, a text file under 2 MB, at most 32 KB of lines, scanned like every other write.
  The host recorded the working copy's commit and whether the file differed from it (`src/core/knowledge/gitFacts.ts`).
  A new citation of a file is refused.
- A task's report is its newest report event, kept with that event's number.
- A quotation is attributed text with its citation; the app does not check it.
- An article is a link the captain asked to save, with its title, author and publication date when supplied, the retrieval date the host stamps, and an excerpt of at most 1,500 characters.
  The host fetches nothing.
  The same link keeps one concept: a second publish is refused, and a later import revises that concept or adds a finding.
  A finding may cite the article only after that concept exists, so the source stays findable even when it adds no claim.
  Searching the link finds the concept.

The first mate has no file reader, so it cites reports and quotations only.
A new file excerpt is refused: a file in the project stays with the project.
An article already kept is still checked as kept, not re-fetched.
A digest proves what was kept, never that it is true.

Reading a finding looks again at each cited file where the reader works - a crewmate's working copy on this Mac, else the project's own folder here, as for the first mate and a crewmate on another computer - and says whether it is unchanged, changed, missing, or unknown when there is nothing to compare.
A changed source does not make a finding false; it makes it worth checking again.

## Checks and disagreements

An assessment checks one exact revision of a finding with a verdict (supports, contradicts or inconclusive), the method used and the conditions it was checked under, and its own sources.
A finding reads as checked only while its current revision has a supporting assessment that cites evidence; a verdict without evidence is shown and checks nothing, and a contrary verdict without evidence reads as a challenge, not a dispute.
Revising a finding leaves earlier checks with the revision they checked.
Findings relate to each other as contradicts, supersedes (the newer replaces the older) or duplicates, each with its reason; both sides stay readable with their evidence, and neither the newer one nor where it is kept decides which is right.
A finding's status is one of not yet checked, checked, disputed, superseded or retired.

Retiring an entry takes the captain's word, through the first mate on that turn; a crewmate cannot retire one, and its history stays readable.
`retire_many` retires a whole approved list in one write (`id` names the approving task, plus `reason`), only on a captain turn.
The approval is the closing choice on a task's card: the card must have been resolved with a choice (a dismissal approves nothing), it retires every active entry that card names (the service also takes `ids` and `except` to narrow the list; the tool leaves them out to keep the first mate's fixed context inside its budget).
The first mate judges that the choice approved removal; the host reads no words.
Entries already retired or unreadable are left alone and listed, each retired entry keeps its history as a single retire does, and the whole list is one feed line.

## The tools

Two tools serve the first mate and every crewmate on both runtimes from one declaration each (`src/core/knowledge/knowledgeTools.ts`, in `CREWMATE_TOOLS` and `FIRSTMATE_TOOLS`), bound to the actor the host stamps.

- `knowledge` reads: `search` (names, aliases and text, ten a page), `get` (up to five entries or an earlier revision, source summaries and checks without kept text; kept text by `s-` id, standing directions by `d:` id), `neighbors` (one hop of links: claimed relationships, read-together links, findings about a concept, disagreements) and `history` (earlier revisions).
- `record_knowledge` writes: `publish`, `revise`, `assess`, `relate`, `retire`, `retire_many` and `use`, which declares that work relied on an entry's current revision and keeps what its sources read like then.
  The first mate writes personal context on the captain's words and keeps standing directions on its own judgment.
  Every crewmate may record requested factual knowledge without a separate grant.
  Removing an entry waits for the captain, and the first mate retires it on the captain's word.
  `text` is a concept's explanation, a finding's statement or a direction's wording, and a read-together link is `relate` with `related` and a reason.

The `knowledge` description also says that a card cites each finding it relies on by writing its id, which the app links (below, "References in an answer").
Their words are short on purpose: the pair is part of every first mate request, so it counts against the fixed-context ceiling a small local model's window is held to (`tests/firstmate-fixed-context.test.ts`).

The first mate publishes personal context only on a turn that carries the captain's own words.
Only a write that changed the collection is the turn's action for answer delivery (`docs/task-capture.md`); a read, a refusal and a repeated request are not, and the output-only retry refuses `record_knowledge` like any other change.
Recording edits no project file, commits nothing and grants no permission.

A crewmate on a computer that runs work (`docs/helper.md`, "Holding a conversation") holds the same pair, bound by this Mac to the same actor: its task and its project, without a saving grant.
That computer serves both tools and asks this Mac to run each call (`inf:work:knowledge`, `inf:work:record-knowledge`); this Mac answers with that binding and keeps the answer, so a call asked again after a drop is answered from what it kept.
Its brief carries the same knowledge lines, written here.
Its working copy there is no folder of this Mac's, so its actor names none: a kept file source reads against the project's own folder here, as the first mate's reads do, and a new file citation is refused there as it is here.
A computer on a contract older than `KNOWLEDGE_THERE_SINCE` (`src/shared/contractFeatures.ts`) is given neither the tool pair nor the factual candidate lines; applicable directions still ride each served turn.

| Bound | Size |
| --- | --- |
| A search or neighbors page | 10 entries within 4 KB |
| A whole-entry read or history page | 32 KB |
| One write, everything it carries | 16 KB |
| One kept source | 32 KB |
| The words an automatic lookup reads | 1 KB |
| An automatic shortlist | 5 entries within 2 KB |

### Directions are the first mate's to keep

The first mate adds, revises and retires the captain's standing directions on its own judgment of what the captain wants, whatever began the turn: the captain's words, the captain's choice on a card, a confirmation click and a message the captain sends while it works all count, and nothing checks which one it was (INF-638, the captain: "why not just give first mate a tool to freely read and write standing directions, and then rely on the agent's judgment on when/how to do it?").
It does so through the app action catalog, as it changes any setting: `app_change` with the `direction` line, whose `judgment` tier lets it act at any wake and keeps its evidence as the change's reason (`docs/orchestrator-contract.md`, "App action catalog").
The line's channel, `inf:knowledge:direction:set`, runs `StandingDirections.change` through the dispatcher, the same path a captain's own control takes, so each change leaves one feed line and one operation; Knowledge has no such control yet.
Every direction it writes is stamped `captain-turn`, the captain's instruction, and its history keeps the reason the first mate gave.
`record_knowledge` refuses a direction, pointing the first mate at `app_change`.
A crewmate never writes a direction; it reports the captain's words or choice with `needs_firstmate`.
The first mate reviews directions against facts each turn carries, including reports and updates: evidence that a condition ended or a built-in rule fully covers a direction prompts a retirement offer, not silent removal.
The offer names the direction and evidence and offers Retire and Keep; unresolved offers stay on their existing cards, and Keep stands unless new evidence changes the question.
Unmet or unknown conditions remain in direction text and are reconsidered when relevant facts arrive, never dispatched as tasks to wait for or check the trigger.
Unknown is not expired, and a fulfilled condition applies to authorized work rather than authorizing new work.
No host parser, trigger store or polling schedule decides these judgments.

## Knowledge as needed

Knowledge is the only source for personal context, saved references and standing directions.

- The first context of every first mate conversation carries the complete current directions in `directions`, regardless of the words searched or whether the turn is a background wake.
  When any direction changes, the next context carries the complete set again, and one emptied says so (`docs/orchestrator-contract.md`, "What a context carries").
- Every crewmate turn carries the complete current project directions, superseding earlier copies; retired directions have no active influence.
  The brief holds none of its own, so a first turn carries them once, and a brief served again to a new conversation carries no stale copy.
- Rendering never truncates directions to a character budget or a search page.
- Captain-origin directions are instructions, other origins are labeled advice, and neither grants permission.
- The first mate's `knowledge` shortlist contains topical personal entries matched from the captain's words; operational wakes carry none.
- Every crewmate's brief offers topical factual candidates, including tasks without projects, and the same conditional saving guidance.
  The common system instructions carry that policy on both runtimes, including resumed conversations, and explicitly supersede older grant or read-first requirements in saved briefs.
  Consult saved context or prior findings when useful; otherwise proceed without a lookup.
  Read a finding and its sources before relying on them.
  When asked to save a page, extract reusable concepts and sourced findings, keep short excerpts and metadata, reuse concepts, and preserve disagreements and earlier evidence.
  An understanding request alone is not a saving request; keep secrets, progress, raw dumps and incidental details out.
- Candidates carry identifiers and summaries, never a finding's statement or evidence; deliberate reading remains `get` and is not a declared use.
- Natural requests to remember or forget use `record_knowledge`; the old tools and active store are gone.

Search and automatic candidates require a title or alias word hit, or at least two distinct query words in the body; words match whole stemmed terms, never loose prefixes.
Conditions are kept and read but not indexed, and bare numbers are not search terms.
The query keeps up to sixteen distinct non-stopwords; below the matching bar the shortlist says nothing matched.

The lookup runs where a turn or a brief is assembled and nowhere else: no background job, model call or embedding.
It cannot make a model reason well; it offers knowledge when useful, without requiring a lookup before work.

## Keeping and clearing it

Closing a task keeps everything it recorded; knowledge is never pruned with the record.
In every build the Settings purge (`inf:retention:purge`) clears the collection after writers stop, and its row says so before the first click (`inf:retention:scope`).
Purging never touches a project's files.
The task export (`pnpm export:tasks`, `docs/task-retention.md`) carries no knowledge, and there is no knowledge export yet.

## Project documents

Durable explanations a project should carry belong in its own documents, through ordinary project changes.
An investigation stays on the task record.
Recording knowledge never edits a project file.

## The browser

The captain reads knowledge in the Knowledge browser, the approved design of FI3-1110 with its camera and connection revision (the design skill's `components/knowledge/KnowledgeBrowser.prompt.md` owns its look).
Browsing reads and never writes: rotating, selecting, filtering and opening evidence record nothing, declare no use, file no task and approve nothing.

### The panel and the command

The Knowledge panel is an ordinary app panel folder, `src/panels/knowledge/` (`docs/ui-plugins.md`, "The app's own panels are ordinary folders"), under Tasks at the bottom of the right rail, collapsed at first.
It waits on the `knowledge` gate (`AppPanelFolder.gate`, `src/shared/surfaces.ts`), which is open while this build keeps knowledge and has some to show: an entry in a collection the window reads, or an active direction, or a collection that cannot be read (`KnowledgeService.held`).
The window asks `inf:knowledge:enabled` once the captain's own panels have their places, and again after each `knowledge_changed`, each project that comes or goes, and registers the panel, its card and its command while the gate is open (`startGatedPanels`, `src/renderer/src/plugins/builtin/index.ts`).
A view of another Mac, which is refused the question, and a profile with nothing recorded have none of them, and the first entry the crew records brings them; a purge takes them away again.
It takes its place on that rail however many panels the rail already holds.
The core lists the panel among the first mate's surfaces on the same gate (`listSurfaces`).
The panel lists up to four active directions in their own words, captain instructions before advice and each group newest first, with project names as quiet tags.
Cut words appear whole in the app’s rest label for pointer and keyboard alike.
Under a hairline, conditional All N directions and Graph · N concepts links open the corresponding browser tab.
Collapsed, its header keeps the Knowledge title and says one total beside it as a short summary part (`rail.summarize`), never as a line in the title's place: its directions, or its concepts while there are no directions, since the title and two counts overflow the rail.
While the collection cannot be read it says so instead.
That total stays current while the panel is collapsed or the screen is off: a missed ping in that time does not stop the page, and a page the watchdog does stop no longer shows its last total as current.
A direction line opens its inspector; lines and links share one Tab stop with arrows, Home, End and Enter, and F6 lands there.
The header’s Open Knowledge opens the browser on Directions, as All N directions does, each time it is pressed (the captain: "when i click the expand button here, it should show the directions tab by default").
The command `panel:knowledge/open` (Open Knowledge, no default key) opens your graph with the keyboard on the shown tab.

### The reads

The browser reads seven catalog entries, and the app's other surfaces two more (`src/shared/reads.ts`), each over a `home` channel of its own (`inf:knowledge:*`, `src/shared/channels/knowledge.ts`; shapes in `src/shared/knowledge.ts`), answered by `KnowledgeService` (`KnowledgeWindow` for entries, `StandingDirections` for directions) with personal entries in the captain's collection and directions in their own scope:

| Read | Answers |
| --- | --- |
| `knowledge.collections` | each collection, private first then each project by name, with its active concepts, findings, directions counted |
| `knowledge.graph` | one collection's concepts and the connections among them: its most connected, the neighborhood of `focus` one or two hops out, or what `query` finds; at most 75 concepts and 200 connections, with `total` beside `shown` |
| `knowledge.concepts` | twenty concepts a page, by name or as `query` ranks them, each with its findings counted |
| `knowledge.findings` | twenty findings a page, newest first or as `query` ranks them, each with its standing, filtered to `recheck` or `differing` |
| `knowledge.entry` | one entry whole, at its current revision or an earlier one: connections and findings for a concept, kept sources with what they read like now, checks, revisions, disagreements and declared uses |
| `knowledge.directions` | twenty current standing directions a page for one exact scope, or `all` for "Everywhere, first mate only" plus registered projects, instructions before advice and each group newest first, with origin labels |
| `knowledge.direction` | one direction with current metadata and twenty Knowledge edits a page, including retired directions by identifier |
| `knowledge.refs` | the entries among up to 32 ids a card body writes, in the order asked, each with its collection, current revision and standing; an id no collection the window reads holds is left out |
| `knowledge.uses` | what one task's work declared it used, newest first, each entry and revision once: the revision it used as that revision said it, beside the current one, at most twenty with the total |

A finding's standing is one word (`standingOf`, `src/core/knowledge/browse.ts`): retired, superseded, differing evidence (a check with evidence or another finding contradicts it, or a check without evidence challenges it), needs rechecking (a source its current revision cites changed or is gone since it was kept), checked, or not yet checked.
Each read checks each cited source once.
A collection the build cannot read answers `unavailable` with the app's words, never an empty collection; a scope the window cannot read is refused as one that does not exist.
The reads re-run on `knowledge_changed`, the event every committed write and the purge send, and when a project comes or goes.
They are panel reads like any other, so a panel of the captain's own may declare them in any build (`docs/personal-panels.md`).

### The graph

The graph draws concepts only, at places a force layout in three dimensions computes once from the collection's ids and connections (`layoutGraph`, `src/panels/knowledge/graph.ts`) and keeps while the captain explores: nothing moves by itself.
A claim is a solid arrow from its finding's subject to its object, labeled with the finding's own predicate; a read-together link is a dashed line with no direction, its reason in the inspector; disagreements stay in History.
Labels are placed where they cover no other label or dot, with a leader back to their dot; predicates show only for the selected connection or the selected concept's own claims.

The camera orbits the fixed center (the captain: "follow how popular video games do it - like WoW camera control"): a drag to the right turns it right, so the far side sweeps left, with either mouse button, and a press that moves 5 px or more never selects.
Orbit left and right, and Shift with the arrows, turn it the same way; + and − zoom from 60% to 145%; Home and Reset view return to the neutral camera.
The wheel zooms only while the drawing has the keyboard's focus and never with ⌘ or Ctrl; the context menu is suppressed only over the drawing.
The arrows walk the concepts by name and select each, Enter opens it in the inspector, and the Connections list under the drawing names every connection of the selected concept, one Tab stop that opens a connection in the inspector.

### The lists and the inspector

Concepts and Findings share the collection, Find, the selection and the inspector with the graph.
The inspector reads the selected entry (a claim through its finding, a read-together link through the concept that declares it) in four sections: Overview, Evidence, History and Used in.
It reads an earlier revision too: History's Read revision N opens one, and so does a task record's Knowledge used row (below), and Overview then leads with how it compares to the current revision - what it says, where it holds or its explanation, its kept sources, and the current standing - beside Show the current revision.
The selection keeps the revision it reads (`Selection.revision`, `src/panels/knowledge/place.ts`), so paging away and back finds the same one.
Enter on a selection puts the keyboard on the inspector's section; Escape there goes back to the pane, then clears Find, then hides the card.
Every task key the inspector writes outside its rows - a report a source came from, the crewmate who observed, checked or revised an entry, a Used in row, a finding's and a check's own words - is a link to that task (FI3-1271; the design skill's core rule "Task keys"): the browser reads `tasks.board` and `tasks.search` for which keys name tasks, and a rest or a click points at the task as a Tasks row does.
While the card is narrower than 720 px - beside the docks, or drawn narrower - the inspector takes the pane's place with Back.
The browser keeps its place on its card while it pages (`card.keep`); Hide lets it go.

### Standing directions

Directions leads the Directions, Graph, Concepts and Findings tabs, not a factual claim in the graph or a search candidate.
There is one captain-owned graph, with no Collection picker or Older notes.
Directions lists all registered projects and the captain scope, named "Everywhere, first mate only" because no crewmate reads it, with a Project filter; removed projects are excluded by identifier, so a same-name replacement cannot inherit their directions.
Find and keyboard navigation remain; the Project filter never changes the graph.
The inspector shows wording, applicability, origin and lifecycle, plus paged edit history.
Ask about this drafts a question naming `d:<id>` for the Knowledge tool.
The first mate's `app_change` `direction` adds one with `text` and `scope`, or revises or retires one by `d:` identifier, with an optional `expectedRevision`; its evidence is the reason the history keeps.
Retiring removes active influence while retaining edits made in Knowledge; it is not secure erasure.

### Carrying the active directions

`StandingDirections.carry` runs before any agent starts.
It carries only active preference rows into `directions` and `direction_history`, preserving identifiers, wording, origin, scope and dates.
The carried current wording is Knowledge revision one; old revisions, retired notes and facts/lessons are not archived or promoted.
There is no inactive copy, preparation receipt, authority switch marker, legacy tool source or older-notes browser.
The destination transaction keeps the active set before startup removes the old notes tables.
A quit between those databases retries only unchanged current rows; a conflict stops startup rather than silently losing a direction.
Once the source tables are gone, no notes reader or writer remains, and purge cannot restore a direction from them.
Main database schema 81 prevents an older notes-writing build from opening this profile.

### References in an answer

An answer shows only the findings it relies on, as compact references that open the same inspector (FI3-1110's design, built by FI3-1150).
Which ones is the author's call: the first mate or a crewmate writes a finding's id - or a concept's - in its card, beside the claim it backs, as the `knowledge` tool says; the host infers nothing from the answer's words.
The window finds the ids a body writes (`knowledgeIdsIn`, `src/shared/knowledge.ts`), reads which name an entry it reads (`knowledge.refs`, `useKnowledgeLinks`, `src/renderer/src/cards/knowledgeLinks.ts`), and the card bridge links each where text writes it, as it links task keys (`entries` and `entry` messages, `docs/ui-plugins.md`): the id in mono, led by its standing's dot, named in words for a screen reader (the design skill's ResponseCard, "Knowledge references in a body").
A click or Enter puts the browser up at the front with its inspector on that entry, from the captain's own gesture only (`openKnowledgeEntry`, `src/renderer/src/plugins/point/openKnowledge.ts`); Hide returns to the answer.
Opening one records no use, checks nothing and runs no card effect: it is navigation, on a past card too.

The window links only while it has the Knowledge browser - the Knowledge panel is registered, so the build keeps knowledge and has some to show (`useKnowledgeHere`) - so a view of another Mac and a profile with nothing recorded ask nothing, link nothing and show every answer as its author wrote it.

### Knowledge used on a task

A task record lists what its work declared it used (`record_knowledge` `use`, which only a crewmate's use ties to its task) as a Knowledge used row between Cards and Activity (the design skill's TaskRecord, "The Knowledge used row").
Each line names the entry as the revision it used said it, with that revision beside the current one, and opens that exact revision in the inspector with the comparison above.
Opening it rewrites nothing: the use, the record and the entry stay as they were, and the revision the work used stays the one the row names.
The record reads `knowledge.uses` only where the window has the Knowledge browser: the record template is stamped with it (`recordTemplate`, `src/renderer/src/plugins/builtin/index.ts`), and the record's frame asks the host to open a line (`open-knowledge`) as it asks for a card.

### Ask about this

Ask about this, under every section of the inspector, starts the captain's next message with one editable question about exactly what is shown - its words quoted short, and its id and revision (`askWords`, `src/panels/knowledge/words.ts`), so the first mate reads that record with `knowledge` `get` - and puts the keyboard in the message field with the caret after it, keeping what the captain had typed after it.
It goes through the panel API's one generic way to start a message, `point.draft` (`docs/ui-plugins.md`), which counts only from the captain's own click or key and refuses while the message field is held.
Nothing is sent, filed, recorded or approved until the captain sends it, and then the first mate handles it as any message.

## Not built yet

Proactive correction notices, cross-project reads, binary evidence, automatic extraction, embeddings and a knowledge export are outside this design.

## Tests

- `src/core/knowledge/knowledgeService.test.ts`: reuse in other words through a link, scope isolation, idempotent and stale writes, checks and disputes, relations, retirement, declared use, unreadable data, purge and the shortlist; a direction's add, revise and retire through `StandingDirections.change`, its kept reasons and a stale revision refused, and `record_knowledge` refusing one.
- `src/core/core.settings.test.ts` ("shares catalog changes"): the `direction` line on a turn a crewmate's report began, with one feed line, its reason in the history, and `app_state` listing it.
- `src/core/knowledge/knowledgeTools.test.ts` and `knowledgeContext.test.ts`: what the tools and the context say.
- `src/core/knowledge/knowledgeSources.integration.test.ts`: evidence from a real git working copy.
- `src/core/knowledge/knowledgeRefusals.test.ts`: each write the owner refuses answers in its own words, commits nothing and leaves the collection byte for byte as it was, including a write another write moved past while it was prepared and a read of a scope the reader does not read.
- `src/core/knowledge/knowledgeReads.test.ts`: a claim's concepts named as its subject and object, the finding that contradicts it, its relations in the captain's window, a revision or source the reader cannot read refused as absent, and a file an older build kept checked against the reader's working copy.
- `src/core/knowledge/knowledgeRetireMany.test.ts`: `retire_many` retires only what the captain's resolved card names, keeps the exceptions, lists what it left alone, keeps each entry's history and says the list in one feed line.
- `src/core/knowledge/directions.test.ts`: the older record's active directions carried once, a retry after a quit and a conflicting destination, and the browser's pages and one direction read only where its project remains and the reader may see it.
- `tests/e2e/knowledge.spec.ts`: a crewmate's knowledge outlives its discarded task and a restart, and the next crewmate finds it in other words through its brief; a stated fact goes to knowledge, not notes.
- `tests/e2e/knowledge-gate.spec.ts`: stable and alpha share tools, browsing and linked references; unreadable directions pause new work without replacing the collection.
- `src/core/knowledge/knowledgeBrowse.test.ts`, `browse.test.ts` and `src/core/core.boot.test.ts`: counts, bounded graph, pages, standings, filters, entry reads and unavailability in every build.

- `src/panels/knowledge/graph.test.ts` and `place.test.ts`: the camera's signs and real projected places, the layout, label collisions, and the place the browser keeps.
- `src/core/knowledge/knowledgeBrowse.test.ts` also covers `knowledge.refs` and `knowledge.uses`: the order asked, standings, a removed project's entries left out, a task's uses each revision once beside the current one, and that reading records nothing; `src/shared/knowledge.test.ts` the ids a body writes; `src/panels/knowledge/place.test.ts` a revision kept and asked for, and Ask about this's words; `src/renderer/src/plugins/builtin/record/record.frame.test.ts` the Knowledge used row; `src/renderer/src/plugins/panelPoint.test.ts` `point.draft`.
- `tests/e2e/knowledge-references.spec.ts` (application lane): an answer links only the findings it names, each marked as it stands, and a click opens the inspector on that finding; a task record's Knowledge used row opens the revision its work used, compared with the current one, and History goes between them; Ask about this starts a message naming the entry and revision, by keys, and nothing is sent, written or filed.
  `tests/e2e/knowledge-gate.spec.ts` checks the same linked answer in stable and alpha.
- `tests/e2e/knowledge-browser.spec.ts` (application lane): Open Knowledge by name and from the panel, the graph, its camera and a claim's evidence by keys, the pointer's orbit with either button, the wheel, the lists, Find and the filters, the inspector's sections, the kept place, the narrow card's Back, and Esc in its order, with no knowledge written and no task filed; its seed records through the real owner with pinned ids, so the graph lays out the same on every run (`tests/e2e/knowledgeSeed.ts`).
- `tests/e2e/knowledge-directions.spec.ts`: directions stay distinct from personal facts in browsing and the first mate's served context; forty rendered directions arrive on an unrelated ask.
  A direction the captain chose on a crewmate's card is saved by the first mate on that crewmate's report, as the captain's instruction, through `app_change` with one Activity line, and the captain never types it.
  Eight active directions, five for one project, survive carryover and a stable restart; forget and purge remove influence without a notes fallback.
  This is scripted transport/use evidence, not a claim about live-model obedience.
