# Standing directions

Standing directions carry the captain's ongoing instructions, about how the first mate runs the work, into every turn they apply to.

## Intended use

Use a standing direction for an instruction the captain wants applied every time from now on, such as who merges, when work starts or which models a project uses.
A direction is either global (the captain's scope, `captain`) or bound to one exact project identifier.
**Knowledge replaces notes in every build, stable included (2026-10-12)**: `KnowledgeService` owns standing directions separately from personal facts, and every turn receives the complete applicable directions, never an older-notes fallback (`../docs/knowledge.md`).
Directions are instructions to weigh with the work, not data to search: they never appear in the factual graph or among factual search candidates.

## When to use it, and when not

- Use it when the captain states, or chooses on a card, an ongoing rule for how the fleet works, globally or for one project.
- Do not use it for a development practice of a project (how its tests, style, structure or commits work): that is how the project works, so a crewmate writes it into the project's own `AGENTS.md`, or the `CLAUDE.md` it keeps instead (`../docs/knowledge.md`, "Collections and who reads them").
- Do not use it for a fact about the captain or a saved source: those are [knowledge-graph.md](knowledge-graph.md) entries.
- Do not use it for a one-off ask, a reminder or a recurring job: a task carries one-off work, and [automation.md](automation.md) carries work that starts at a time or on an event.
- Do not build a second instruction store (a settings file of preferences, a skill file of rules, a per-feature "remember this" table, a prompt fragment a feature appends to).
  A second store drifts from this one, is not delivered whole on every turn, and the captain cannot see or retire it in one place.
- The captain's panel instructions ("always use compact rows in my panels") are ordinary directions scoped to the personal workspace, so every crewmate building a panel or teaching a lesson there receives them on every turn.
  The personal workspace is registered as a project at startup so a direction can name it before any panel exists.

## Owner and entry points

- Owner: `KnowledgeService` in [`../src/core/knowledge/knowledgeService.ts`](../src/core/knowledge/knowledgeService.ts), the one writer over `userData/knowledge/` (see [knowledge-graph.md](knowledge-graph.md), "Owner and entry points", for the one-writer rule).
- Write: `KnowledgeService.changeDirection` (`add`, `revise`, `retire`, with an optional `expectedRevision` and a required reason).
- Read for a turn: `KnowledgeService.standingDirections(actor)`, the full active set visible to that actor, never shortened to a search or formatting budget.
- Render for a turn: `renderDirections` and `renderDirection` in [`../src/core/knowledge/directions.ts`](../src/core/knowledge/directions.ts).
- Delivery: the first mate's context (`../src/core/orchestrator/firstmateAgent.ts`) and every crewmate turn (`../src/core/orchestrator/crewSupervisor.ts`) call `renderDirections` over `standingDirections`.
- The agent's door: the app action catalog's `direction` line (`../src/shared/actions.ts`), whose change channel `inf:knowledge:direction:set` (`../src/shared/ipc.ts`) runs `changeDirection` through the dispatcher.
- Window reads: `knowledge.directions` and `knowledge.direction` (`../src/shared/reads.ts`, shapes in `../src/shared/knowledge.ts`).

## Operations and lifecycle

- Add creates a direction with `text` and `scope`; revise replaces its wording by `d:` identifier; retire removes its active influence.
- Every change is a new revision with the reason the first mate gave; the history stays readable, and retirement is not secure erasure.
- A write naming an older revision than the current one is refused, so a stale edit never overwrites a newer one.
- Delivery is whole on every turn:
  - every first mate context block carries all current directions, whatever the words searched and whether or not the turn is a background wake;
  - every crewmate turn (fresh, resumed, or placed on another computer) carries the complete current directions of its own project, superseding earlier copies;
  - a brief holds no copy of its own, so a brief served again carries no stale direction;
  - rendering never truncates directions.
- The first mate reviews directions against facts arriving on its turns, including reports and updates.
  Evidence that a condition has ended or a built-in rule fully covers the direction prompts a retirement offer naming the direction and evidence, with Retire and Keep; apparent age alone is not evidence.
  An unresolved offer stays on its existing card, and a kept direction is not offered again without new evidence.
- An unmet or unknown condition stays in the direction's text, not a task dispatched to wait for or check it.
  The first mate reconsiders it when relevant facts arrive; unknown is not expired, and a fulfilled condition applies only to authorized work, never authorizes new work itself.
  The agent judges the condition; the host parses no natural-language trigger and adds no polling schedule.
- Retired directions have no active influence from the next turn on.
- `KnowledgeService.carryDirections` carried the active notes-era preferences into Knowledge once, before any agent starts; no older-notes reader, writer or fallback remains.
- `carryPanelInstructions` (`../src/core/personal/panelInstructions.ts`) carries the panel instructions an older build kept in the personal workspace's `.claude/skills/captain/SKILL.md` once at startup, before any agent runs: each listed line becomes one direction word for word, any other words one more, and the file leaves in one workspace commit.
  Its ids come from the words, so a second start or a quit before the removal adds nothing; Knowledge that cannot be read leaves the file for a later start.

## Authority

- Authority is not permission: captain-origin directions are instructions, other origins are labeled advice, and neither grants permission to act beyond the task.
- The first mate alone adds, revises and retires directions, on its own judgment of what the captain wants, whatever began the turn (INF-638; `../docs/knowledge.md`, "Directions are the first mate's to keep").
  It does so through `app_change` with the `direction` line, whose `judgment` tier lets it act at any wake; each write is stamped `captain-turn`.
- `record_knowledge` refuses a direction and points at `app_change`.
- A crewmate never writes a direction; it reports the captain's words or choice with `needs_firstmate`.
- Project scope is exact: project directions follow the project identifier, never a matching name, and a removed project's directions do not pass to a same-name replacement.
- Global directions stay private to the first mate; a crewmate receives only its own project's directions.
  The captain scope's name says so ("Everywhere, first mate only", `CAPTAIN_SCOPE_NAME`), and so does the first mate's `direction` line, so an instruction meant for crewmates goes in a project's scope (INF-1217).

## Compositions

- Rides the app action catalog (`../docs/orchestrator-contract.md`, "App action catalog"), so each change leaves one operation and one feed line like any other setting change.
- Shares storage, purge and availability with [knowledge-graph.md](knowledge-graph.md) but keeps separate tables, so directions never become factual search candidates.
- Reaches a task on another computer through each served turn ([`../docs/helper.md`](../docs/helper.md)); nothing of the collection is kept there.
- A [decision-questions.md](decision-questions.md) answer or a [cards-and-consent.md](cards-and-consent.md) choice may become a direction only when the first mate judges it an ongoing instruction and writes it.

## Failure and recovery

- An unreadable or newer collection stays unchanged, and new agent work pauses because its standing directions cannot be read; no turn runs without them.
- A carry-over conflict stops startup rather than silently losing a direction.
- A refused change (unknown id, stale revision, duplicate add) throws as every catalog change does, and nothing is written.
- The Settings purge clears directions with the rest of Knowledge; nothing restores them from the retired notes tables.

## Uses

- The first mate's served context: the complete directions in `directions` on every turn, including background wakes.
- Crewmate turns: a crewmate working in a project receives that project's directions on every turn, including a task held on another computer.
- The Knowledge panel and the browser's Directions tab list active directions, captain instructions before advice, with project tags, and Ask about this drafts a question naming `d:<id>`.
- A direction the captain chooses on a crewmate's card is saved by the first mate on that crewmate's report, without the captain typing it (`../tests/e2e/knowledge-directions.spec.ts`).

## Checks

- [`../src/core/knowledge/knowledgeService.test.ts`](../src/core/knowledge/knowledgeService.test.ts): add, revise and retire through `changeDirection`, kept reasons, a stale revision refused, and `record_knowledge` refusing a direction.
- [`../src/core/core.test.ts`](../src/core/core.test.ts) ("shares catalog changes"): the `direction` line on a turn a crewmate's report began, with one feed line and its reason in the history.
- [`../src/core/orchestrator/firstmateAgent.test.ts`](../src/core/orchestrator/firstmateAgent.test.ts) ("renders authoritative directions and keeps them from a scheduled turn too"): whole delivery to the first mate, background wakes included.
- [`../src/core/orchestrator/crewSupervisor.test.ts`](../src/core/orchestrator/crewSupervisor.test.ts) ("serves active project directions with their authority once on the first turn", "serves the personal workspace's directions on every turn and drops a retired one"): project directions on a crewmate turn.
- [`../src/core/personal/panelInstructions.test.ts`](../src/core/personal/panelInstructions.test.ts): the panel instructions carry, its repeat and its unreadable-Knowledge case.
- [`../tests/e2e/personalize.spec.ts`](../tests/e2e/personalize.spec.ts) ("a panel instruction is a standing direction for the personal workspace"): the captain's words become a direction listed in the Knowledge browser.
- [`../tests/e2e/knowledge-directions.spec.ts`](../tests/e2e/knowledge-directions.spec.ts): directions stay distinct from personal facts, forty directions arrive on an unrelated ask, carry-over and restart, forget and purge without a notes fallback.
- [`../tests/e2e/knowledge-gate.spec.ts`](../tests/e2e/knowledge-gate.spec.ts): unreadable directions pause new work without replacing the collection.

## Where the detail lives

- [`../docs/knowledge.md`](../docs/knowledge.md): "Directions are the first mate's to keep", "Knowledge as needed", "Standing directions", "Carrying the active directions" and "Collections and who reads them".
- [`../docs/orchestrator-contract.md`](../docs/orchestrator-contract.md), "App action catalog": the `direction` line's tier and trail.
- [`../docs/principles.md`](../docs/principles.md): the captain's principles for building this project, kept as a project document rather than as directions.
