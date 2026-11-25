# Secrets

Secrets is the common contract for credential custody and approved uses, not a command that returns a value.
The implementation is a protected owner with native custody and fresh system authentication on macOS, Linux and Windows, behind a request coordinator and an optional command-runtime seam.
The app builds the owner on the person's own data folder on macOS, Linux and Windows, so local tasks receive this command; the Google sign-in and MCP server keys have migrated, and every other listed consumer has not.

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
The host supplies custody (`SecretCustody`), fresh authentication (`FreshAuthentication`) and the clipboard writer behind the person's Copy value (`SecretClipboard`) through the adapters in `src/main/host/`.
Copy value is the one way a value leaves the owner for a person: only the window's own Settings request starts it, each press asks this computer's confirmation, and the copy is journaled before the value moves ([`../docs/secrets.md`](../docs/secrets.md), "Copying a value").
The agent facade contains only metadata/receipt reads, `inject`, `status`, `cancel` and `ask`, which asks the captain to keep a secret by name, place and reason and never carries a value; Infinitary draws the field, and only `SecretsSettings.keep`, called by the window's own request, writes what was typed ([`../docs/secrets.md`](../docs/secrets.md), "Asking to keep a secret").
`bring` asks the captain to bring secrets from another tool: Infinitary binds the program or file by real path and digest, raises its own card, and on the captain's press runs or reads it itself, sealing each ticked value with no agent ever holding one; a file or tool is read only as such an approved bring, never by an automatic scan ([`../docs/secrets.md`](../docs/secrets.md), "Bringing secrets from another tool"); on a computer that runs work the tool runs there and its values cross to the home once: only the ticked ones for Bring into Secrets, every value a `lines` source holds for Read it.
A named JSON read only returns selected string fields to the protected owner; a run that names kept keys needs fresh approval and the same recipient and version checks as `inject`, and the result still contains no value.
Only a trusted controller can call `approve`; AXI has no approval, value getter, policy writer or global export.
The optional [`../src/core/axi/secretsCommands.ts`](../src/core/axi/secretsCommands.ts) table uses the existing launcher, isolated command process and task channel independently of a browser.
The channel organizes replies, not security principals.

## Operations and lifecycle

Discovery is global: it returns the metadata of every secret the captain added and made visible, never a value, and listing grants no use; system credentials are not general-purpose agent secrets.
A task on another computer discovers the same catalog through the home's metadata-only work request; where that computer's app takes them, its command also asks the home for uses and asks it to keep a secret, both decided and raised on the home, and an ask never carries a value ([`../docs/secrets.md`](../docs/secrets.md), "On a computer that runs work" and "Asking to keep a secret").
An injection request contains references, recipient variable names, a reason, an intent ID and an explicit argument vector, never secret values.
The backend must resolve and snapshot the exact code, interpreter, dependencies, configuration and inputs before evaluating policy.
Its operation digest includes those facts, exact sealed-record revisions, policy revision, destination, delivery and permitted result.
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
New operations begin at Ask and human Allow requires fresh system authentication, except an app sign-in's own brokered use ("App sign-ins").
Requests expire after 300 seconds.
An optional bounded permission covers eligible brokered reads for at most 600 seconds or 20 uses, never program launches, renewals, writes or direct value disclosure.
It binds the exact operation and sealed-record revisions, and disappears on restart, secret replacement, a protected rule change or End access.
Saved reusable permission binds protected code, operation, delivery and destinations, not a task name.
Existing explicit service permissions retain only their original purpose and recipient; an agent cannot impersonate an app service using context labels.
The captain selected unchanged lock behavior: approval cards wait for the captain to return, without a new global pause rule.
Custody unavailability must still be reported honestly, never bypassed by approval.
The first protected rollout covers both macOS and Linux.
Linux's Secret Service does not require app-specific access control; the GNOME Keyring backend used by the proof lets another same-user program read the root while unlocked ([`../docs/secrets.md`](../docs/secrets.md), "Native custody").
The app composes Linux custody with that boundary.

## Compositions

[Cards and consent](cards-and-consent.md) will supply trusted confirmation chrome; agent-authored HTML cannot grant secret authority.
[Tasks](tasks.md) and the durable inbox organize waiting work and resume notifications, not secret ACLs.
[Projects and working copies](projects-and-working-copies.md) organize linkage and immutable input preparation, without making a working directory a security identity.
[Integrations](integrations.md), AccountVault, forge, browser and device owners retain protocols, sign-in lifecycle and renewal; Secrets must not become a second renewer.
Platform custody, delegated custody and ephemeral adapters implement the same contract without claiming identical guarantees or recursively storing their own roots.
Authenticated remote approval needs exact digest, nonce, expiry, enrollment generation and enforcing-home binding; an ordinary paired-device role alone is insufficient.
A device enrolls only by the captain's confirmation on the enforcing home after comparing a code from its key, and [Devices](../docs/devices.md)' pairing stays a separate identity ([`../docs/secrets.md`](../docs/secrets.md), "Remote decisions").

## Failure and recovery

Changed code, dependencies, configuration, sealed records, policy or destination invalidate unused approval.
An unknown external effect is not retried; reconciliation or provider idempotency is required.
Cleanup failure is unknown, not a claim of secure erasure.
Removing a local record, ending future access and revoking a provider credential are distinct outcomes.
Pending and transient permissions must not survive restart, while explicitly saved rules may authorize new operations, never replay an interrupted effect.
Settings and secure entry use the host capability the app supplies on macOS, Linux and Windows; each consumer migration remains separate work.
Encrypted recovery needs a separately held recovery key; platform/non-exportable keys use their owner's recovery or enrollment.
The private archive, native file choices, history-preserving restore coordinator and Settings recovery controls share the protected owner ([`../docs/secrets.md`](../docs/secrets.md), "Recovery boundary").
Restore requires fresh native confirmation, drains pending work without starting an effect, refuses running uses or uncollected results, and syncs a fresh sealed home before one native activation.
It resets permissions and approval-device trust, keeps local history and marks archive history as recovered metadata rather than live authority.
Unknown activation retains its stage for reconciliation and never repeats the write; previous history is removed only by explicit deletion.
Where storage reads lost or tampered and no backup exists, Start over takes the same path with no archive under its own fresh confirmation: an empty store with reset permissions and kept history ([`../docs/secrets.md`](../docs/secrets.md), "Starting over").
No automatic scan or import of unrelated user files is permitted.

## Uses

The complete maintained consumer register and migration obligations are in [`../docs/secrets.md`](../docs/secrets.md).
The Google integration's sign-in is migrated, as a hidden entry an app service keeps and uses through its own broker ([`../docs/secrets.md`](../docs/secrets.md), "App services").
MCP server keys are migrated too: each value on a server's Runs line but `PATH` is a hidden entry marked `forProgram`, given to the server's program as it starts through the integration's program broker (`programSecretBroker`, "Programs that keep running"); every other listed consumer remains unmigrated.
A sign-in the person made in the app is the consent to the app's own use of it: a broker that declares `signIn` and names only hidden entries not marked `forProgram` runs with no card, confirmation or saved decision ("App sign-ins").
A key the person gave with a program is the consent to every start of it in the same way: a broker that declares `givenWithProgram` and names only hidden entries marked `forProgram` runs with no question ("Programs that keep running").
Possible: approved brokered requests, exact-run shell injection, reviewed reusable scripts, narrow signing and origin-scoped browser session loading through their existing owners.

## Checks

[`../src/core/secrets/requests.test.ts`](../src/core/secrets/requests.test.ts) exercises disposable authentication, racing approval, deduplication, expiry, cancellation, changed facts, unknown effects and cleanup failure.
[`../src/core/axi/channel.test.ts`](../src/core/axi/channel.test.ts) runs the actual launcher and isolated command process against a disposable owner, launches a child with an invented credential, withholds direct and encoded output, and checks status, cancellation, the working directory and the crew's pre-check.
[`../src/core/secrets/protected.test.ts`](../src/core/secrets/protected.test.ts) runs the protected owner on disposable custody: an exact use from a private copy, changed copies, secrets and rules invalidating approval, saved reviewed scripts, a crash reconciled as unknown, a headless start with one signed remote decision, indistinguishable unavailable references, the crew's pre-check naming each failed check while recording nothing, and a copy confirmed, journaled before it is written and refused when it cannot be.
The vault, rules, journal and approval tests beside it check sealing, tampering, rollback, the chained journal and single-use proofs; `approvals.test.ts` also checks a decision the phone's own signer made against the home's verifier.
[`../src/core/secrets/settings.test.ts`](../src/core/secrets/settings.test.ts) enrolls a phone's key by its code and this computer's confirmation, runs a use on its signed Allow, refuses other keys, digests, generations and homes, denies without a key and stops its approvals; the phone check's `testSecretsApprovals` does the same from the simulator's screens.
[`../src/core/secrets/asks.test.ts`](../src/core/secrets/asks.test.ts) asks to keep secrets and keeps them with one Save, answers kept or unavailable at once, refuses a spent pass, a missing value and a Save sent as a card choice, replaces a kept secret by its version, shows Unlock on a locked store, and resumes a waiting ask after a restart, and carries a how-to to a work computer's home only when it takes one; [`../src/core/secrets/askHow.test.ts`](../src/core/secrets/askHow.test.ts) draws an asker's how-to as written and refuses a script, a style, a field, an unsafe link or a link hiding its address; the phone check's `testSecretAskKeptFromPhone` keeps one from the simulator.
[`../src/core/secrets/bring.test.ts`](../src/core/secrets/bring.test.ts) brings invented values from stand-in programs and files in each shape and proves each kept one by an injection, and refuses a changed program, a spent pass, an expired or withdrawn bring and a failing source, which reports only its exit code; [`../src/core/secrets/bringElsewhere.test.ts`](../src/core/secrets/bringElsewhere.test.ts) joins the home's owner and a computer that runs work's command by the work request alone and proves only the ticked value crosses, once; [`../src/core/secrets/bringReaders.test.ts`](../src/core/secrets/bringReaders.test.ts) reads `.env` text and zero-ended entries; `tests/e2e/secret-bring.spec.ts` brings one by keys alone and finds the invented value in no saved file, card, record or inbox.
[`../src/main/host/darwinSecretClipboard.test.ts`](../src/main/host/darwinSecretClipboard.test.ts) writes a copy with its markers on a uniquely named pasteboard and clears it only while it still holds it; [`../src/main/host/windowsSecretClipboard.test.ts`](../src/main/host/windowsSecretClipboard.test.ts) and [`../src/main/host/linuxSecretClipboard.test.ts`](../src/main/host/linuxSecretClipboard.test.ts) check the same rules against stand-ins of user32's calls and Electron's clipboard, with the Windows formats written or none at all.
[`../src/main/host/linuxSecretCustody.test.ts`](../src/main/host/linuxSecretCustody.test.ts) is a probe that runs custody and the owner on a real gnome-keyring and session bus under a scratch HOME.
[`../src/main/host/darwinSecretCustody.scratch.test.ts`](../src/main/host/darwinSecretCustody.scratch.test.ts) does the same on a scratch macOS keychain, opt-in with `INFINITARY_SCRATCH_KEYCHAIN_PROBE=1`.
The fresh-authentication tests check LocalAuthentication without a prompt and polkit through stand-in commands; no automated test confirms a real person.
These tests do not prove containment against same-user programs.
No existing isolation test is removed or weakened by the revised authority model.

## Where the detail lives

[`../docs/secrets.md`](../docs/secrets.md) owns the threat model, consumer register, current limitations and the next protection boundaries.
[`../docs/axi-commands.md`](../docs/axi-commands.md) owns the launcher and command process.
