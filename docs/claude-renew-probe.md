# Which supported command renews a Claude session

Infinitary's quota sensor recovers from routine token expiry by asking the account's **own client** to renew - Infinitary never speaks the vendor's OAuth.
That only works if the command it runs actually renews, and *which* command does is a property of the vendor's client, not of Infinitary: it can change between client versions, and the vendor documents none of it.

So the code does not presume.
`renewClaudeQuotaAuth` (`src/core/claude/claudeQuota.ts`) walks a ladder of supported non-interactive commands and stops at the first one that **changes the stored credential**, compared through an in-memory-only marker (a hash that never leaves the module, is never logged and is never persisted).
Whichever command does the work, the sensor is correct; when none of them does, it says `unchanged` rather than claiming a sign-out.

## The ladder

`CLAUDE_RENEW_COMMANDS`, in order:

1. `auth status --json`
2. `doctor`

Both are documented subcommands of the client.
Neither starts a session, sends a prompt, or opens a browser.

## The probe

`src/core/claude/claudeRenewProbe.test.ts` keeps ordinary runs off the installed client entirely.
Its default tests run a recording stand-in through the real `runClaude` spawn interface, checking the child environment, the store it writes, the detection of renewal and the refusal to call a deleted credential renewed.
They need no subscription and never read a real credential.

The installed-client legs are **opt-in on disposable Linux only**, where the client uses a file-backed store.
An explicit request on another platform fails before launching the client: a file assertion cannot prove what happened to a macOS Keychain credential.
An explicit request without an installed client also fails rather than reading as a pass.

**Empty-store leg.**
Run on disposable Linux with an installed client:

```sh
INFINITARY_CLAUDE_RENEW_PROBE=1 pnpm test src/core/claude/claudeRenewProbe.test.ts
```

The probe pins the child's `HOME`, `CLAUDE_CONFIG_DIR`, temporary and XDG directories to scratch locations, disables automatic updates and supplies a no-op browser opener.
`runClaude` deliberately leaves `CLAUDE_CONFIG_DIR` unset in production, so the probe sets it through the per-run environment override; its `configDir` argument alone does not select a client store.
The probe runs every ladder command and checks that it exits rather than waiting for a terminal and does not report an unknown command.
Before and after the ladder, it checks that the client reports signed out and that **the same config root the child used** has no `.credentials.json`.
These checks do not claim that the client writes no other files.

**Account leg.**
Also set `INFINITARY_CLAUDE_RENEW_PROBE_DIR` to the absolute config root of a **throwaway account with an expired session**, stored in that root's `.credentials.json`.
The flag alone runs the empty-store leg; the directory alone enables nothing.
The probe refuses the machine's default config root, including directory aliases, and refuses linked credential files.
It passes the selected root to the child and reads that same file store without a credential cache or a Keychain fallback.
It prints each command and whether the stored credential changed, never a token, marker or store contents, and leaves no report file in shared temporary storage.
A missing or unreadable credential after a command fails the probe rather than counting as renewal.

**Never use or copy the captain's login, even into a throwaway directory.**
A Claude refresh token is single use: spending one belongs to a subscription nobody depends on, and moving its file does not make the token disposable.
The person running this opt-in probe is responsible for supplying that separate account; a path check cannot establish token ownership.
The app separately avoids delegating renewal while a client session for the same account is live (`claudeStoreLease.ts`).

The real-account leg needs a throwaway subscription to establish which rung renews on that client version.
The shipped behaviour does not depend on that answer: it observes the store instead of assuming a command works.
