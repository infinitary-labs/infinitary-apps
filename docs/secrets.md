# Secrets

The [Secrets primitive](../primitives/secrets.md) defines shared credential custody and exact-operation authority.
The current code provides a disposable request coordinator and optional AXI command seam only.
No native backend, production task grant, secure entry screen or migration is installed.
The existing integration bridge remains in use and is not described as protected by this foundation.

## Threat model and the accepted boundary

Ordinary shells remain unrestricted.
Task and project context can organize discovery, requests and history, but cannot authenticate a requester or widen secret authority.
Possession of another task's same-user channel file does not confer permission to use its secret grants: task-specific grants are not part of this design.
One protected owner must independently validate the exact recipient and operation against fresh human approval or protected saved rules.
Protect custody and the authority-producing state, not just an encrypted file.
The approved recipient receives a value and is trusted with it; this is not arbitrary-program containment or protection against every same-user malicious program, a compromised OS or an administrator.
Direct and encoded output must not flow to the requesting agent merely because a masking pass found no familiar string.
The default result is state and exit status; any typed projection or artifact needs its own reviewed rule.
Secret permission remains separate from consent for an external action.

The first-piece `SecretsBackend` seam deliberately has no production implementation.
Its disposable adapters are fixtures, not a fallback for real credentials.
An implementation must refuse when custody, authenticated confirmation, protected policy, checked immutable inputs or atomic pre-effect journaling is unavailable.
It must never accept an agent-written policy file or a script digest supplied by the requester as proof of approval.

## Current command seam

`infinitary-secrets-axi` is shipped through the shared launcher and isolated command process.
It runs only where the host explicitly supplies a Secrets facade; production task wiring currently supplies none.
Bare invocation and `list` return linked metadata and current receipts; `show <reference>` describes one linked entry.
`inject --env '{"SERVICE_TOKEN":"s1"}' --reason 'Check staging' --id staging-check -- /bin/sh ./scripts/check-staging.sh` submits references and an explicit argument vector.
The example neither approves that script nor reads a secret.
`status <request>` reads a receipt and never executes again; `cancel <request>` withdraws unused authority.
Help and version use the ordinary runtime; unknown flags and unsupported commands refuse.
There is no `get`, `approve`, raw-output mode or session-wide environment export.
The first-piece command has no brokered-operation, private-file or private-input-stream delivery yet.
No command may turn a reference into an agent-readable value.

## Backend obligations before protected rollout

Prepare must establish custody availability and resolve every reference before rule evaluation.
Unknown and inaccessible references must have the same unavailable response without other-project names or counts.
Validate mapping collisions, missing values and forbidden interpreter/launcher/channel variables against a clean allowlisted environment built through `hostEnv`.
Bind executable, interpreter, script snapshot, dependencies, configuration, input files, arguments, working directory, secret versions, policy revision, delivery, destinations and approved results.
Do not hash a script and then run its mutable source path.
Revalidate all facts at consumption; changed facts require new review, even with an unchanged filename.
A reusable rule authorizes the protected operation, not arbitrary commands run by a similarly named task.
Journal intent and consume authority atomically before launch; a failed journal refuses execution.
Keep raw stdout, stderr, diagnostics and overflow private, dispose them across success, cancellation, failure and restart, and never call disposal secure erasure.
A failed or ambiguous external effect remains unknown until reconciled, never automatically replayed.
Native custody and trusted confirmation must be proven on macOS and Linux before either protected rollout.
Headless startup and authenticated remote decisions need the same exact-operation contract; they do not authorize hosted services or team infrastructure.
No real keychain or signing access occurs without the captain's separate consent.

## Saved product settings

Rollout is staged: finish each migrated owner together with all readers and tests before the next cutover.
Existing lock behavior stays unchanged; an approval request becomes a card waiting for the captain to return.
The first protected rollout waits for macOS and Linux together.
History stays until the captain deletes it, with export and a clear storage-use display, never an arbitrary record-count cutoff.
History records metadata, not values or full request bodies, and is not immutable audit evidence.
Shell support includes exact one-off commands/scripts and reusable reviewed scripts, never implicit evaluation of an arbitrary command string.
New secret policy is Ask; Never overrides Ask, then Allow, with all required secrets evaluated conjunctively.
Fresh human authentication, 300-second request expiry and one-use program approval remain required.
The optional 600-second/20-use permission applies only to supported brokered reads and is not implemented here.
Settings → Secrets, searchable metadata, Uses/Rules/History, trusted Add/Replace, rehearsal, End access, export/storage display and recovery belong to the protected-foundation piece, not this disposable proof.
No reveal, partial-value display, clipboard export or agent-authored secret-entry form is planned.

## Consumer register

Every row remains unmigrated; this is the maintained source-to-owner contract, not an assertion that direct readers are retired.
A migration includes writers, every reader, replacement/renewal, interruption, rollback and old-app compatibility, without permanent dual writes or plaintext backups.
The current owner retains protocol and lifecycle decisions; Secrets supplies custody, scoped use and atomic versioned replacement.
Public certificates, host pins, fingerprints, token counts and non-secret metadata do not become vault values.

| Area | Current entry points | Adapter and required preservation |
| --- | --- | --- |
| Integration slots and Google | `src/core/integrations/secrets.ts`; `providers/google/{googleIntegration,signIn,client}.ts` | Replace the temporary backend through INF-785; retain brokered requests, explicit grants and one Google renewer with atomic replacement. |
| Connected programs | `src/core/integrations/providers/mcp/{runs,store,mcpIntegration}.ts` | Include inline credential assignments as well as named slots; exact recipient delivery, not inherited session credentials. |
| Pi accounts | `src/core/pi/{accountVault,piAccountBackend,piAuth,modelRuntime}.ts` | Inject a Secrets-backed CredentialStore for account and base auth stores; retain serialized refresh and account lifecycle. |
| Usage, Copilot and models | `src/core/quota/{auth,fetchQuota,http}.ts`; `src/core/pi/copilotMeter.ts`; model/account readers | Use the same account adapter; remove direct-file routes without confusing unavailable with signed out or adding renewal. |
| Custom APIs | `src/core/pi/{customApiAccounts,customApiTransport,customApiPi}.ts` | Keys and secret headers in custody; credential-free Pi configuration and existing destination policy. |
| Decision models | `src/core/decisions/jev/jevKeyStore.ts`; `openRouterDecisionModel.ts`; `src/core/pi/decisionModels.ts` | Scoped service access instead of per-model key files; preserve model routing. |
| Claude | `src/core/claude/{claudeAuth,claudeQuota,claudeStoreLease,session}.ts`; `src/main/host/{darwinKeychain,claudeKeychainTool}.ts` | Delegated vendor custody through one access adapter; installed client and renewal remain vendor-owned, with no copied permanent token store. |
| Forge and Git | `src/core/forge/signIns.ts`; `providers/`; `src/core/workspace/forgeAuth.ts`; `resources/git-askpass` | One per-host credential route for APIs, attachments and exact Git use; retire askpass's direct file read. |
| Remembered websites | `src/core/browser/{webSignIns,taskBrowsers}.ts`; `src/core/placed/placedBrowsers.ts`; `src/main/host/taskBrowser.ts` | Origin-scoped session loading, explicit grants, refresh and existing work-device transfer semantics. |
| Desktop identity | `src/core/devices/{identity,ownKey,joinedHome,dial,ssh}.ts` | System-only keys/signing/connection adapters, preserving bootstrap and pairing; no agent discovery. |
| iPhone/iPad identity | `PhoneIdentity.swift`; `JoinLink.swift`; `PinnedTransport.swift` | Device-only native custody; separate fresh-authenticated exact-approval capability, not ordinary paired-view authority. |
| Temporary capabilities | `src/core/axi/channel.ts`; `src/core/devices/pairing.ts`; `src/core/browser/connectionGuard.ts`; OAuth state/proof keys | Explicit ephemeral lifetime and recipient, not generic durable vault entries or protected task identity. |
| One-use passwords | `src/core/devices/sshPassword.ts`; remote login and system installer authentication | No persistence; exact recipient or delegated system authentication, not reusable captured passwords. |
| Shell and remote work | `src/core/hostEnv.ts`; `src/core/jobs/jobManager.ts`; `src/core/claude/session.ts`; `src/core/helper/` | Audit inherited credentials, separate recipient environments and reference-only task/session specifications. |
| Development evaluations | `scripts/evals/runner.ts`; `scripts/check-account-models.ts`; `scripts/bench/attempt.ts` | Same service/account adapters and live-check consent, no parallel credential reader or renewer. |
| Build, signing and release | `.github/workflows/`; `scripts/phone-{certificates,release}.ts`; local signing/release scripts | Explicit delegated CI/platform custody and short-lived recipients; no copying signing material or organization credentials into a desktop vault. |

## Migration and recovery

Coordinate each old writer, journal the migration, verify values/versions and switch all readers atomically before retiring the old value.
Test interruptions around each transition, concurrent refresh, replacement, rollback and old-app encounters.
Stop before cutover when native protection or recipient compatibility is unavailable; do not silently remove the feature or mislabel legacy custody.
Preserve account labels, existing explicit grants and sign-in lifecycle without widening access or unnecessary sign-ins.
Google invocation consent, injection/exfiltration safeguards and deletion obligations remain separate from encrypted custody and from INF-958's readiness work.
Recovery uses a separately held recovery key; restore invalidates transient permissions and re-establishes device trust.
Non-exportable keys use their owner's recovery or re-enrollment.
Ending future use, local forgetting and provider revocation are distinct, and backups may retain old records.
