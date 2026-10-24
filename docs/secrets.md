# Secrets

The [Secrets primitive](../primitives/secrets.md) defines shared credential custody and exact-operation authority.
The code provides the protected owner, `ProtectedSecrets` in [`../src/core/secrets/protected.ts`](../src/core/secrets/protected.ts), behind the request coordinator and the optional AXI command seam.
It also provides native custody and fresh system authentication for macOS and Linux in `src/main/host/`.
Production does not construct the owner: no task receives the command, and there is no Settings → Secrets, secure entry screen or migration yet, so every production use still refuses.
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

`ProtectedSecrets` refuses whenever custody, protected rules, the recipient's checked inputs or the durable journal is unavailable; there is no plaintext, environment or unprotected fallback.
It never accepts an agent-written rules file or a script digest supplied by the requester as proof of approval.
The disposable adapters under `tests/helpers/` are fixtures, not a fallback for real credentials.

## Current command seam

`infinitary-secrets-axi` is shipped through the shared launcher and isolated command process.
It runs only where the host explicitly supplies a Secrets facade; production task wiring currently supplies none.
Bare invocation and `list` return linked metadata and current receipts; `show <reference>` describes one linked entry.
`inject --env '{"SERVICE_TOKEN":"s1"}' --reason 'Check staging' --id staging-check -- /bin/sh ./scripts/check-staging.sh` submits references and an explicit argument vector.
The example neither approves that script nor reads a secret.
The channel adds the calling shell's working folder as the request's working directory, which the recipient binds like any other fact and which never grants authority.
`status <request>` reads a receipt and never executes again; `cancel <request>` withdraws unused authority.
Help and version use the ordinary runtime; unknown flags and unsupported commands refuse.
There is no `get`, `approve`, raw-output mode or session-wide environment export.
The command has no brokered-operation, private-file or private-input-stream delivery yet.
No command may turn a reference into an agent-readable value.

## Native custody

Custody holds only what the owner cannot protect on its own: a 32-byte random root key, and the head of the protected rules record.
Values never live in custody.
Each app flavor uses its own custody name, so a development run never reads the release root.
Every adapter reports what the platform answered (`value`, `absent`, `locked` or `unavailable`) and never falls back to a file, an environment variable or another store.

On macOS, [`../src/main/host/darwinSecretCustody.ts`](../src/main/host/darwinSecretCustody.ts) keeps each slot as a generic password item in the default keychain, through Security.framework in the app's own process.
An item the app creates trusts only the program that created it, so another program asking for it meets the Keychain's own dialog.
Every read and write is silent unless the caller asks for interaction: a locked keychain answers `locked`, never a dialog the person did not ask for.

On Linux, [`../src/main/host/linuxSecretCustody.ts`](../src/main/host/linuxSecretCustody.ts) keeps each slot as an item of the schema `app.infinitary.Secrets` in the default collection, through libsecret on the session bus.
It refuses libsecret's file backend.
The Secret Service has no per-program rule: while the collection is unlocked, any program of the same user on that session can read these items, an agent's ordinary shell included.
With the root and the sealed files, such a program can read every value.
Linux custody therefore stops an edited or copied file and an agent that goes through Infinitary, but not an agent that asks the Secret Service directly.
Closing that needs a separate system user or a sandbox, which nothing here creates; the first Linux rollout waits for the captain's decision on it.

The root opens once per owner start and is read again at every use, so a locked or replaced root stops a use that was already approved.
Only the trusted controller's first Add creates a root, and only where nothing was ever sealed.
A missing root beside sealed records is `lost`, never silently replaced.

## The vault

Each value is a record under `<userData>/secrets/values/`, sealed with AES-256-GCM under a key derived from the root (HKDF-SHA256) and bound to its own metadata.
Each record's metadata carries a check under a separate derived key, so a relabelled or re-versioned file is left out rather than shown or repaired.
Adding or replacing a value writes a private temporary file, syncs it, renames it over the old record and syncs the folder, and raises the version.
There is no reveal: the owner opens a value only to deliver it to an approved recipient.

## Protected rules

The authority record (`<userData>/secrets/authority.json`) holds the rules, the enrolled approval devices and the home they bind to, under a revision number.
Its check is keyed by the root, and its head (revision and digest) lives in custody, so an agent-written, edited or older valid record is refused.
A refused record makes the rules `tampered`, and every use answers unavailable until the captain saves a new revision with fresh authentication.
Saving needs a fresh local confirmation of that exact revision; it writes the next record, moves the head in custody, then renames, so an interruption leaves one record that matches the head.
Rules apply to every required secret together: Never precedes Ask, then Allow, and no match asks.
An Allow rule always names one operation key; there is no wildcard Allow.
Rehearsal evaluates a use against the rules and returns its checked facts without journaling, approving or running anything.

## The recipient

[`../src/core/secrets/recipient.ts`](../src/core/secrets/recipient.ts) binds the program, its interpreter and every argument naming a regular file by digest.
A file this user could change, by writing it or any folder above it, is copied into the use's private folder and runs from there; one it cannot change runs in place and is hashed again right before it starts.
A script's interpreter is started directly with the script's copy, so neither its `#!` line nor the search path is read again at launch.
A `#!` line needs an absolute interpreter and at most one argument; `#!/usr/bin/env NAME` resolves NAME on the search path when the use is prepared, and any other form is refused.
The working directory is bound by its real path.
The recipient's environment is a short list of base variables from the host environment plus the approved values; a mapping onto a base variable is refused.
Its output stays private and is removed with its folder when the use ends; removal is not secure erasure.
The operation key a rule names is the digest of these facts.
Sibling files a script reads while it runs and programs the recipient starts are not bound, a recipient's own children may outlive it, and a program that cannot run from a copy cannot be served this way.

## Journal and reconciliation

The journal (`<userData>/secrets/history.jsonl`) records each use's request, approval, consumption and end, one line per event, synced before the call returns.
Each line carries a check chained to the line before it, so a forged or edited line ends what is read.
Consumption is written before the recipient starts; a journal that cannot be written refuses the launch.
At the next start, a use consumed with no recorded end is `unknown`, because its effect may have happened, and a use still waiting is `invalidated`.
The same intent ID then answers its earlier receipt instead of running again, so a restart never replays a use.
Private folders a previous process left are removed at start.
Truncating the journal's last lines is not detected.

## Trusted approvals

A human Allow needs the operating system to confirm the person now, for that one use.
On macOS, [`../src/main/host/darwinFreshAuthentication.ts`](../src/main/host/darwinFreshAuthentication.ts) asks LocalAuthentication's device-owner policy (Touch ID, a paired watch or the login password) through a new context every time.
On Linux, [`../src/main/host/linuxFreshAuthentication.ts`](../src/main/host/linuxFreshAuthentication.ts) asks polkit for the action `app.infinitary.secrets.approve`, whose policy is meant to keep no confirmation (`auth_self`).
Only `pkcheck`'s exit 0 confirms, and `pkcheck` and `pkaction` run only from a root-owned system folder with an environment of their own, so a program on the person's search path cannot answer in polkit's place.
The polkit policy file is not shipped yet, so Linux reports fresh authentication as unavailable and a human Allow waits.
A confirmation becomes an in-process proof bound to one use's digest and expiry, spent once and never saved, so no approval survives a restart.
A request expires after 300 seconds.
A computer that cannot confirm the person, such as a headless start, refuses local approval and waits; it still serves saved rules and remote decisions.

## Remote decisions

A device approves from elsewhere only with a P-256 key enrolled for this purpose, never its paired-view identity, and each re-enrollment raises its generation.
Each waiting use gets one random nonce, and a decision passes only when the device, at its current generation, signed the home, request, digest, nonce, expiry and decision.
Racing decisions spend the nonce once, and challenges live in memory only.
Enrollment and the phone's approval screen are not built yet.

## History

History is the journal read as metadata: what was asked, which secrets, the bound program, the requester's reason shown as theirs, how it was approved and how it ended.
It never holds a value, an environment or a full request body.
It stays until the captain deletes it, and the owner reports its storage use and exports it; deleting it refuses while a use is running.
It is local evidence, not an immutable audit log.

## Before production

These remain before any production use:

- Settings → Secrets with trusted secure entry, Uses, Rules, History, export and storage use, rehearsal, End access and recovery.
- Wiring the owner and both platforms' adapters into the composition root, and shipping the polkit policy with the Linux packages.
- Fresh human confirmation and Keychain custody shown working in the app on both platforms.
- The captain's decision on the Linux same-user limit above.
- Enrollment and the phone's approval screen for remote decisions.
- The recovery key, the bounded brokered reads and each consumer migration below.

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
Settings → Secrets, searchable metadata, Uses/Rules/History, trusted Add/Replace, rehearsal, End access, export/storage display and recovery are not built yet.
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
