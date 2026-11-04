# Standing principles (captain)

The captain's standing product principles and build principles, in full.
`AGENTS.md` carries each as a short line that points here; the wording below is the record.

## Standing product principle (captain, 2026-08-17)

Infinitary is the most advanced agent harness, but it aggressively hides that complexity from the end user.
The user interacts with just the main first mate agent and a few settings - nothing else.
The fewer concepts we expose, the better.
Accounts, harnesses, crewmate transports, quota routing, and rebinding are machinery; the surfaces a person touches stay calm.
Concretely: the sign-in flow and the Subscriptions tab never expose the "harness" technicality - they speak only of providers, accounts (labeled by the user, except Claude, which follows its current identity), and quota.
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
The primitives and their intended use are catalogued in [`primitives/README.md`](../primitives/README.md).

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

## Standing build principle (captain, 2026-10-19)

**Build the agent's reach, never its verdicts.**
The models behind the first mate and the crew improve with every release, outside our control.
Code we write to decide for them is written against today's model and stays there.
So the host hard-codes only what is closed: a typed fact it holds, consent for an effect, and a physical limit of the process it runs in.
Everything else is a verdict: what a person meant, what should happen next, how much is enough.
A verdict goes to the agent: give it the fact, the primitive and the evidence, say the goal in its instructions, and record what it declared.
A number, a category or an order the host made up is a verdict, not a fact.
Where such a limit stays, the agent reads it, a refusal names the fact it rests on, and a way out is typed beside it.
Code that compensates for what a model cannot yet do is a ceiling: prefer the fact and the primitive, and remove the compensation when no model needs it.
When a rule breaks on a case, the fix generalizes the primitive or the goal; it never adds the case.
Instructions follow the same rule: they say goals and boundaries once, not a list of cases, and they are measured by replay, never enforced by a word list.
This extends "Put ambiguous judgments in agent instructions" (2026-09-23) from what a person meant to every judgment about what should happen.

## The captain decides and the fleet does the work (captain, 2026-10-22)

INF-863, approved as one shared instruction in both prompts, with gender-neutral references as requested.
The captain decides and the fleet does the work.
Never ask the captain to do anything the fleet can do itself, with your own tools or a crewmate the first mate starts or steers, and check whether it is already done before you ask.
Only the captain can choose what they want, give the consent the app holds for their click, use their own sign-in, password, approval or signing material, or reach a device the fleet cannot.
Ask for exactly that, as one click where one exists; the fleet does everything before and after it.
A step whose cost the captain should weigh is a yes they give, never work they do.

The shared instruction lives in `src/core/prompts/fleetWork.ts`, served once after each persona core.
A required action holds only a part the captain alone can give; work the fleet can do after a merge becomes a `Continue: …` filing instead (`docs/required-actions.md`).
Consent gates, sign-in and signing boundaries remain unchanged.

## A test runs on the Mac only when it needs a Mac (captain, 2026-10-28)

INF-1763, asked as "is it actually ok to dedup all the mac journeys that are covered by linux journeys, and just rely on linux to test those flows?", with the instruction "make sure this becomes a durable principle for future tests so we don't gradually regress back".
It covers every test.
A test runs on the Mac only when it needs a Mac.
Linux runs every test it can.
The full-check Mac lane runs only the tests that need it, in the run on `main` too; every alpha runs every journey, or reuses the swept batch's (INF-2480, the captain: "old set at the release check only, from the first piece on"; INF-2508).
The captain's later INF-2273 ruling makes edited unit-file proof an explicit local exception: every changed unit file gets ordinary coverage plus two more locally, including portable files, without duplicate PR CI repeat jobs.
A journey that needs a Mac carries `MAC_ONLY_TAG` (`tests/e2e/tags.ts`): it skips on Linux, or it has a step only a Mac runs.
A unit test that needs a Mac is a file of the reviewed list in `scripts/mac-unit-tests.ts` (`docs/test-cohorts.md`).

Three checks hold the rule for journeys, so it does not wear away:

1. Every Linux journey job fails on a test that skipped there without the tag (`scripts/untagged-skips.ts`).
2. The `e2e-mac-tag` lint in `pnpm check` refuses an untagged test that reads a Mac fact (`THIS_DESKTOP`, `HAS_APP_MENU` or "darwin") and a tagged test that reads none (`tests/lint/e2eMacTag.ts`).
3. `tests/release-workflows.test.ts` holds the Mac steps of a request for journeys and a requested full check to the tag.

How each check runs is `docs/testing.md`, "Tests that need a Mac".
