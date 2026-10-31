# Core primitives

This folder names the reusable building blocks Infinitary is made of, so a new feature arranges them instead of inventing a parallel system.

The captain's principle is "Reuse the primitives you already have" ([`docs/principles.md`](../docs/principles.md)).
Build a new feature by arranging existing primitives.
Its special knowledge belongs in instructions or in data an existing reader already consumes.
When a primitive is genuinely missing, add one generic enough that later features can use it without knowing this feature's name.

## What counts as a primitive

A primitive is a feature-independent contract with one owner and a clear composition boundary.
Several unrelated features use it, and its owner never learns their names.
A screen, a provider, a database table or a transport alone is not a primitive: it implements one.
Lessons, a mail integration, a guided way of working and a particular panel are features: they compose primitives.

## Before adding behavior

1. Find the primitives the feature needs in the catalog below and read their pages.
2. Use each primitive through its owner and entry points, never through a second store, runner or writer beside it.
3. Put the feature's own judgment in agent instructions or data, not in a host rule that knows the feature's name.
4. When no primitive fits, add the missing one generically, give it a page here, and name it in this catalog.

## The catalog

| Primitive | Use it to |
| --- | --- |
| [Tasks and their relationships](tasks.md) | Record work, ownership, dependencies and handoffs. |
| [Programs](programs.md) | Compose loops, parallel task work and typed answers through a script the host runs as a task. |
| [Decision questions](decision-questions.md) | Ask a model for a bounded, typed judgment instead of starting a worker. |
| [Cards and consent](cards-and-consent.md) | Show an answer, gather a decision, or request one exact effect. |
| [Standing directions](standing-directions.md) | Carry the captain's ongoing instructions into relevant work. |
| [Knowledge graph](knowledge-graph.md) | Keep requested references and captain-stated personal facts with evidence. |
| [Automation](automation.md) | Start agent work from a time or an integration event. |
| [Secrets](secrets.md) | Define credential custody and exact approved program/operation use; current foundation is disposable only. |
| [Integrations](integrations.md) | Reach external services through declared connections and actions. |
| [Task browsers](task-browsers.md) | Research, demonstrate and prepare website actions within one task. |
| [Intelligence buckets](intelligence-buckets.md) | Route work to an appropriate model offering. |
| [App actions](app-actions.md) | Change the app and its settings through one door for the captain's controls and agents. |
| [Live reads](live-reads.md) | Expose current app facts without a second source of truth. |
| [Panels](panels.md) | Compose persistent views of app or personal data. |
| [Projects and working copies](projects-and-working-copies.md) | Bind work to its files and its delivery rules. |
| [Changes](changes.md) | Keep one typed record of a change's versions, their facts and the consent given, read by its id. |

## Execution foundations

Four lower-level contracts carry every primitive above.
They have no page here; their manuals and the rules in [`AGENTS.md`](../AGENTS.md) own them.

- Model sessions: every agent role runs through one backend-neutral session contract ([`docs/architecture.md`](../docs/architecture.md) §2, [`docs/orchestrator-contract.md`](../docs/orchestrator-contract.md)).
- Accounts and allowance: model access and honest availability without exposing credentials ([`docs/quota.md`](../docs/quota.md), [`docs/architecture.md`](../docs/architecture.md) §16).
- Durable messages: steers and wakes reach agents across turns and restarts ([`docs/inbox.md`](../docs/inbox.md), [`docs/report-sort.md`](../docs/report-sort.md)).
- Work devices: work runs on another computer without a second fleet ([`docs/devices.md`](../docs/devices.md), [`docs/helper.md`](../docs/helper.md), [`docs/view.md`](../docs/view.md), [`docs/connection.md`](../docs/connection.md)).

## How these pages relate to the manuals

A page here owns its primitive's intended use, composition rules and invariants.
The manual under `docs/` it links keeps implementation detail, procedures and test instructions.
Code schemas and the prompts the app serves stay the specification of their own shapes; a page links them and never restates them as a second specification.
The judgment and authority principles stay in [`docs/principles.md`](../docs/principles.md), and a page links them rather than redefining them.

Every page has the same sections: intended use, when to use it and when not, owner and entry points, operations and lifecycle, authority, compositions, failure and recovery, uses, checks, and where the detail lives.
A page describes behavior that exists now; a possible future composition is marked "Possible:".
This folder is guidance for people and agents building Infinitary, not a runtime registry, and no prompt loads it automatically.
Its Markdown is one sentence per line, held by `tests/reflow-docs.test.ts`.
