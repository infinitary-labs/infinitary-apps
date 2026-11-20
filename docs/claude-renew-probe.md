# Claude’s idle refresh request

Claude sessions renew the sign-in they run under.
Infinitary’s health tick reads the shared modification-date cache without running a status request or proactive renewal.
After Anthropic rejects an allowance request, `ClaudeAuthBackend.renew` asks the client once through `auth status --json`, only when no Claude session is live and the store slot is free.
There is no command ladder, fallback to `doctor`, or wait for a busy store.
The command’s timeout still bounds the process itself.

The backend reads the store before and after that request, bypassing its value cache so a rewrite within the modification date’s resolution is visible.
A changed access credential is an observed renewal; the allowance fetcher then retries once with it.
An unchanged credential, an unreadable store, a failed client and a busy store stay distinct non-terminal outcomes, never fabricated recovery or sign-out.
The app never speaks Anthropic OAuth or spends a refresh token itself.
Login, logout and catalog reads retain the same single store slot, and a live client retains its session count until it exits (`docs/claude-client.md`).

## The probe

`src/core/claude/claudeRenewProbe.test.ts` keeps ordinary runs off the installed client entirely.
Its default tests run a recording stand-in through the real `runClaude` spawn interface, checking the child environment, the selected store, observed renewal and refusal to call a deleted credential renewed.
They need no subscription and never read a real credential.
The production command is owned by `CLAUDE_AUTH_STATUS_ARGS` in `claudeCli.ts`, and the probe exercises that same command.

The installed-client legs are opt-in on disposable Linux only, where the client uses a file-backed store.
An explicit request on another platform fails before launching the client: a file assertion cannot prove what happened to a macOS Keychain credential.
An explicit request without an installed client also fails rather than reading as a pass.

Run the empty-store leg on disposable Linux with an installed client:

```sh
INFINITARY_CLAUDE_RENEW_PROBE=1 pnpm test src/core/claude/claudeRenewProbe.test.ts
```

The probe pins the child’s `HOME`, `CLAUDE_CONFIG_DIR`, temporary and XDG directories to scratch locations, disables automatic updates and supplies a no-op browser opener.
Production leaves `CLAUDE_CONFIG_DIR` unset, so the probe overrides it explicitly and reads the same selected file store without a Keychain fallback.
It checks that the status request exits, recognizes the command and leaves an empty store signed out.
These checks do not claim that the client writes no other files.

For the account leg, also set `INFINITARY_CLAUDE_RENEW_PROBE_DIR` to a throwaway account’s absolute config root with an expired session in `.credentials.json`.
The directory alone enables nothing.
The probe refuses the machine’s default config root, directory aliases and linked credential files.
It reports the command and whether the credential changed, never a token, marker or store contents.
A missing or unreadable credential after the request fails rather than counting as renewal.

Never use or copy the captain’s login, even into a throwaway directory.
A refresh token is single use, so this leg needs a separate disposable subscription nobody depends on and its own consent.
A path check cannot establish ownership.
An ordinary stand-in run proves isolation and scheduling, not that an installed client version will refresh a real account.
