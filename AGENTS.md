# Project agent memory

This file holds what almost every session needs and cannot find by reading: the captain's principles, the rules no check will stop you from breaking, and where the ground truth for everything else lives.
How a feature behaves is in its code and its page under `docs/`; read those when the work reaches them.

## What this project is

Infinitary is an Electron desktop app with an iPhone and iPad companion: a first mate and a crew of AI agents that work on the person's own computer and model subscriptions.
The app needs no account of ours, and the person's work never passes through us readable (`docs/phone-push.md`, `docs/sharing.md`).
Product vision and interaction model: `.claude/skills/infinitary-design/readme.md`.

## Principles (captain; the record is `docs/principles.md`)

- **Hide the machinery.** A person meets the first mate and a few settings; the fewer concepts we expose, the better.
- **Subscriptions run through Pi**; Claude is the sole exception.
- **The iOS app adds no feature the desktop app lacks** unless the captain approves it first (`docs/ios.md`). VoiceOver and accessibility work there waits until the captain asks.
- **The center crew animation changes on the desktop and iOS apps in the same change.**
- **Every feature works from the keyboard** (`docs/keyboard.md`, "A new feature").
- **Reuse the primitives you already have**: read `primitives/README.md` before adding behavior.
- **Put ambiguous judgments in agent instructions.** Code is for closed, typed facts and never parses what a person meant.
- **Build the agent's reach, never its verdicts.** The host hard-codes only a typed fact it holds, consent for an effect, or a physical limit (`docs/delivery-rigor.md`).
- **A test runs on the Mac only when it needs a Mac.**
- **Integrations reach every surface the same way** (`docs/integrations.md`).
- **The captain decides and the fleet does the work** (`docs/required-actions.md`).

## Rules no check will stop you from breaking

- **Signing.** Never package with the release `electron-builder.yml`, and leave `pnpm dev`, `pnpm codesign:local` and `pnpm package:mac` to the person: they sign with this Mac's real material (`docs/local-code-signing.md`, "In a crewmate's working copy").
- **Sign-ins.** Never let a test or probe start a real Claude sign-in or boot into the real home folders; launch through `tests/e2e/launch.ts` (`docs/e2e-contracts.md`, `docs/claude-client.md`).
- **Tests.** Weakening, skipping or deleting a test waits for the captain's approval. Never run the full journey suite locally. Never call a test your change edited a flake.
- **Pictures.** Photograph each changed view before the first edit and again after it (`docs/testing.md`, "Capturing pictures of a change").
- **Architecture.** It is decided (`docs/architecture.md` §14): if reality contradicts a recorded decision, escalate with `needs-decision` instead of improvising.
- **Vision.** `STRATEGY.md` holds the captain's approved vision, which says what a change should align with or resist: never change that file without the captain's deliberate ask or approval.
- **Served text.** What the app serves to every user's first mate and crew, and what the host does on its own, speaks for every project, never for this repository's own setup (`docs/orchestrator-contract.md`, "What the served text may name").
- **Seams.** Every child process gets its environment from `hostEnv()`, every `ModelRuntime` comes from `src/core/pi/modelRuntime.ts` and every model session from a `SessionFactory`. Never spawn a path inside app.asar; never read `~/.pi`.
- **Saved sessions and failures.** Nothing prunes a session (`docs/task-retention.md`). A provider-failed turn stays a `turn_failed` event, and `src/shared/authFailure.ts` alone classifies sign-in failures (`docs/firstmate-runaway-hardening.md`).
- **Test rows.** Seed task rows through `seedTask`, never raw SQL (`docs/e2e-contracts.md`); a migration test that reverses a column a published view reads drops the views first (`docs/ui-plugins.md`).
- **One writer.** Each store has one writer; find it on its page before writing to its files (`primitives/`, `docs/architecture.md`).
- **Docs.** `docs/` holds how the project works now, in the present tense. A record of what happened (a run, a measurement, an incident, a status, an executed plan, evidence, a prototype) is never committed; it goes in the change's Verified section or the task's report, and git history keeps how a rule got there.

## Every change

1. UI follows the `infinitary-design` skill: consume its tokens, and extend the skill before inventing a rule.
2. Every word a person reads follows the vocabulary and goes in the catalog with all nine translations in the same change (`docs/i18n.md`, "Translating"). Text served to a model stays English.
3. A change a person notices adds a note under `release-notes/changes/`; internal work adds an exclusion with a reason (`docs/release-notes.md`).
4. Regenerate a generated file with its script; never hand-edit one (`*.generated.ts`, the phone's message files, `docs/contract.json`, `CHANGELOG.md`).
5. Run `pnpm check:changed` after the final file change and before every push; any later change makes that proof stale.
6. An edited test file needs three passing runs with no retries: unit files locally, journeys and phone parts through the requests in `docs/testing.md`, "What a task branch requests", made once at the final version.
7. This project merges in batches: a change is a task's pushed branch with no pull request of its own (`docs/testing.md`, "The swept batch").
8. Commit subjects are `type(scope): summary` (`CONTRIBUTING.md`). Final reports carry Intent, What changed, Verified, Risk, Not done (`docs/delivery-rigor.md`).

## Where the ground truth lives

`docs/README.md` lists every subsystem's page with a line on what it owns; `primitives/README.md` lists the reusable contracts.

| When the work touches | Read first |
| --- | --- |
| Tests, CI, what a branch requests | `docs/testing.md`, `docs/test-cohorts.md` |
| A journey or its stand-ins | `docs/e2e-contracts.md`; `docs/testing.md`, "A journey's own scenarios" |
| Delivery, rigor, holds, named limits | `docs/delivery-rigor.md`, `docs/agents-reach.md` |
| Layout, fences, sharp edges already paid for | `docs/architecture.md` |
| An IPC channel or a core shape | `docs/contract.md`, `src/shared/contract-changes/README.md` |
| What the first mate or a crewmate is told | `docs/orchestrator-contract.md`, `src/core/prompts/contract-revisions/README.md` |
| The prompt, the first mate agent, card lint, whose-turn sort, routing, `src/renderer/src/cards/` | `docs/replay-harness.md` (run the replay gate before pushing) |
| Accounts, sign-ins, quota, the Claude client | `docs/quota.md`, `docs/claude-client.md`, `docs/architecture.md` §16 |
| Where the project lives, pull requests, batches | `docs/forge.md` |
| A release, an alpha, signing, packaging | `docs/alpha.md`, `docs/local-code-signing.md`, `tests/release-contract.test.ts` |
| A failing main or a held batch | `docs/testing.md`, "A main repair's priority label" and "A held batch's repair" |
| The iPhone and iPad app | `docs/ios.md` |
| Saved data and where state lives | `docs/saved-data-compatibility.md` |
| The license and outside contributions | `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `docs/sharing.md` |

## Maintaining this file

A line belongs here only if it is a captain's principle, a pointer to ground truth, or a rule that costs something real before any check or page would stop the mistake.
How a feature behaves, what a check enforces and what CI runs belong in the code, its page and the failing check's message: change those and leave this file alone.
Say each thing once, in one sentence, and replace a line before adding one.
Past 1,200 words a `main` run starts a trim task; `pnpm check` refuses past 1,500 (`docs/testing.md`, "The size check on AGENTS.md").
