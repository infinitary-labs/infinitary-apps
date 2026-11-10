# Secrets

The [Secrets primitive](../primitives/secrets.md) defines shared credential custody and exact-operation authority.
The code provides the protected owner, `ProtectedSecrets` in [`../src/core/secrets/protected.ts`](../src/core/secrets/protected.ts), behind the request coordinator and the optional AXI command seam.
It also provides native custody and fresh system authentication for macOS and Linux in `src/main/host/`.
Settings → Secrets and its trusted controller are composed in the app, but the normal entry supplies no Secrets host capability, so production constructs no protected owner and grants no task command.
The explicit host seam lets disposable checks exercise the real controller, trusted cards, secure entry and sealed files without opening a native credential store.
No existing consumer is migrated or protected by this screen.
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
It runs only where the host explicitly supplies a Secrets capability; the supervisor then grants its closed facade to local tasks, and the catalog alone to a task on another computer.
The normal entry supplies none, and another computer receives no use grant before its own owner is enrolled.
Discovery is global: every task's command lists the same secrets the captain added, whatever its project or computer, and the task's name selects nothing.
Bare invocation and `list` return that metadata and current receipts; `show <reference>` describes one entry.
A listed secret carries its environment label when it has one, as context beside its name, never as a filter.
Listing or naming a reference grants no access: each use still needs that entry to be agent-visible and an exact approval or Allow rule.
A task on another computer lists and shows the same catalog: its command there asks the home over the authenticated work route (`inf:work:secrets`), whose answer holds each secret's reference, name, version and environment label and nothing else.
There, `inject`, `status` and `cancel` answer `unavailable` with a fixed explanation, because a use runs only for a task on the computer that keeps the value.
No value, receipt, approval or custody reaches that computer, and its crewmate reads `CREWMATE_SECRETS_CATALOG_LINE` instead of `CREWMATE_SECRETS_LINE`.
`inject --env '{"SERVICE_TOKEN":"s1"}' --reason 'Check staging' --id staging-check -- /bin/sh ./scripts/check-staging.sh` submits references and an explicit argument vector.
The example neither approves that script nor reads a secret.
The channel adds the calling shell's working folder as the request's working directory, which the recipient binds like any other fact and which never grants authority.
`status <request>` reads a receipt and never executes again; `cancel <request>` withdraws unused authority.
Help and version use the ordinary runtime; unknown flags and unsupported commands refuse.
There is no `get`, `approve`, raw-output mode or session-wide environment export.
The command has no brokered-operation, private-file or private-input-stream delivery yet.
No command may turn a reference into an agent-readable value.

## Native custody

Custody holds only what the owner cannot protect on its own: a 32-byte random root key, the head of the protected rules record, and the selected directory of a recovered home.
Values never live in custody.
An existing home keeps its two native items unchanged.
A recovered home carries its root, authority head and directory identifier together inside the native root item, so their activation is one native write rather than a file-controlled pointer or a multi-item transaction.
Each app flavor uses its own custody name, so a development run never reads the release root.
Every adapter reports what the platform answered (`value`, `absent`, `locked` or `unavailable`) and never falls back to a file, an environment variable or another store.

On macOS, [`../src/main/host/darwinSecretCustody.ts`](../src/main/host/darwinSecretCustody.ts) keeps each slot as a generic password item in the default keychain, through Security.framework in the app's own process.
An item the app creates trusts only the program that created it, so another program asking for it meets the Keychain's own dialog.
That is the operating system's program identity, not a promise that a reusable development runtime distinguishes every script it can load.
Production custody proof must use the packaged, integrity-checked app with its code-loading and debugging fuses, not infer that boundary from a scratch runtime's successful Keychain calls.
Every read and write is silent unless the caller asks for interaction: a locked keychain answers `locked`, never a dialog the person did not ask for.

On Linux, [`../src/main/host/linuxSecretCustody.ts`](../src/main/host/linuxSecretCustody.ts) keeps each slot as an item of the schema `app.infinitary.Secrets`, creating it in the default collection through libsecret on the session bus and replacing an existing item in its original collection.
It refuses libsecret's file backend.
Reads search for unlocked and locked paths separately: a locked match returns `locked`, without calling Unlock or Prompt.
Writes check the collection before creating an item, never run a returned creation prompt, and replace existing items through SetSecret, which cannot request an unlock.
Only the explicit `LinuxSecretCustody.unlock()` capability may invoke the service's unlock flow; it checks the resulting lock state rather than treating a dismissed prompt as success.
Potentially blocking service calls run in Koffi's native worker pool; local memory allocation, decoding and release do not make service calls.
Each operation owns a fresh service proxy, rather than keeping a process-wide encrypted session whose daemon may have restarted.
The fake-store tests cover locked reads and writes, racing locks, explicit and refused unlocks, native-item replacement and buffer lifetime; a separate native-thread test checks worker identity without opening a credential store.
Live locked-store verification requires the prepared disposable Linux desktop, a private session bus and a scratch keyring; it never uses the person's store.
The [Secret Service specification](https://specifications.freedesktop.org/secret-service/latest/ch10.html) does not require per-program access control; implementations may add it, and its [unlocking contract](https://specifications.freedesktop.org/secret-service/latest/unlocking.html) allows either per-client or shared unlocking.
The GNOME Keyring backend used by the Linux proof trusts the user's session: while the collection is unlocked, another same-user program can read these items, an agent's ordinary shell included.
With the root and the sealed files, such a program can read every value and bypass Infinitary's approval path.
Other providers differ: KeePassXC's Secret Service integration offers selected-group exposure and optional access-confirmation dialogs, but this adapter does not establish a portable app-bound custody guarantee from them.
Linux custody therefore protects the sealed files and mediates requests through Infinitary, without promising to stop an unrestricted same-user program that directly reaches an unlocked GNOME Keyring.
A stronger boundary needs a separately proven custody design; a sandboxed app's per-application Secret portal alone does not isolate Infinitary's unrestricted crew shells.
Production composition remains disabled; accepting this storage boundary does not itself enable it.

The root opens once per owner start and is read again at every use, so a locked or replaced root stops a use that was already approved.
Only the trusted controller's first Add creates a root, and only where nothing was ever sealed.
A missing root beside sealed records is `lost`, never silently replaced.

## The vault

Each value is a record under the selected Secrets home's `values/` directory, sealed with AES-256-GCM under a key derived from the root (HKDF-SHA256) and bound to its own metadata.
The existing home is `<userData>/secrets`; a recovered home is `<userData>/secrets/recovered/<generation>`, selected only by its native custody item.
Each record's metadata carries a check under a separate derived key, so a relabelled or re-versioned file is left out rather than shown or repaired.
Adding or replacing a value writes a private temporary file, syncs it, renames it over the old record and syncs the folder, and raises the version.
There is no reveal: the owner opens a value only to deliver it to an approved recipient.
The protected owner serializes replacements and compares both the displayed version and an opaque revision derived from the exact sealed record before writing.
The Settings form and a Forget offer carry that revision, so removing and re-adding the same reference cannot make an old form or offer apply to its replacement.
The revision is derived when metadata is read, without changing existing records' authenticated encoding.
Metadata includes an environment label, which grants no authority.
A record an earlier version sealed with project/computer discovery links keeps them inside its authenticated bytes: it still opens, its revision is unchanged, and the links are never read as metadata or written again.
Replacing such a value writes the record without them.
Removing or replacing a value invalidates prepared uses, including a reference removed and added again under the same displayed version.
Prepared uses compare the sealed-record revision before consumption and after opening each value; an authentic record substituted at the same version cannot change an already reviewed use.
A prepared use keeps each secret's name, environment label, reference and version from the record it read, so a later replacement never renames what its approval shows.
This binds an edit or use to its record; it does not turn the value files into a rollback-proof store.

## Protected rules

The authority record (`<userData>/secrets/authority.json`) holds the rules, the enrolled approval devices and the home they bind to, under a revision number.
Its check is keyed by the root, and its head (revision and digest) lives in custody, so an agent-written, edited or older valid record is refused.
A refused record makes the rules `tampered`, and every use answers unavailable until the captain saves a new revision with fresh authentication.
Saving needs a fresh local confirmation of that exact revision; it writes the next record, moves the head in custody, then renames, so an interruption leaves one record that matches the head.
A rejected native write keeps its pending record and retires the live owner; reopening reconciles a matching head without repeating the write.
An old or absent head beside a pending record remains unavailable while the process that attempted its native write is still running, even after reopening the owner.
A fresh process first reads custody: a matching pending head finishes the save, a readable old head keeps the last committed authority and discards the unconfirmed candidate, and an absent first head discards that candidate and initializes empty authority.
Locked or unreadable custody discards nothing.
Restart recovery never retries the discarded proposal, needs no backup and permits a new freshly authenticated save.
Rules apply to every required secret together: Never precedes Ask, then Allow, and no match asks.
An Allow rule always names one operation key; there is no wildcard Allow.
Rehearsal evaluates a use against the rules and returns its checked facts without journaling, approving or running anything.

## Trusted controller

`SecretsSettings` in `src/core/secrets/settings.ts` is the app's Settings/controller interface, constructed without access when the host supplies no Secrets capability.
The core dispatcher composes its routes from `src/core/secrets/handlers.ts`, retaining request validation and authority checks in the dispatcher before calling the controller.
Home-only channels serve its metadata and captain controls; the native export dialog writes metadata history through the private-file owner.
Settings → Secrets leads with searchable names and optional environments, beside Add secret; each entry opens its reference, saved version, last request, Replace value and Forget locally.
Secure entry asks for a name and masked value, leaves the new reference absent for the controller to create when saving, and keeps the optional environment and custom reference under More details.
The form locates the returned entry through the controller's `saved` receipt; replacements keep their existing reference and exact-record checks.
Activity, Permissions, History and Recovery use the shared keyboard-native grouped controls; program rehearsal sits under the advanced disclosure in Permissions.
The exact-use card leads with each requested secret's name and safe identity, then the checked recipient and operation, with the requester's explanation kept separate.
History offers export, explicit deletion and storage use.
Adding a secret needs no reference: the controller makes a stable one from its name, never one an existing entry, a saved rule or the history names, and answers with it.
A replacement names its reference; one without a reference is refused.
The command-search entry focuses the Secrets heading in every availability state, and the forms and their actions use the ordinary keyboard controls.
Enabled controls carry no disabled-reason label; unavailable actions keep their current explanation.
Secure entry passes a value directly to the protected owner and returns metadata, never the value, its prefix or an encoded substitute.
It raises app-authored cards for exact uses, rule changes, forgetting and history deletion.
Their private offers are spent once through host chrome; a saved card from a previous process is inert, and an agent-written card cannot mint one.
An Allow click still requires fresh system authentication; a failed or unavailable confirmation leaves the request waiting and reopens its card.
Rule forms only propose changes, and native confirmation covers the exact proposed revision.
The command facade exposes the agent-visible entries' metadata, injection, status and cancellation, not this controller or a broker result reader.
It namespaces command intent IDs by task to prevent accidental collisions; the namespace is not an authenticated identity or an access grant.
A requester that received a waiting or executing receipt hears the terminal metadata through its task's existing durable inbox, once, after cleanup and journaling settle.
Terminal requests invalidate their private offers and withdraw any obsolete approval card.
The caller receives its own cancellation directly, while other waiting requesters still hear the result.
Pending approval and notification registrations remain process-local; after a restart, the requester reads the durable receipt before continuing, never repeats an unknown effect and never reuses an old card.

## Brokered uses and bounded reads

Trusted consumer code registers a `SecretBroker` through `SecretsSettings.registerBroker`; a command, saved record or general request cannot register an adapter.
Registration reaches an owner already open or its next lazy open, and a registered identifier cannot be replaced by another adapter.
A broker binds its checked destination, operation, input digest, secret references and result handling before approval, then uses the same custody, protected rules and journal as a process recipient.
`httpSecretBroker` supplies bearer/header and form delivery without adding a token reader or another protocol owner; its consumer retains transport policy and renewal.
It refuses redirects and omits ambient HTTP credentials.
A raw response remains private for that trusted consumer to take once; neither the command facade, the Settings view nor history receives it.
A completed brokered operation reports completion without inventing a process exit code.

Only an adapter-declared supported read without an explicit Ask or Never rule offers the optional bounded permission.
It covers the exact checked operation and sealed-record revisions for 600 seconds or 20 uses, whichever ends first, including the approving read.
Consumption reserves one count synchronously.
After awaited custody and entry checks, the owner rechecks material and authority revisions, End access and expiration synchronously at the broker handoff, with no intervening await.
It never covers a program launch, renewal or write, and disappears on restart, secret replacement, a protected rule change or End access.
End access stops unused authority, not an already-sent request or a copy a recipient kept.

## The recipient

[`../src/core/secrets/recipient.ts`](../src/core/secrets/recipient.ts) binds the program, its interpreter and every argument naming a regular file by digest.
A file this user could change, by writing it or any folder above it, is copied into the use's private folder and runs from there; one it cannot change runs in place and is hashed again right before it starts.
A script's interpreter is started directly with the script's copy, so neither its `#!` line nor the search path is read again at launch.
A `#!` line needs an absolute interpreter and at most one argument; `#!/usr/bin/env NAME` resolves NAME on the search path when the use is prepared, and any other form is refused.
The working directory is bound by its real path.
The recipient's environment is a short list of base variables from the host environment plus the approved values; a mapping onto a base variable is refused.
Its output stays private and is removed with its folder when the use ends; removal is not secure erasure.
Opening private output files and rechecking the bound recipient finish before the owner's final synchronous authorization check, with no await between that check and process spawn.
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
The trusted app card names the exact use; the native dialog uses the installed policy's fixed message because polkit refuses request details from an ordinary app process.
The app does not acquire root privileges or grant itself action-owner authority to supply those details.
The [Linux packages](linux-packages.md#secrets-confirmation) carry the polkit policy, whose active-session default is `auth_self`, with inactive and other sessions refused.
Where that action or a desktop authentication agent is unavailable, a human Allow cannot obtain fresh confirmation; the app offers no fallback.
An AppImage cannot install system policy, and a Nix user-profile install alone does not register an action with the system's polkit.
A confirmation becomes an in-process proof bound to one use's digest and expiry, spent once and never saved, so no approval survives a restart.
A request expires after 300 seconds.
A computer that cannot confirm the person, such as a headless start, refuses local approval and waits; it still serves saved rules and remote decisions.

## Remote decisions

A device approves from elsewhere only with a P-256 key enrolled for this purpose, never its paired-view identity, and each re-enrollment raises its generation.
Each waiting use gets one random nonce, and a decision passes only when the device, at its current generation, signed the home, request, digest, nonce, expiry and decision.
Racing decisions spend the nonce once, and challenges live in memory only.

The signed bytes are `decisionMessage` in `src/core/secrets/approvals.ts`: the format line, one `binding:value` line per entry of `DECISION_BINDINGS` in order, then `decision:allow`, joined by newlines.
The signature is ECDSA P-256 over SHA-256, DER, base64, checked by `verifyDecision`.
The phone builds the same bytes from `PhoneDecision`, which `scripts/generate-phone-contract.ts` writes from those constants, and InfinitaryKit's `Fixtures/secrets.json` holds a real challenge the phone signed, which `approvals.test.ts` checks with the home's verifier.
A refusal is never signed: any paired view that may change things can deny a waiting use.

A paired view reaches this through three channels, each answered in `SecretsSettings`:

- `inf:secrets:approvals` reads one device's enrollment and the uses waiting now, described as their approval cards describe them; a use's challenge goes only to an enrolled device.
  Each requested secret comes with its name, environment label, reference and version as the use prepared them, never its value, so two secrets with the same name stay apart.
- `inf:secrets:enroll` offers a device's key.
  It raises a host card only while Secrets is set up and open and the key is a P-256 key the home does not already hold for that device.
- `inf:secrets:decide` carries one signed Allow or one Deny.

A computer that controls a first mate started by a command asks these three and no other Secrets request (`RUN_HOME_ONLY_CHANNELS`, `docs/run.md`, "Control from another computer").
Secrets settings, entry, rehearsal, history, permissions and recovery stay on the home, and its Secrets tab and command are not offered there.

Enrollment is the captain's on this computer.
The card shows eight digits from SHA-256 of the offered key (`approvalCode`), which the phone computes from its own key and shows in its Settings; the captain compares them, and only Confirm and allow on this computer, with this computer's fresh confirmation, saves the device into the authority file at its next generation.
The phone's own copy of that card says to do it on the computer.
Settings → Secrets → Permissions lists each enrolled device with its code and Stop approvals, which asks for the same confirmation.
A change of devices moves the authority revision, so a use already waiting under the earlier authority is invalidated rather than run.
A restore from a recovery backup keeps no enrolled device ("Recovery boundary"), so each phone sets up approvals again.

On the phone (`ApprovalKey.swift`, `PhoneSecrets.swift`), the key lives in the Secure Enclave with `.privateKeyUsage` and `.userPresence`, on a device with a passcode, and never syncs or leaves it.
A device refuses a software key, whether kept or loaded, and signs with none; without a Secure Enclave it keeps no key rather than falling back to one.
A new key keeps the phone's device name and replaces the kept record in one write, so the earlier key stays when that write fails.
A Keychain the phone cannot read now stops the replacement, rather than counting as no key.
Set up approvals reads the kept key again before it makes a new one, so a key the phone could not read while it was locked keeps its enrollment; only a record the phone refuses, a software key on a device (`PhoneError.unusableApproval`), is replaced.
A record the Keychain gives back whole but the phone cannot decode is damaged (`PhoneError.damagedApproval`), never a read that failed: loading, Set up approvals and a new key all refuse it and write nothing.
Settings then says the phone's approval setup is damaged and offers Set up approvals again, the only choice that replaces it.
It reads the record again, and only while it is still the same damaged bytes does it make the supported key and replace the record in one write.
A failed read, a device that cannot keep a key, a changed record or a failed write leaves those bytes as they were; nothing deletes the record first or falls back to a software key on a device.
The damaged record's device name cannot be read back, so the new key takes a new one, which the computer enrolls only after the ordinary code comparison and its own confirmation.
An enrollment the computer holds under the earlier name stays until the captain stops it in Settings → Secrets; nothing it allowed carries over.
Each Allow evaluates a fresh `LAContext` with no reuse, naming exactly what it gives, before the key signs; a failed confirmation sends nothing.
A use's approval card on the phone shows Allow once and Deny in place of the computer's own choices; a phone that is not enrolled shows only Deny and says where to set up.
Only an executing or completed Allow, or a denied Deny, marks the phone's choice accepted; waiting, refusal and uncertain outcomes retain their explanation instead.
A later successful key read clears an earlier locked-store problem without replacing the key.
Above them it names each requested secret first, one line each: its name, then its environment label, reference and version; the system's confirmation names the same and the recipient.
The line stays short so the choices stay pinned in the card's frame on an iPhone.
The shared approval body shows the same prepared environment beside each name, describes confirmation without assigning it to a particular device, and labels temporary read access as available only on the computer.
Like every card's choices, Allow once and Deny take a press only once the card's body is revealed at its drawn height (`docs/ios.md`, INF-1574).
The simulator has no Secure Enclave, so there the key is a software key behind the simulator's own Face ID.
The phone check's `testSecretsApprovals` enrolls the simulator, allows one brokered read with its Face ID and denies another, against the real controller with disposable custody.
Before it allows, it reads the shared body's prepared environment and computer-only temporary scope, scrolling to that scope while the choices stay pinned.

## History

History is the journal read as metadata: what was asked, which secrets, the bound program, the requester's reason shown as theirs, how it was approved and how it ended.
It never holds a value, an environment or a full request body.
It stays until the captain deletes it, and the owner reports its storage use and exports it; deleting it refuses while a use is running.
It is local evidence, not an immutable audit log.

## Before production

These remain before any production use:

- Live proof of Settings → Secrets with trusted secure entry, Activity, Permissions, History, export and storage use, rehearsal and End access.
- Composing both platforms' native adapters for production and checking the installed Linux policy through polkit itself.
- Fresh human confirmation and the platform's custody shown working in the app on both platforms.
- Explicit production-enablement approval, separate from acceptance of the Linux same-user limit above.
- An Allow from a real iPhone or iPad, whose Secure Enclave key and Face ID, Touch ID or passcode only a device has.
- The recovery key and each consumer migration below.

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
The optional 600-second/20-use permission applies only to supported brokered reads through the protected owner, not unrestricted commands or renewal.
Settings → Secrets exposes searchable metadata, Activity/Permissions/History/Recovery, trusted Add/Replace, rehearsal, End access and export/storage display through the disabled-by-default host seam.
Without that capability, the section shows only its disabled status and the fact that existing sign-ins remain unchanged.
Native recovery must be proved alongside custody before production enablement.
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
| Remembered websites | `src/core/browser/{webSignIns,taskBrowsers,savedSignInGrants}.ts`; `src/core/placed/placedBrowsers.ts`; `src/main/host/taskBrowser.ts` | Origin-scoped session loading, explicit grants, refresh and existing work-device transfer semantics. |
| Desktop identity | `src/core/devices/{identity,ownKey,joinedHome,dial,ssh}.ts` | System-only keys/signing/connection adapters, preserving bootstrap and pairing; no agent discovery. |
| iPhone/iPad identity | `PhoneIdentity.swift`; `JoinLink.swift`; `PinnedTransport.swift` | Device-only native custody; separate fresh-authenticated exact-approval capability, not ordinary paired-view authority. |
| Temporary capabilities | `src/core/axi/channel.ts`; `src/core/devices/pairing.ts`; `src/core/browser/connectionGuard.ts`; OAuth state/proof keys | Explicit ephemeral lifetime and recipient, not generic durable vault entries or protected task identity. |
| One-use passwords | `src/core/devices/sshPassword.ts`; remote login and system installer authentication | No persistence; exact recipient or delegated system authentication, not reusable captured passwords. |
| Shell and remote work | `src/core/hostEnv.ts`; `src/core/jobs/jobManager.ts`; `src/core/claude/claudeSessionOptions.ts`; `src/core/helper/` | Audit inherited credentials, separate recipient environments and reference-only task/session specifications. |
| Development evaluations | `scripts/evals/runner.ts`; `scripts/check-account-models.ts`; `scripts/bench/attempt.ts` | Same service/account adapters and live-check consent, no parallel credential reader or renewer. |
| Build, signing and release | `.github/workflows/`; `scripts/phone-{certificates,release}.ts`; local signing/release scripts | Explicit delegated CI/platform custody and short-lived recipients; no copying signing material or organization credentials into a desktop vault. |

## Recovery boundary

The private archive codec in `src/core/secrets/recoveryArchive.ts` encrypts values, their metadata and historical use metadata with AES-256-GCM under an independent random recovery key.
An archive an earlier version wrote with discovery links still opens; its links are dropped after authentication, and a new archive never carries them.
The file header is authenticated, and both authentication and strict schema validation precede any restore staging.
The archive contains no native root, rules, enrolled devices or live approvals.
Its separate key has no reset, and possession of both files permits reading every archived value.
`ProtectedSecrets.backupRecovery` asks for fresh native confirmation and delivers the archive and key only to a trusted native writer callback, never through a general IPC, agent command, card or return value.
It refuses damaged or unreadable entries instead of silently making an incomplete backup, clears its buffers after the writer returns and reports a thrown write as unknown rather than retrying it.
The private native writer in `src/main/host/secretRecoveryFiles.ts` creates the two chosen files exclusively with private permissions, syncs their contents and directories, and never overwrites an existing archive or key.
A partial save leaves its newly created files in place and reports that the pair is incomplete; two destinations cannot commit atomically.
Native file dialogs choose both destinations or source files without sending their paths or contents through renderer, task or general IPC channels.
The reader accepts only regular files and an exact-length recovery key, refuses final symbolic links, and never prints a parse error containing archived data.
Settings → Secrets → Recovery explains separate key storage, replacement of values, reset permissions, retained history and incomplete or unknown outcomes.
Cancelling file choice or native confirmation grants nothing and changes no stored values.

`src/core/secrets/recoveryHome.ts` provides the private activation boundary for a durably staged generation with a fresh root and empty authority.
Its caller must finish authenticating and syncing every staged file before activation.
The native root write atomically selects that generation and its authority head; reopening before that write sees the previous home, and reopening after it sees the selected home.
A lost write response is reconciled by reading native custody, not by repeating the write.
An unreadable result stays unknown and its staged files must remain.
A thrown native write also stays unknown when readback still sees the old root: an unchanged observation is not a refusal, and the already-sent write may finish later.
A missing or malformed selected generation refuses instead of falling back to legacy files, and a missing root beside any prior protected records refuses initialization.
Older builds that cannot read the native envelope refuse its non-root-sized item rather than creating a new root.
This boundary does not itself authorize restoring or delete previous history.
`ProtectedSecrets.restoreRecovery` authenticates the archive, obtains fresh native confirmation, then pauses its request coordinator before staging.
The pause refuses an executing effect, drains unfinished preparation and confirmation, invalidates unused approvals and blocks new submissions until it is released.
Undelivered broker results also refuse recovery; already delivered values and external effects cannot be recalled.
`recoveryStage.ts` creates a fresh root and empty authority, re-seals the values, and verifies their reads before syncing the value directory, generation directory, recovered parent and base.
Only then does it attempt native activation, once.
A committed or unknown activation retires the old owner, clears its mutable derived keys and invalidates earlier Settings offers; reopening selects only the native-selected home.
Temporary permissions end before staging, while saved permissions change only on activation.
A failed stage never replaces the selected home, and an unused encrypted stage may remain if cleanup fails.

The journal re-keys authenticated local history with its original timestamps and stores imported archive history separately with authenticated source and recovery-time metadata.
Damaged authority does not discard history that the readable root still authenticates; recovery opens that journal independently of the unusable authority.
Imported request identifiers are namespaced, pending imports become invalidated or unknown, and imported records never become receipts or live approvals.
Earlier history files remain across generations, including records that cannot be authenticated after root loss, until explicit history deletion.
Storage use counts those retained files; deletion removes history across generations but never recovery archives or exported copies.
Deletion shares the journal's append writer and refuses while any request is pending or running, so it cannot erase the identity a later outcome still needs.
If deletion fails partway, new journal writes refuse until deletion completes or the owner reopens, rather than extending an uncertain on-disk chain.
Mutable working buffers are cleared, but immutable JavaScript strings remain subject to garbage collection rather than a claimed secure erase.

## Migration and recovery

Coordinate each old writer, journal the migration, verify values/versions and switch all readers atomically before retiring the old value.
Test interruptions around each transition, concurrent refresh, replacement, rollback and old-app encounters.
Stop before cutover when native protection or recipient compatibility is unavailable; do not silently remove the feature or mislabel legacy custody.
Preserve account labels, existing explicit grants and sign-in lifecycle without widening access or unnecessary sign-ins.
Google invocation consent, injection/exfiltration safeguards and deletion obligations remain separate from encrypted custody and from INF-958's readiness work.
Recovery uses a separately held recovery key; restore invalidates transient permissions and re-establishes device trust.
Non-exportable keys use their owner's recovery or re-enrollment.
Ending future use, local forgetting and provider revocation are distinct, and backups may retain old records.

### Packaged Mac proof fixture

`tests/fixtures/native-secrets/entry.ts` is a separate, opt-in packaged entry, never the production entry.
After the ordinary build, `node scripts/prepare-secrets-fixture.mjs <output> <runtime-root> <evidence-folder>` prepares an unsigned Apple silicon package configuration in a new output folder without signing, creating a Keychain, launching or uploading.
The configuration keeps the release's hardened runtime, entitlements, fuses and archive integrity; signing remains a separately consented operation.
The runtime and evidence paths are compiled into the fixture, so a signer on another Mac supplies the destination computer's paths.

The runtime folder is disposable, resolves to its exact path and contains a regular `fixture.json` with `{"purpose":"infinitary-native-secrets-fixture"}`.
Before a separately consented launch, its `home/Library/Keychains/secrets-proof.keychain-db` must be a newly created test store, and the evidence folder must exist.
The launcher sets `HOME` and `CFFIXED_USER_HOME` to that `home`, and `PI_OFFLINE=1`; the fixture refuses any other home or an unpackaged launch.
The unrelated sign-in backend returns absent through the desktop Keychain seam, while Secrets uses the actual Keychain custody and LocalAuthentication.
The fixture's `unlockMain.ts` uses the shared private child lifecycle and unlocks only its compiled-in disposable store after checking the runtime marker, private home and unlinked regular file.
It never searches the default Keychain list, reads a saved sign-in or accepts a store path from a control.
Recovery uses two fixed disposable destinations through the real private-file reader and writer, exercising native custody and recovery but not the file-picker UI.

`node scripts/secrets-fixture-control.mjs <runtime-root> <command>` sends one closed command through an owner-only Unix socket, using a relative socket path for Darwin's path-length limit.
The client exits unsuccessfully on an explicit refusal, a connection without a reply or an unreadable reply, and never prints a partial response as a result.
An answered control is not proof of a completed native action: read its durable outcome before another action, and never repeat an uncertain use or recovery write.
The commands inspect metadata, prepare one invented recipient, navigate the app's Secrets controls, capture its own renderer or request a clean quit.
The fixed `uses`, `rules`, `history` and `recovery` controls select those views through the shown Secrets selector; they accept no selector, path or editable value.
There is no evaluation, text-entry, generic click, desktop capture, password input or authentication command.
The fixture refuses controls and captures while native confirmation or an initiated native action is pending; metadata status remains available.
It also refuses a picture when any frame contains a password entry control, without reading that control's value.
Pictures use Electron's own-page capture, not screen-recording or accessibility permission, and never include system authentication dialogs.
A click receipt means only that the app received the click, not that authentication or an effect completed.
Preparation records its attempt exclusively before starting; a restart or lost reply cannot prepare another use, and uncertain outcomes are reconciled rather than replayed.
Native confirmation remains the person's action; the fixture grants no permission to create a test store, use signing material or touch existing data.

## Isolated desktop journey entry

`tests/e2e/secretsHarness.ts` supplies disposable custody and confirmation through the existing host-capability seam.
It imports `out/main/app.js`, the same built app owner the normal main entry imports, from the ordinary `electron.vite.config.ts` build.
Only fixture capabilities are bundled separately; the harness owns no duplicate main aliases, contract defines, frame pins or font modules.
Leak assertions read every saved file through `savedText`, not only encrypted value files.
