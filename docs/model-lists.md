# Lean model lists

What each provider's catalog becomes in the app: which models get a row, how the app learns what an account serves, what it says when that moves, and what the live checks fail on.
Captain-approved 2026-09-23 ("ok ship as designed"; the proposal and its measurements are in `fm-homes/mini-default/data/fm3000-lean-model-lists-s1/report.md`).

Naming every id would flood the Models board, the first mate picker and the feed.
Naming a hand-picked few misses new generations.

## The listing rule

`src/shared/modelListing.ts` holds the rule.
`ModelSlots` (`src/core/routing/modelSlots.ts`) applies it for every account.
For each provider, a row goes to:

1. **the newest served generation of each tracked family**, in one runnable variant;
2. **every starter row** (`STARTER_SLOTS`);
3. **everything the person kept**: placed in a slot, pinned, or chosen as the first mate model.
   A kept model stays listed whatever its generation.

Everything else a signed-in account serves stays in the pool, reachable by name only.
You can pin it, `override_model_id` can name it, and the "use a model by name" controls can place it (see below).
It is never a row, never announced, and never picked on its own.
The three raw-pool fallbacks read the listed set too, so an unslotted catalog's first id can no longer become the orchestrator:
- the slot ladder's last rung;
- the candidate walk's tail;
- the first mate model's derivation.

If nothing listed is available either, routing falls back to the whole pool rather than routing nothing.

Families are data, beside `STARTER_SLOTS` in `src/shared/modelSlots.ts`:

- **`TRACKED_FAMILIES`**
  - Claude, Codex and Grok track `"every"` family.
    They serve a handful of families, and a new one there is news.
  - OpenRouter's rows are its own `~vendor/family-latest` aliases for Infinitary's families.
  - A provider outside the table - the person's own `models.json` providers - lists everything.
- **"Newest"** is the version rule `newerId` routes by (the line is the id's prefix and suffix around the version).
  The probe digest shows every computed newest, so a misfire is visible.
- **`HELD_BACK`** lists starter rows deliberately left a generation behind, each with the reason.
  It is the only other way to answer the check below.

The board orders rows by provider, then family by newest generation, newest generation first, then tier.
So the listed rows are the head of each family group, a newcomer lands at the top of its family, and a generation the person kept sits right beneath the one that replaced it.

## Where "served" comes from

| Provider | The runtime read | Shipped fallback |
| --- | --- | --- |
| Claude | the installed client's `supportedModels()` (`readClaudeModelCatalog`), checked for known-incomplete older metadata, a one-shot under `claudeStoreLease` that **defers** while a crewmate session holds the store | `CLAUDE_MODELS` |
| Codex, Grok | Pi's catalog (bundled plus the pi.dev overlay), filtered by the account's **own list**: `chatgpt.com/backend-api/codex/models?client_version=…` and `api.x.ai/v1/models`, read with the account's auth the way quota reads it, through the same bounded transport with a wider 8 MiB reply limit (a meter's is 64 KB; a list describing every model may run past that) | Pi's catalog, unfiltered |
| OpenRouter | Pi's catalog | - |

Claude ships Haiku 5.5 (`claude-haiku-5-5`) as its low starter; Sonnet 5.5 remains medium, Opus 5.5 high and Fable 5.1 premium.
Reconciliation seeds only unseen models, preserving saved Sonnet or Haiku 4.5 placements and leaving an already-seen, turned-off Haiku 5.5 off.
A pre-2.1.293 client can run the explicit Haiku 5.5 id while omitting it from a successful picker catalog.
`claudeCatalogIsOutdated` treats that specific omission as an unavailable read, so the existing fallback keeps the new default routable; it never inserts an account-specific row.
Older by-name offerings wait for a current catalog, but their saved choices remain intact.
A current client's omissions remain authoritative, and the global session version floor stays unchanged (`claude-model-probe.md`).

The Pi account's own list is a **filter, never a source**: Pi cannot run an id it has no definition for.
It sits behind a **safety rail** (captain's decision A, 2026-09-23; `railVerdict` in `src/core/models/piAccountLists.ts`).
An answer that omits any starter or kept id Pi can serve is treated as unrecognised: no filter, and a silent fallback.
Neither endpoint can be verified from here without the credentials Infinitary never reads, and a filter that could remove a default would break the rule that a read never says a model is gone.
**The accepted cost:** in-app dead-default detection comes only from the Claude read; the CI check still covers Pi defaults.
`CODEX_MODELS_CLIENT_VERSION` is pinned beside the Pi SDK version - review the two together.
Pi 1.0.0 and 1.1.0 keep the Codex catalog unchanged from Pi 0.99.1, including GPT-6.1 Sol, so Codex client version 0.159.0 remains the paired list request; the account-list safety rail still applies if a particular account does not serve that starter.
Saved slot choices, including GPT-6 Sol, are preserved rather than silently reassigned on upgrade.
The session adapter discards `AgentSession.steer()`'s queue disposition after awaiting the call.

`ServedModels` (`src/core/models/servedModels.ts`) owns the reads.
`createAccountStore` (`src/core/models/accountStore.ts`) builds an account store with its readers, the rail and the filter, the same way on this Mac and on every computer that runs work (`docs/helper.md`, "Its own sign-ins").
The rail needs the models the captain kept, which only this Mac's record holds, so a computer that runs work reports a Codex or Grok account's own list beside Pi's catalog and this Mac narrows it by the same rail (`narrowServedThere`).
The captain's two rules:

- **Nothing waits on a read.**
  - A pass starts without being awaited - after the startup liveness sweep, daily, and when an account connects, signs in or is switched on - and each read is bounded.
  - No user path awaits one: not launch, the first-run gate, opening Settings, starting a crewmate, or routing.
    Until a read lands, the shipped catalog serves.
    When one lands, the quota catalog is rebuilt over the last snapshot with no fetch (`QuotaService.recatalog`), so the new ids can be named and routed, and the snapshot is pushed so Settings re-reads.
  - Child processes run at utility QoS.
  - A successful read leaves one trace, `[models] <provider> model list read: N models`, once per change in what was served.
  - Pi's own pi.dev refresh moved off the start path in the same change.
    The runtime is created offline (bundled catalog plus the stored overlay), and the refresh runs in the background (`src/core/pi/modelRuntime.ts`).
- **A failed read falls back to our catalog, silently.**
  A timeout, a missing client, a sign-in problem, an unrecognised shape, known-incomplete Claude metadata and an empty answer are all failures.
  The account's last read is forgotten and the shipped catalog serves again.
  Each failure is logged once (`[models]` in the core log) until its reason changes, and retried on the next pass.
  A deferred read keeps what is in hand.
  PI_OFFLINE (e2e) skips the Pi filters entirely.

## Crew speed

Each Codex model’s panel in Models saves Standard, Fast or Ultrafast across the accounts that support it.
Standard is the default; Ultrafast consumes 8× included allowance or 6× purchased credits, and Fast consumes 2.5× allowance or 2× credits.
`ModelSlots` keeps the offering’s choice beside its levels and reasoning, independently of either.
`spawn_crewmate.shape.override_speed` or `update_task.crew_speed` overrides only that task; a null update restores the model default.
The override may change on unfinished work and applies to subsequent requests without interrupting an in-flight request.

`ServedModels.speeds` reads the account’s advertised `service_tiers` independently of the model-list safety rail.
Missing metadata, a failed read or metadata at least 24 hours old grants no faster speed.
The board offers the union of fresh supporting accounts, retaining an unavailable saved choice; execution checks only the actual account and model on the computer running the work.
A request that cannot use the saved speed uses Standard on that same account and model and explains why in the feed and the task’s Activity.
Requested, sent and provider-confirmed speeds are separate facts; an absent provider confirmation is not success evidence.

Only the crewmate preset carries a speed policy, including its compaction and branch summaries.
The Pi adapter composes the existing payload hook on a per-session runtime facade, because Pi’s simple Codex stream drops a bare `serviceTier` option.
The first mate and Decisions explicitly request Standard, and sharing an account runtime never shares the crew policy.
A structured tier refusal before any output may retry once at Standard; a network failure, unknown error or response with output never automatically replays work.
Accelerated responses retain token counts but omit Pi’s ordinary listed-price estimates, which do not price subscription acceleration.
Provider-reported allowance meters are unchanged.

## The news

- **An arrival:** one feed line when a listed model appears that this install never saw - a tracked family's new generation, or a starter row.
  Re-listed older generations and untracked ids are marked seen silently.
  A client-served account announces only from a successful read (`canAnnounce`); its shipped list is never news.
- **A departure:** one feed line when a model that was listed, or is kept, is gone from an account's **successful** read compared with its **previous successful** read (`ModelSlots.departures`).
  The baseline per account is the `served-baselines` settings row.
  - The first read only records a baseline.
  - An empty answer is never a read.
  - A kept model keeps its slots, so it resumes if it returns.

## The checks

`src/core/models/catalogChecks.ts` is the one contract, shared by every live probe.

**It fails on:**
- a starter id no longer served (a dead default);
- a shipped-list id no longer served;
- a starter a generation behind its family, unless `HELD_BACK` says why;
- a tracked id no longer served at all;
- for `CLAUDE_MODELS`, a family whose newest generation the list does not name (FI3-74).

**It prints, and never fails on:** a digest of each family's row and how much is by name only.

| Check | Where it runs |
| --- | --- |
| `claudeModelProbe.test.ts` | where Claude Code is installed and signed in: the mac lane of `verify.yml`, developer Macs |
| `piCatalogCheck.test.ts` - the **hermetic** Pi check over the pinned catalog through the real runtime factory | every PR (`ci.yml`'s `unit-tests`) |
| `piCatalogProbe.test.ts` - the live pi.dev overlay | macOS only (the verify job and developer Macs), skipped when pi.dev does not answer |

Answering a failure is a one-line data edit:
- move the starter row to the newer generation (a captain call), or add a `HELD_BACK` entry with the reason;
- add or retire a `TRACKED_FAMILIES` entry;
- name the new generation in `CLAUDE_MODELS`.

## The live check (Codex and Grok)

Codex and Grok lists ship behind the rail, so a wrong answer can only fail to hide a model.
Verify them on a machine that has the accounts signed in, with Infinitary quit (vault metadata can change):

```
pnpm check:account-models
```

`scripts/check-account-models.ts` reads each enabled Codex and Grok account's own list once, through the same readers and the same rail the app uses:
- It prints statuses and model ids only, never a token or a header.
- It exits 0 only when every list was read and accepted.
- It touches exactly what a quota read touches: it may renew an expired token in that account's own store, and it keeps the pi.dev cache beside it.
  It opens no database, starts no task and runs no turn.

**Concurrent evaluation calls are different:** `tests/eval-auth-turn-taking.test.ts` proves Pi's installed resolver/file-store double-checked locking in two processes sharing a scratch auth file and an expired, single-use fake OAuth refresh, for both Codex and Grok provider ids.
Exactly one refresh occurs; both processes resolve the new auth and resolve again.
The developer [account evaluation runner](account-evaluation.md) therefore permits those runtime calls while Infinitary stays open, with an approved run sheet and only `list/get/runtimeFor` vault access plus before/after registry hashes.
This does not authorize account-management operations in two processes or prove the real providers' endpoints; keep quitting for the account-list command above, whose quota-resolution path has broader vault access.

**Do not use `pnpm dev` for this.**
A dev build opens `~/Library/Application Support/infinitary-dev`, never the release profile.
Pointing it at the release profile with `INFINITARY_USER_DATA_DIR` would run the whole app on real data: queued work would resume and rows would be written.

**Reading a running app's log instead:**
- A successful read logs `[models] <provider> model list read: N models`.
- A failed or refused one logs `[models] <provider> model list unavailable (<reason>)…; using the shipped catalog`.

Each logs once per change.

## The by-name controls

Specified in the design skill, `components/quota/ModelsBoard.prompt.md`:
- **Each level's "Add model" picker** opens on a search field.
  Typing lists the listed models first, then up to 12 unlisted matches under "More from your subscriptions".
  Choosing one places it in that level, which keeps it listed.
- **The first mate picker** offers "Another model by name…" for unlisted first-mate-capable models.
- **An empty Not in use lane** points to Add model while unlisted models exist, rather than saying every model is in a level.

`ModelSlotsView.byName` carries what these controls offer.

## Tests

- `modelListing.test.ts`: the rule against Claude's Sonnet 5.5 listing (including older generations) and each Pi provider's catalog shape.
- `servedModels.test.ts`: never blocking; failure, deferral and the rail.
- `catalogReaders.test.ts`: each reader's failures, and the rail.
- `modelSlots.test.ts`: listing, news, departures, the fallback rungs.
- `modelRuntime.test.ts`: the create never waits on pi.dev.
- `tests/e2e/model-lists.spec.ts`: a read that never answers, a successful read, a departure across a relaunch, a failed read - all end to end, over a Claude account whose stand-in client answers the SDK's model list.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Every `ModelRuntime` is created by `src/core/pi/modelRuntime.ts`, never `ModelRuntime.create` directly: it owns the live pi.dev catalog policy and its proven static fallback (`docs/architecture.md` §16.3).
  It creates the runtime OFFLINE (bundled catalog plus the store's last overlay) and runs the pi.dev refresh in the background, so start-up never waits on pi.dev (lean model lists, `docs/model-lists.md`).
  The trap it still guards: an aborted refresh cuts the availability pass riding the same signal, which would leave the model picker EMPTY - the factory rebuilds availability offline, and `modelRuntime.test.ts` fails if either the non-blocking create or that rebuild goes away.
  E2E is kept off `pi.dev` by `PI_OFFLINE=1` in `tests/e2e/launch.ts`.
  The factory also serves getModel through `withHonestReasoning`: a live def claiming `reasoning: true` whose thinkingLevelMap pins no effort token comes out non-reasoning, because Pi's openai-responses driver (no `supportsReasoningEffort` gate, unlike openai-completions) otherwise passes the session's thinking level through and the provider 400s every turn (grok-build-0.1, captain dogfood 2026-09-01).
- Two model lists, two rules.
  The routing pool (`availableModels()`) is sign-in gated, then narrowed by the user's slot record (`ModelSlots.routable()`).
  The quota catalog (`buildModelsCatalog`) is deliberately provider-wide so unmeasurable quota reads as unknown, not zero (`fetchQuota.test.ts`); never add the gate to it.
  Any "these are my models" surface reads the slot-first view (`ModelSlots.view()`), which is already sign-in gated because it is built from the accounts' own availability snapshots - and LEAN: the pool keeps everything served, but a row, a picker option, a newcomer line or a fallback pick goes only to the listed set (each tracked family's newest generation, starter rows, and whatever is slotted, pinned or the first mate model); the rest is reachable by name only (`ModelSlotsView.byName`).
  Claude accounts serve their runtime catalog read, never awaited, with `CLAUDE_MODELS` as the silent fallback; Codex and Grok filter Pi's catalog by the account's own list behind a safety rail.
  The live catalog checks fail only on a dead or stale default, a vanished tracked family, or Claude's list missing a family's newest generation - never on an addition.
  `docs/model-lists.md` is the one home; `pnpm check:account-models` (app quit, prints model ids only) is the live check for the Codex/Grok account lists on a machine that has them signed in.

## Custom API connections

App-owned Custom API models carry documented context/output limits and revision-bound synthetic proof.
Their IDs and limits are typed, or taken from the server's bounded `/models` list where it states them (FI3-412); listing fills only blank limits, cannot import capabilities/prices/endpoints or override typed or saved choices, and failed listing preserves them.
Connection runtimes do not refresh Pi public-catalog metadata.
Checked custom models are unselected until explicit first mate choice or crew slot/name use; unknown allowance/usage/price is not free.
See `custom-api.md`.

## Reasoning in each level

Each used provider/model offering has an optional reasoning choice per served intelligence level in the existing model-slot record.
The inline menu includes Use level default, which clears only that override.
Existing entries inherit premium/high Extra high and medium/low Medium, with the existing capability cap and Quick adjustment.
An explicit choice stays exact for Quick care, subject to the executing backend's cap.
Membership changes never copy reasoning to another level, and removing and re-adding a model restores that level's choice.
Provider/model keys follow the existing placements across projects and computers, never individual accounts.

Pi's `getSupportedThinkingLevels` and the Claude coding resolver own capability choices, and the Models view carries those choices rather than a second renderer catalog.
The app's selectable crew range is Low through Extra high; Minimal's catalog alias is not another menu choice, and Max and new None choices are not supported.
A fixed model shows None or Model's own, and unknown capabilities offer no menu.
A saved choice that loses support remains saved beside its effective value; unknown capabilities say choices are unavailable instead of inventing support.
Failed writes keep the saved view and show an inline explanation, and a keyboard save returns focus after the settings writer re-enables its controls.
The existing computer sign-in catalog carries optional backend capability metadata for models served elsewhere.
The home sends a chosen request through the existing placed-session spec, and the executing backend validates it against its own runtime.
Only new crew conversations read these choices; resumed and running conversations, the first mate, Decisions, routing, pins and account selection retain their existing behavior.
A reasoning effort the captain names for one task (`spawn_crewmate.shape.override_reasoning`, `update_task reasoning`) takes that task's place in this menu: its crewmate opens at it, under the same cap and exact for Quick care, and the saved choice stays as it was (`docs/task-record.md`, "Requested reasoning").
