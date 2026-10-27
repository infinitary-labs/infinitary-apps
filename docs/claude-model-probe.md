# The live Claude model-catalog probe

`CLAUDE_MODELS` (`src/core/claude/claudeModels.ts`) is the hand-maintained list Infinitary routes Claude crewmate work to; the probe fails when it drifts from a current installed client's catalog.

Pi providers get a live per-account catalog.
This is the same gate for Claude, against **Claude's own current client, for the subscription connected on this machine**.

- The check: `src/core/claude/claudeModelProbe.test.ts`
- The comparison it runs, hermetically: `src/core/claude/claudeModelCatalog.test.ts`
- The code both share: `src/core/claude/claudeModelCatalog.ts`

## What it does

It opens a Claude Agent SDK session, asks it for `supportedModels()`, and closes it.
That is the client's account-aware picker catalog, not a second hand-maintained list and not vendor docs.
It is not exhaustive runnable-id proof on older clients: Claude Code 2.1.290 can run the explicit `claude-haiku-5-5` id while its successful list still resolves `haiku` to 4.5.

The read costs nothing.
The session's input stream never yields a message, so no turn is ever started and no tokens are spent; the session is closed on every path, including the timeout.
Nobody is signed in, no browser is opened, and nothing but model ids is read or printed.

It runs under the same boundary a crewmate run does (`claudeEnvFor`, see `docs/claude-client.md`): the installed executable or the `INFINITARY_CLAUDE_CLI` override, the machine's default login with `CLAUDE_CONFIG_DIR` **unset**, no ambient `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL`, and `settingSources: []`.

## How the two catalogs are compared

The client's rows are aliases as much as models, so they are normalized to the runnable id Infinitary would name.
These rows illustrate the current Sonnet family and earlier Opus/Fable catalog reads, not one historical snapshot:

| Client row (`value` → `resolvedModel`) | Canonical id |
| --- | --- |
| `default` → `claude-opus-5-5[1m]` | `claude-opus-5-5` |
| `opus[1m]` → `claude-opus-5-5[1m]` | `claude-opus-5-5` (deduplicated) |
| `claude-fable-5-1[1m]` → `claude-fable-5-1` | `claude-fable-5-1` |
| `sonnet` → `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `haiku` → `claude-haiku-5-5` (2.1.293 onward) | `claude-haiku-5-5` |
| `haiku` → `claude-haiku-4-5-20251001` (older client) | `claude-haiku-4-5` |
| `claude-opus-4-8` → `claude-opus-4-8` | `claude-opus-4-8` |

- `resolvedModel` is the authority where the client gives one; a row without it is taken at its `value`, which is the id the client accepts for it anyway.
- A `[1m]` suffix selects a **context window**, not a different model.
- A dated snapshot is today's build of a family.
  `CLAUDE_MODELS` names families on purpose, because the client resolves them to the current build - a check that demanded the date would fail on every point release, which is a broken guard rather than a caught drift.
- Several rows collapse onto one model, so aliases are deduplicated.

Then it holds `CLAUDE_MODELS` and the starter map to the shared catalog-check contract (`src/core/models/catalogChecks.ts`, `docs/model-lists.md`).
It fails on what would break or quietly stale a default, never on a mere catalog addition:

- **a family's newest generation missing** from `CLAUDE_MODELS` - invisible capacity, the FI3-74 shape;
- **a dead id**, a starter or a `CLAUDE_MODELS` row the subscription no longer serves - that route fails at spawn, in front of a task;
- **a default a generation behind** its family, unless `HELD_BACK` says why.

Earlier generations the client re-lists are the digest: printed, never a failure.
The app lists only each family's newest generation, and older ones stay reachable by name once the runtime read has them.
Each failure names the ids and the table to edit.

## Running it

It runs in the ordinary suite - `pnpm test` - and deliberately:

```
pnpm exec vitest run src/core/claude/claudeModelProbe.test.ts
```

It never reports a pass it did not earn:

- **No client installed** (a CI runner, or a Mac without Claude Code - the app ships no copy since F14): the suite is skipped at collection.
- **Nobody signed in**: the probe reads `auth status --json` first and skips with "no Claude subscription is connected on this machine".
  There is no catalog to compare against, so a pass would be a lie.
- **Known-incomplete older metadata**: a client older than 2.1.293 whose list omits Haiku 5.5 is skipped with a request to use a current client for catalog validation, never reported as a passing entitlement check.
  An empty answer still fails.
  A current client's omissions still fail the normal dead-default guard; the version exception cannot mask them.
- **An unreadable catalog** - a client that answers nothing, or does not answer within 90s: the probe **fails**.
  An empty list must never read as "this subscription serves nothing".

## What this is not

It is a guard over what ships.
The app also reads this same catalog at runtime (`docs/model-lists.md`): in the background, under the store lease, deferring to a live session, and falling back to `CLAUDE_MODELS` silently whenever the read fails.
The probe keeps that fallback correct.

## Haiku compatibility

`claudeCatalogIsOutdated` is shared by the runtime reader and this probe.
It recognizes only the known pre-2.1.293 omission of Haiku 5.5; a client that already lists the id, or whose version is unknown, keeps the normal catalog contract.
The runtime treats that incomplete answer as an unavailable read and uses the existing shipped-catalog fallback, rather than adding a fabricated account row.
That temporarily limits by-name choices to the shipped models until a current catalog is available; saved placements are never erased.
The global SDK-derived client floor is unchanged: it is a session compatibility floor, not a guarantee of current catalog metadata.
Haiku 5.5 accepts explicit medium and Quick-low coding effort on the SDK floor client and on 2.1.290/2.1.293; legacy Haiku still omits effort.
The bounded question keeps low effort and its 15-second deadline, leaving Claude's output allowance to the client so hidden thinking has room before the answer (INF-1451; `docs/kind-classifier.md`).
An explicit session cap still reaches these clients, which omit the thinking field for Haiku 5.5 when asked to disable it.
The hermetic session and classifier integration tests exercise the real client against a local reply server; they do not claim subscription entitlement or model quality.
