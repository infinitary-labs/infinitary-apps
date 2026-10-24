# Secrets

Secrets is the common contract for credential custody and approved uses, not a command that returns a value.
The implementation is a protected owner with native custody and fresh system authentication on macOS and Linux, behind a request coordinator and an optional command-runtime seam.
Production does not construct the owner yet: no production task receives this command and no existing credential consumer has migrated.

## Intended use

Use Secrets to apply a credential to an approved program or brokered operation while keeping its value out of the requesting agent's environment and answers.
A recipient that receives a value is trusted with it and can copy or transmit it.
Secrets does not claim to sandbox arbitrary programs.

## When to use it, and when not

Use this contract for owned persistent credentials, explicit adapters to vendor custody, non-exportable keys and temporary capabilities.
Do not copy platform root keys into the store they unlock.
Do not use task names, project labels, working directories, process names or task-channel bearer files as authenticated secret authority.
The captain selected program-and-exact-operation authority in INF-1093; ordinary task shells remain unrestricted and there is no cross-task isolation guarantee.
Do not use secret permission as deployment, purchase, submission, release or merge consent.

## Owner and entry points

The intended single custody/access owner is Secrets, with native backends behind the core/host boundary.
The coordinator is `SecretRequests` in [`../src/core/secrets/requests.ts`](../src/core/secrets/requests.ts).
Its backend, `ProtectedSecrets` in [`../src/core/secrets/protected.ts`](../src/core/secrets/protected.ts), owns custody, the sealed vault, protected rules, checked recipient facts, authentication, the durable journal, execution and disposal.
The host supplies custody (`SecretCustody`) and fresh authentication (`FreshAuthentication`) through the adapters in `src/main/host/`.
The agent facade contains only metadata/receipt reads, `inject`, `status` and `cancel`.
Only a trusted controller can call `approve`; AXI has no approval, value getter, policy writer or global export.
The optional [`../src/core/axi/secretsCommands.ts`](../src/core/axi/secretsCommands.ts) table uses the existing launcher, isolated command process and task channel independently of a browser.
The channel organizes replies, not security principals.

## Operations and lifecycle

Discovery returns explicitly linked metadata only; system credentials are not general-purpose agent secrets.
An injection request contains references, recipient variable names, a reason, an intent ID and an explicit argument vector, never secret values.
The backend must resolve and snapshot the exact code, interpreter, dependencies, configuration and inputs before evaluating policy.
Its operation digest includes those facts, secret versions, policy revision, destination, delivery and permitted result.
Unsupported protection refuses before policy evaluation; there is no plaintext or unprotected fallback.
Identical intent submissions coalesce; changed input under the same intent refuses.
Ask returns a waiting receipt promptly, releasing the command process.
Fresh trusted authentication approves the exact request digest and expiry, not the agent's explanation or its task label.
A synchronous execution reservation prevents racing approvals from launching twice; the backend journals and consumes authority before the effect.
Status never launches or repeats an operation.
Cancellation withdraws unused authority and does not claim to stop an already-sent effect.
Receipts distinguish waiting, executing, completed, denied, cancelled, expired, invalidated, unavailable and unknown, with actual exit status on completion.
Backend errors and raw output never become receipt text.
The journal makes each use durable: after a restart a consumed use with no recorded end is unknown, a waiting one is invalidated, and the same intent answers its earlier receipt.

## Authority

Protected rules apply conjunctively to all required secrets and operation facts; Never precedes Ask, then Allow, and no match asks.
Rules live in a record checked by a custody key, with its head in custody, and are saved only with fresh local authentication of that exact revision; an Allow rule always names one operation.
New operations begin at Ask and human Allow requires fresh system authentication.
Requests expire after 300 seconds.
The saved short-read option is at most 600 seconds and 20 uses for eligible brokered reads, never program launches, broad writes or disclosure; it is not implemented in this first piece.
Saved reusable permission binds protected code, operation, delivery and destinations, not a task name.
Existing explicit service permissions retain only their original purpose and recipient; an agent cannot impersonate an app service using context labels.
The captain selected unchanged lock behavior: approval cards wait for the captain to return, without a new global pause rule.
Custody unavailability must still be reported honestly, never bypassed by approval.
The first protected rollout waits for both macOS and Linux.
On Linux the Secret Service lets any same-user program read the root while the collection is unlocked, and that rollout waits for the captain's decision on it ([`../docs/secrets.md`](../docs/secrets.md), "Native custody").

## Compositions

[Cards and consent](cards-and-consent.md) will supply trusted confirmation chrome; agent-authored HTML cannot grant secret authority.
[Tasks](tasks.md) and the durable inbox organize waiting work and resume notifications, not secret ACLs.
[Projects and working copies](projects-and-working-copies.md) organize linkage and immutable input preparation, without making a working directory a security identity.
[Integrations](integrations.md), AccountVault, forge, browser and device owners retain protocols, sign-in lifecycle and renewal; Secrets must not become a second renewer.
Platform custody, delegated custody and ephemeral adapters implement the same contract without claiming identical guarantees or recursively storing their own roots.
Authenticated remote approval needs exact digest, nonce, expiry, enrollment generation and enforcing-home binding; an ordinary paired-device role alone is insufficient.

## Failure and recovery

Changed code, dependencies, configuration, secret versions, policy or destination invalidate unused approval.
An unknown external effect is not retried; reconciliation or provider idempotency is required.
Cleanup failure is unknown, not a claim of secure erasure.
Removing a local record, ending future access and revoking a provider credential are distinct outcomes.
Pending and transient permissions must not survive restart, while explicitly saved rules may authorize new operations, never replay an interrupted effect.
Settings, secure entry, recovery, production wiring and migration remain unimplemented and must precede production use.
Encrypted recovery needs a separately held recovery key; platform/non-exportable keys use their owner's recovery or enrollment.
No automatic scan or import of unrelated user files is permitted.

## Uses

The complete maintained consumer register and migration obligations are in [`../docs/secrets.md`](../docs/secrets.md).
Every listed consumer remains unmigrated; adding this primitive does not complete the integration bridge or Google readiness.
Possible: approved brokered requests, exact-run shell injection, reviewed reusable scripts, narrow signing and origin-scoped browser session loading through their existing owners.

## Checks

[`../src/core/secrets/requests.test.ts`](../src/core/secrets/requests.test.ts) exercises disposable authentication, racing approval, deduplication, expiry, cancellation, changed facts, unknown effects and cleanup failure.
[`../src/core/axi/channel.test.ts`](../src/core/axi/channel.test.ts) runs the actual launcher and isolated command process against a disposable owner, launches a child with an invented credential, withholds direct and encoded output, and checks status, cancellation and the working directory.
[`../src/core/secrets/protected.test.ts`](../src/core/secrets/protected.test.ts) runs the protected owner on disposable custody: an exact use from a private copy, changed copies, secrets and rules invalidating approval, saved reviewed scripts, a crash reconciled as unknown, a headless start with one signed remote decision, and indistinguishable unavailable references.
The vault, rules, journal and approval tests beside it check sealing, tampering, rollback, the chained journal and single-use proofs.
[`../src/main/host/linuxSecretCustody.test.ts`](../src/main/host/linuxSecretCustody.test.ts) is a probe that runs custody and the owner on a real gnome-keyring and session bus under a scratch HOME.
[`../src/main/host/darwinSecretCustody.scratch.test.ts`](../src/main/host/darwinSecretCustody.scratch.test.ts) does the same on a scratch macOS keychain, opt-in with `INFINITARY_SCRATCH_KEYCHAIN_PROBE=1`.
The fresh-authentication tests check LocalAuthentication without a prompt and polkit through stand-in commands; no automated test confirms a real person.
These tests do not prove containment against same-user programs.
No existing isolation test is removed or weakened by the revised authority model.

## Where the detail lives

[`../docs/secrets.md`](../docs/secrets.md) owns the threat model, consumer register, current limitations and the next protection boundaries.
[`../docs/axi-commands.md`](../docs/axi-commands.md) owns the launcher and command process.
