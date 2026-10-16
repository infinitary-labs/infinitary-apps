# Standing principles (captain)

The captain's standing product principles and build principles, in full.
`AGENTS.md` carries each as a short line that points here; the wording below is the record.

## Standing product principle (captain, 2026-08-17)

Infinitary is the most advanced agent harness, but it aggressively hides that complexity from the end user.
The user interacts with just the main first mate agent and a few settings - nothing else.
The fewer concepts we expose, the better.
Accounts, harnesses, crewmate transports, quota routing, and rebinding are machinery; the surfaces a person touches stay calm.
Concretely: the sign-in flow and the Subscriptions tab never expose the "harness" technicality - they speak only of providers, accounts (labeled by the user), and quota.
An e2e assertion enforces the wording.

## Standing product principle (captain, 2026-09-19)

Settings → Projects may expose delivery, autonomy, and standing rigor.
The captain picked the accordion treatment (with a row chevron) from the prototype, then confirmed on the resume of PR 210.
Setup and removal are shared by Settings and `app_change` (`project-setup`, `project-remove`); the first mate removes a project only on the captain's own words, and Remove asks once in place.
The personal workspace's row is locked entirely - it is a workspace kind, not a posture, and reads "builds in place".
Settings writes the same `repos` row `app_change project-settings` writes (`inf:repos:configure`), files an operation the same way talking does, and a refused configure is a feed line, not a silent revert.

## Standing product principle (captain, 2026-09-24)

Supported subscriptions are only those that run through Pi; Claude is the sole exception.

## Principles (captain, 2026-09-23)

Two standing rules for how a feature is put together.
What the person sees is the standing product principles above.

**Reuse the primitives you already have.**
Establish the core primitives, and build a new feature by arranging them.
A different feature is not a reason for a shortcut or a second setup that does the same job.
The special knowledge of the feature belongs in instructions or in data an existing reader already consumes, so a person can rewrite those words and get a slight variation.
When a primitive is genuinely missing, add one generic enough that later features can use it without knowing this feature's name.
A guided way of working is the case words alone leave easy to overbuild.
It is a parent task with child tasks on the task graph the app already has.
It is not its own runner, stamp, or card effect.
The host never learns the feature's name.

**Put ambiguous judgments in agent instructions.**
When a decision is ambiguous and needs judgment, teach it in the instructions the agent already follows.
Deterministic logic is for closed, typed facts: a status, a link, a stamp the emitter wrote, a table that maps one typed value to another.
It is the wrong tool for what a person meant.
Do not build a static parser that tries to understand natural language.
Ordinary structured and format parsing is unaffected.
The host carries what the agent declared.
It does not infer the judgment by parsing the words or by guessing from structure.
Whether an answer task is an internal step of work the first mate is running, or something the captain asked to see, is that judgment: the instructions teach it, the first mate declares it when it creates the task, and the existing settle tool honours the declaration.

## Standing product principle (captain, 2026-10-04)

Every feature works from the keyboard.
A new control is reached with Tab, or the arrows inside a list, and draws the focus ring.
An action a person repeats becomes a command in `KEYBOARD_COMMANDS`, so command search lists it.
It gets a default key only where none clashes, and its control shows the key hint.
An end-to-end journey drives it by keys.
How a feature does each of those is `docs/keyboard.md` ("A new feature").
