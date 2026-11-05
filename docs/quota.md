# Quota: the sensor and its math

How quota is read, renewed, reported and derived.
The account broker and credential health are `docs/architecture.md` §16.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Quota reliability (captain escalation 2026-09-04, investigation report `fm3000-quota-visibility-diag-s1`).
  The sensor's job is to be honest about what it established, and to recover from routine expiry without a sign-in.
  Four rules that must not regress:
  - **The vendor's verdict drives reactive recovery.**
    A 401 - and only a 401, never a 403, which is also how a WAF refuses - makes `fetchOneAccount` (`src/core/quota/fetchQuota.ts`) ask `AccountBackend.renew` (`vendor_rejected`), then retry once after an observed credential change.
    Claude sessions renew their own sign-in; health reads the modification-date-cached store without a client status poll or an advance renewal.
    Only after a rejection, with no live session and the store slot free, `ClaudeAuthBackend.renew` asks `auth status --json` once and rereads the store (`docs/claude-renew-probe.md`).
    It runs no fallback command and never speaks Anthropic OAuth.
    Pi accounts keep their existing proactive health policy and resolve-is-renewal: `getAuth` already refreshed.
  - **One session count and one store slot.**
    `src/core/claude/claudeStoreLease.ts` counts live clients and owns the slot shared by login, logout, catalog reads and the one idle status request.
    Claim and check happen in the same tick, so a background request cannot race a live session over its single-use refresh token.
    A session waits for an occupied slot before attaching; a background request defers immediately while a session or slot is active, without a renewal queue or thirty-second wait.
    User-initiated login and logout still serialize through the slot, with the seat detached by their existing owner.
    Infinitary owns its sessions, so this is a registry, never a process scan.
  - **Not knowing is its own state, and so is recovering.**
    `quotaProviderViewSchema` carries `ok | auth_required | rate_limited | unavailable | not_measured` plus a sanitized `reason` code and `measuredAt`.
    `renewal_succeeded` on an `ok` row is the ONE positive trace a renewal leaves - without it an `ok` after a failure is indistinguishable from plain network recovery, so a snapshot could only ever prove recovery had NOT worked; never record it on an ordinary reading that needed no renewal.
    Only `auth_required` may say "sign in again" or raise the needs_reauth card (CD-3=A: singleton card + Subscriptions CTA + one-step restore via `accounts.signIn`); it is reachable from a provider-refused refresh (`refresh_token_lapsed`: for a Pi account a credential read whose refresh the provider answered 401 or `invalid_grant`, `isLapsedRefresh` in `src/shared/authFailure.ts`, held by `AccountVault.refreshLapsed` until a read succeeds; and Copilot's refused GitHub sign-in, `providers/copilot.ts`) or a vendor rejection that SURVIVED a real renewal (`rejected_after_renewal`, `fetchQuota.ts`).
    Claude's saved refresh expiry is ignored: neither it nor access expiry establishes a sign-out, and the resolved credential still reaches Anthropic's allowance endpoint.
    A transient miss, a no-interactive-session block, and an unreadable store stay `unavailable` and retryable.
    `mergeStaleProviders` keeps last-known-good with its age through everything else, dropping windows whose own reset has passed.
    A no-window fallback is never a success and unknown is never zero.
  - **The credential-and-request layer has real coverage.**
    `tests/e2e/quota-live-sensor.spec.ts` is the one e2e that does NOT use the fixture seam: it runs the real `createQuotaFetcher` against a local stub of the vendor endpoint (`INFINITARY_CLAUDE_USAGE_URL`, `INFINITARY_GROK_USAGE_URL`, `INFINITARY_GROK_KEY_URL`, `INFINITARY_KIMI_USAGE_URL`, dev/e2e-gated exactly like `INFINITARY_QUOTA_FIXTURE_DIR`).
    Two provider defects reached the captain twice because that layer had none.
    Grok is METERED since the 2026-09-05 dogfood fix: `providers/grok.ts` reads the consumer credits meter (`grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`, an UNDOCUMENTED gRPC-web endpoint that can change without notice) with the account's own Pi OAuth token, mirroring the proven quota-axi read - not its browser headers: the meter answers with the bearer, the gRPC-web content type and marker alone, so Infinitary sends nothing that claims to be a browser or another client.
    `src/core/quota/grpcWeb.ts` is the schema-less reader (framing, trailers, a bounded protobuf field scanner); the field map in grok.ts is reverse-engineered and confirmed against a live capture (`providers/grok.test.ts` carries the bytes).
    A body the reader does not recognize is `schema_unrecognized`, never a window.
    A meter refusal (401/403, gRPC 16/7) is NOT a sign-in verdict on its own - whether a Pi-minted xAI token reaches the consumer meter was never established on the captain's account - so the sign-in is probed once (`/v1/models`): alive means the honest disclosed line with `meter_*` as the reason, and only the vendor's own 401 is `auth_required`.
    `INFINITARY_GROK_USAGE_URL` is the dev/e2e endpoint override, gated like `INFINITARY_CLAUDE_USAGE_URL`.
    An API key's allowance comes from its own read instead (`api.x.ai/v1/api-key`), whose dev/e2e override is `INFINITARY_GROK_KEY_URL`; `tests/e2e/launch.ts` points it at a local port nothing listens on, so no journey sends a seeded key to xAI.
    Kimi Code is METERED (INF-560): `providers/kimi.ts` reads `api.kimi.com/coding/v1/usages`, an UNDOCUMENTED endpoint whose shapes come from CodexBar's reader, with the bearer Pi derives from the device-code sign-in or the pasted Kimi Code key and nothing else.
    Its five-hour, weekly and monthly pools are the session, weekly and monthly windows, and the membership level names the plan.
    A shape it does not know is `schema_unrecognized`, an answer with no pool is `KIMI_NO_WINDOW_DETAIL`, and only the vendor's 401 is `auth_required`; `INFINITARY_KIMI_USAGE_URL` is its dev/e2e override.
  - **Copilot** is METERED: `providers/copilot.ts` reads GitHub's `copilot_internal/user` (on `api.github.com`, or `api.<domain>` for GitHub Enterprise), an UNDOCUMENTED endpoint VS Code's Copilot reads, with the bearer and an Accept header only.
    Pi's request auth for Copilot is a short-lived Copilot token that GitHub's API does not take, so the meter reads with the GitHub sign-in Pi minted it from, through Pi's own `readStoredCredential` (`src/core/pi/copilotMeter.ts`, from `AccountVault.resolveForQuota`); nothing renews it and nothing writes the store.
    `quota_snapshots.premium_interactions` is the account's bound, labeled "premium requests"; `quota_snapshots.chat` shows as `product:chat` only when the plan meters it and bounds only its own scope; an unlimited snapshot or a zero-entitlement placeholder is no window.
    The cycle runs from the same day a month before `quota_reset_date` to it, and the row names its plan "GitHub Copilot".
    A 401 there is the GitHub sign-in itself refused, so it is `auth_required` with `refresh_token_lapsed`, the proof that may say "sign in again", and `fetchQuota.ts` tries no renewal after that reason; a 403 stays `unavailable`.
    An answer with nothing metered is `not_measured` with `COPILOT_NO_WINDOW_DETAIL`; one without `quota_snapshots` is `schema_unrecognized`.
    No typed cut-off is read from Copilot's refusals yet: the meter's reset is the only hold.
    `INFINITARY_COPILOT_USAGE_URL` is its dev/e2e endpoint override, gated like the others.
- Quota parity (dogfood fix 2026-09-01): `src/shared/quotaSignals.ts` is the ONE home of derived quota math - pace/reserve/burnMultiple, runway projection, spendPriority, per-provider scope bounding - reimplemented clean-room to quota-axi's README semantics (never add quota-axi as a dependency or copy its source; `quotaSignals.test.ts` pins real published readings to 4 decimals).
  Signals are recomputed from a snapshot's cycle evidence (`resetsAtMs`/`windowSeconds` on windows) at read time, never persisted.
  Provider rules that must not regress: model/product windows bound only their own scope (never the account-wide min); a signed-in account with no readable window renders a disclosed detail line, never a silent blank (`GROK_NO_WINDOW_DETAIL` is the Grok case when the meter answers with nothing readable or refuses a live sign-in - it states what happened on that read, never that the credential cannot expose usage).
  Claude is SENSED: `src/core/claude/claudeQuota.ts` reads the machine's default login (`.credentials.json` in `~/.claude`, else the bare Keychain item `Claude Code-credentials` - presence-probe first).
  The item is found under whatever account the client keyed it on: the client names it after `USER`, but it runs on Bun, which names an unset `USER` `unknown` where the app would name the real user.
  So the presence probe asks for the `USER` name first, which is the item the client itself reads when both exist, and on a definite miss for the service alone; the value read, the unlock and the Apple tool then name the account that probe found (INF-1798).
  Only a host `absent` outcome (`errSecItemNotFound`, OSStatus -25300) is absence; a thrown presence-probe or an unparseable value is a named `keychain_*` read failure (`locked` / `unavailable` with `detail` and Retry), never an empty store and never `credential_unavailable` with the reason erased.
  `keychain_no_interactive_session` stays out of `keychainLocks` so every tick retries (a relaunch fixes it); a decline still holds until Retry, unless the store changed under it (another login's account config, or a rewritten Keychain item): then one fresh background read is made, never a prompt, and a decline there holds the new store until Retry.
  A `demand` refresh chains after an in-flight tick so Retry is not swallowed; a post-request resolve that cannot read the store is `unreadable`, not `unchanged`.
  The Keychain VALUE read rides `HostCapabilities.keychain`: guarded Apple-first inside a disposable utility process, the approved INF-2308/INF-2321 amendment to CD-5=B's in-process-first order.
  A sign-in asks macOS nothing itself (`ClaudeAuthBackend.login`, INF-2319); the allowance reading the Subscriptions tab asks for once it ends, a `demand` refresh, is the moment a permission prompt is expected.
  A LOCKED store is `keychain_locked`, never held: macOS fixes a process's unlock-dialog policy at its first touch of the store (the silent startup tick), so a tick skips the VALUE read and a user-initiated read first unlocks in a fresh `src/main/host/keychainProcessMain.ts` utility process, then reads in another fresh process (`docs/architecture.md` §16.6; the host sets the interaction flag before EVERY Security call).
  `providers/claude.ts` calls the vendor's OAuth usage endpoint; renewal is delegated to the client, never reimplemented.
  A computer that runs work reads its own Claude login the same way, but never lets macOS ask, holds no refusal and offers no Retry (`docs/helper.md`, "Claude's allowance, never asking").
  Pace vocabulary follows quota-axi: "ahead" = burning faster than the reset clock = the WARN state ("behind" is calm) - the pre-parity UI had this inverted; don't bring that back.

## Keeping the Claude reading current

- Health, allowance, identity and login ownership use `readClaudeStore`: one `present`, `absent` or `unreadable` result carrying the access token, advisory expiry and current identity from Claude Code's config.
  File credentials and the account config are cached by modification date; a Keychain value is cached only when the item reports its modification date, and is invalidated by a changed item or config.
  Access expiry alone does not discard a cached value, and concurrent equivalent reads share their work.
  Retry and the read around the idle status request bypass the value cache; an explicit permission request never joins a silent read.
  An unreadable result stays stale or degraded, never signed out, and never replaces the last known account label.
- A read through Apple's tool that fails or runs out of time is `keychain_read_incomplete`: retryable on the next refresh, never held until Retry, and its words never mention Always Allow.
  Every silent operation keeps the existing five-second read allowance, including its metadata, access-rule and value work in the child.
  An explicit interactive operation keeps the existing two-minute dialog allowance; a stalled or failed child never blocks the main thread and is never a false absence.
- Claude's usage service is asked at most once per account every five minutes (`CLAUDE_ASK_INTERVAL_MS`), and ten minutes after a 429 whatever its retry-after says.
  Refreshes between asks resolve the store first and serve the last answer only for the same login; a person's Retry always asks.

## Typed cut-offs

Before a Claude value read, the child checks that the store is unlocked and reads that one item's access rules (`SecKeychainItemCopyAccess`, `src/main/host/darwinKeychain.ts`).
It does not list the other saved passwords, and it does not check each trusted app's signature.
It tries `/usr/bin/security` before a direct value read only when that item trusts the tool for decrypt without a password and its partition is `apple-tool:` or absent.
The partition description from `SecACLCopyContents` is a hex-encoded XML plist; the host decodes that known shape and accepts exactly one `apple-tool:` entry, refusing malformed data and any additional team.
Unknown layouts, other items, locked stores and missing grants never authorize the tool; the native fallback still enforces the caller's interaction flag.
The captain retained this guard because Apple's reader has no universal no-prompt switch; tool-first by itself is not proof that an arbitrary item cannot ask.
The value stays in memory, never disk or logs; no ACL or grant changes.
External rotation is observed on the next uncached read.
The value read is `find-generic-password -w` of that one item (`src/main/host/claudeKeychainTool.ts`), with Apple's hexadecimal output decoded for values containing non-printable bytes such as multiline JSON.

The regular macOS integration test (`src/main/host/claudeKeychainAccess.integration.test.ts`) creates its store under a scratch home’s `Library/Keychains/`, so macOS gives the item real partition entries.
It covers a Claude Code-style item, Apple-first success without direct value access, exact-account resolution through a real child, multiline credentials, and refusal of `apple-tool:` plus another team without invoking the tool.
It compares the real search list before and after; no real credential or real-item access rule is read or changed.
The unit fixture uses the hex-encoded plist returned by macOS and rejects malformed layouts and other partitions.

W1 S3, the Claude-seat plan's section 4.2.
A cut-off - a provider that stops serving an account - is expected input, never an error path, and it is classified in ONE place from typed fields only: `classifyClaudeSignal` in `src/shared/authFailure.ts`, beside `isAuthFailureMessage`, which stays the classifier for Pi and for rows recorded as prose.
Three product-neutral classes ride `turn_failed.cutOff` (`src/shared/events.ts`), so no provider's vocabulary crosses the event seam:

- `signed_out`: the assistant's `authentication_failed`, or a result with `api_error_status: 401`.
- `refused`: `oauth_org_not_allowed` or `billing_error`, or `api_error_status: 403`.
- `no_headroom`: a pushed rate-limit `status: "rejected"` in the same failed turn, with `rate_limit` or no typed error at all; it carries that reading's `resetsAt` (epoch ms).
  `rate_limit` alone is not enough: the client also types a transient capacity 429 and a model it has switched off that way, so without the vendor's rejected reading it is an ordinary failed turn, and a typed error that is not a cut-off beats a reading.
  So does a loop that stopped on its own bound (`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`): its requests were answered, so a reading it saw on the way is not why it stopped.
  Only an API stop (`success` with `is_error`, or `error_during_execution`) can be read as a spent allowance; the real client against a stub API returning the vendor's `rejected` headers pushes the reading before it reports the error (`claudeFirstmateSession.integration.test.ts`).

Whether a turn failed is the result's to say (`is_error`, or a subtype other than `success`); only the turn's own assistant messages count, never a subagent's (`parent_tool_use_id` set), whose error the main agent may have recovered from.
Every other failure (`overloaded`, `server_error`, `unknown`, `max_output_tokens`, `invalid_request`, `model_not_found`, and the `error_*` results) is an ordinary failed turn with the honest retry.
A turn that answered is `ok` whatever its pushed reading said, and so is a turn the client cut short for a steer or an interrupt (`terminal_reason` `aborted_*`) with no API error behind it.
When one turn carries several signals the sign-in wins, then a refusal, then a spent allowance.
A backend declares which kind of failure it reports (`ControlProfile.failureSignals`: `typed` for Claude, `text` for Pi); a typed backend's failure without a class is never read as a sign-in.
The record keeps the class: `TaskService.turns.recordTurnFailure` stores `failureSignals: "typed"` and the `cutOff` beside the words (a typed backend's fatal close, `TaskClosing.closeRecord`, stores `failureSignals: "typed"` too, with no class: a session that exits is a session failure), and the feed line and the stall card read it back through `typedFailureOf`, so `plainProblem` picks the line by class (`signed_out` the sign-in line, `no_headroom` the allowance line, `refused` the plain fallback until it has its own) and never runs its sign-in, allowance or slow-down word rules over a typed failure.
A typed `signed_out` takes the crewmate's sign-in path (`CrewSupervisor.turnComplete`); `no_headroom` and `refused` take the provider-failure path, and the account's fact then holds the lane (`docs/inbox.md`, "A lane on a withheld account").
A Pi failure is prose, with one typed exception: xAI's `402` (credits spent) is read from where Pi's error puts the status, `xai API error (402): ...` or `402: ...`, never from its words, and only for xAI (`isOutOfCreditsRefusal`, with the session's provider; another provider's 402 can be about one oversized request).
`piEvents` types it as `no_headroom` with no reset; the host fills the reset where the hold is recorded (`recordCutOff` in `src/core/quota/spentAllowance.ts`, and `ownAccounts` on a computer that runs work), from the limiting window of that sign-in's latest reading on the computer where the refusal happened.
A 402 with no reset to hold against stays an ordinary failed turn, retried as before.
On this Mac the hold also lays a `rejected` reading over that window, the way Claude's refusal is laid over its meter, so the sign-in reads 0% left until the reset and routing skips it; `servesThere` already skips a held sign-in on a computer.
The hold keeps the lowest percent left the reading showed (`AccountCutOff.leftPercent`), and a later allowance reading that shows more ends it early (`AccountVault.noteReading`, from the sensor's `onAccepted`), as after a top-up; a Claude hold records none and clears only as before.
The failure's record keeps the class beside the prose, so the feed line reads `no_headroom`, and the crewmate's lane waits without turns (`docs/inbox.md`).
The pushed reading's `status` is kept on its window (`pushed_quota.status`, migration 51); a reading from before the column has none, which is unknown, never `allowed`, and its `resets_at` was stored in epoch seconds, so a reset is trusted only on a `rejected` reading.
The rules above still hold: only a 401 renews, and "sign in again" comes only from proof.

### The cut-off on the account

W1 S7.
Whoever observes a typed cut-off - a crewmate's turn (`CrewSupervisor.turnComplete`), the seat's (`FirstmateAgent.onSessionEvent`) or the kind classifier's (`AdaptedDecisionModel`, W1 S10) - records it on the account with `AccountVault.noteCutOff`.
A crewmate's turn on another computer met it on that computer's own sign-in, so that computer records it in its own store and this Mac records nothing; that computer's account rows carry it to this Mac, which holds the task on it as it holds one on its own (`docs/helper.md`, "Its own sign-ins").
The fact lives on the account's registry row (`cutOff`, additive: a row an older build wrote has none, which is no cut-off), so it survives a restart, and it goes with the account when the account is removed.

- **One predicate.**
  `servesModels` (`src/core/accounts/credentialHealth.ts`) is false for a connected account whose health reason withholds it: `client_missing`, `client_outdated`, and the cut-off reasons `refused` and `signed_out`.
  The vault's `health()` lays a standing `refused` or `signed_out` over the backend's reading as `degraded` with that reason, so the account stays connected - only proof shows "sign in again" - but serves nothing.
  A proven sign-out still reads as one, and a missing client keeps its own sentence.
  The routing pool (`availableModelsByAccount`), the flagship's eligibility (`Flagship.isEligible` through `servesSync`) and account selection (`selectAccount`, whose `account` row says `skipped <label>: withheld (<reason>)`, and names a withheld account of another provider too, since routing never reached it) read the same predicate.
  Crew delivery holds a lane while a typed cut-off stands on its account - the fact itself, a spent allowance included - and leaves every other not-serving reason to fail its turn as before (`docs/inbox.md`, "A lane on a withheld account").
- **A spent allowance withholds nothing.**
  Its predicate is headroom: a pushed `rejected` reading is a zero window until its reset, even for the sensed Claude row (`withRejectedReadings`, laid over each sensed row by `createQuotaFetcher`'s `overlay`; a reading that flips to or from `rejected` refreshes the snapshot at once).
  The row the sensor measured keeps its other windows; a row it could not measure carries only the refusal; `auth_required` is left standing.
  Only a `rejected` reading's reset is trusted (rows from before migration 51 held seconds).
  The vault still records `no_headroom` with its reset for the lane and seat phases, and holds none with no reset named, since nothing could clear it.
- **Clearing, only when a fact changes** (owner Q1 a: never an automatic attempt).
  Each fact carries the stamp it was seen under (`CredentialStamp`): which login the store holds (a digest of the account and organisation the client's config names), when the credential was last written (the plain-file store's modification time, else the Keychain item's), and the client's version, projected from the shared store result by `claudeCredentialStamp` and never carrying a token.
  Its existing digest and file-first modification-date format stay compatible with saved refusals and records of pasted-code logins; neither needs a second reader.
  A part the note could not see is adopted from the next read that does, never counted as a change.
  One fact stands at a time, and a cut-off with a looser way back never replaces a stricter one that stands (refused, then signed_out, then no_headroom): a turn already in flight that settles after a refusal cannot hand it to a clock or a routine rewrite.
  Before the first read after a restart, `servesSync` and `withheldReason` answer from the standing fact.
  - `no_headroom` clears at its reset, or when the store names another login: the spent allowance belonged to the old login, so a swapped-in login is not held by it (and held crew lanes resume within the idle ladder's next tick).
  - `signed_out` clears when the store is written again, names another login, or the provider accepts that same login again.
    A dead login cannot renew itself, so a rewrite is a new sign-in (or a renewal that worked).
    A still-live login never rewrites itself, so a good allowance reading or a turn that succeeded on it clears the mark too (`AccountVault.noteAccepted`), and so does the row's Sign in once it ends, since a store the app cannot read shows no rewrite of the new login.
    A refusal is not cleared by any of those.
  - `refused` clears only on the captain's "Try Claude again" (`AccountVault.tryAgain`, which the seat's refused card calls through its `try-again` host op), another login, or another client version.
    A live credential renews itself routinely, so a rewrite alone is not a changed login here - which also means signing in again to the same account and organisation does not clear a refusal; "Try Claude again" is the way back after a fix that keeps the same login.
- **A changed login** (INF-1079).
  A person may switch the machine's Claude login outside the app when one runs out, and the account row stays the same, so the vault keeps the login its store last named on the row (`AccountRecord.login`, kept across a restart).
  Each health or allowance read passes its non-secret projection to `AccountVault.noteCredentialRead`; the vault compares that login and updates Claude's row label from the current identity.
  There is no separate focus-time identity scan; the next ordinary reading observes a swap.
  The first login seen is adopted and an unreadable one is no change; a different one clears whatever cut-off stood on the account and is heard through `AccountVault.onLoginChange`.
  The composition root then forgets the old login's pushed readings (`PushedQuotaStore.forget`), drops its row from the last snapshot so it is not carried forward (`QuotaService.forgetAccount`), and takes a reading at once (`refresh("account-changed")`, which, like `demand`, chains after a refresh in flight instead of joining it).
  The sensor keeps each Claude answer under the login it was asked with (`createQuotaFetcher`'s `loginOf`): an answer the old login got is never served from the five-minute ledger, and one that lands after the switch is dropped as `skipped`.
  An unchanged login keeps its spacing, its backoff and its genuine refusal.
  The captain's Recheck allowance (the spent-allowance card, command search, Subscriptions' Refresh) refreshes with `demand`, the one reason that may ask for access (`FirstmateAgent.recheckAllowance`).
  That same store read supplies the login before the sensor considers a cached answer.
- **A refusal never renews.**
  `AccountVault.renew` answers `withheld` without asking the backend while a refusal stands; the health tick already skips a degraded account, and the sensor's 401 path reads `withheld` as `renewal_withheld` (not knowing), never a sign-out.
  A lost sign-in may still renew: only a 401 renews, and that is the path to proof.
