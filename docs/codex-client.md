# The Codex client

How Infinitary finds the Codex CLI the person installed and asks it, through its app-server, to use one of a Codex account's saved resets.
What a saved reset is, where it shows and who may ask for one is `docs/quota.md`, "Saved resets"; the row and its menu are `docs/subscriptions-tab.md`.
Infinitary's Codex crewmates and the first mate on Codex run through Pi, never through this client: the Codex CLI is used for nothing but saved resets.

## Finding the client

Infinitary ships no Codex CLI, as it ships no Claude client (`docs/claude-client.md`): the person installs and updates it.
`checkCodexCli` (`src/core/codex/codexCli.ts`) looks for `codex` on the host search path, then in the installers' usual folders, then through the login shell, and reads its `--version` on every use, since the person may update it between two uses.
A use needs version 0.143.0 or later (`CODEX_SAVED_RESET_FLOOR` in `src/shared/savedResets.ts`): 0.141 added the request that uses a reset, and 0.143 each reset's id and expiry, which pick the one that expires first.
A missing CLI is refused in words that say to install Codex or use the reset on chatgpt.com, and an older one, or one whose version cannot be read, in words that say to update it.
`INFINITARY_CODEX_CLI` overrides the path, and a missing override path is no CLI, never a fallback; `tests/e2e/launch.ts` points every e2e run at a path with nothing there unless the spec names its own stand-in (`tests/e2e/mockCodexClient.ts`), so a developer's real Codex is never started by a test.

## The app-server

Each use starts one app-server process and closes it after (`CodexAppServer` in `src/core/codex/appServer.ts`):

```
codex app-server --listen stdio:// -c cli_auth_credentials_store="file"
```

Its environment is the host's (`hostEnv`), with `CODEX_HOME` set to the account's own Codex home: a `codex` folder inside the account's store folder, made owner-only (`AccountVault.codexHome`).
The file credential store keeps Codex's sign-in in that folder rather than the system's password store, so the account's folder holds it whole and removing the account removes it.
It speaks JSON-RPC as one JSON object per line on standard input and output, without the `jsonrpc` member; Infinitary greets it with `initialize` (client `infinitary`, no experimental capability) and `initialized`.
Nothing it reads or writes is logged, its own log lines are dropped, and no answer Infinitary reads carries a token.
Each request has an answer deadline of one minute; the process ending, or a deadline passing, is an unknown outcome to the code that asked, never a refusal.

## One use

`redeemSavedReset` (`src/core/codex/savedReset.ts`) runs one use per account at a time on a computer: a second use of an account while one runs in its Codex home is refused in words that say to wait, since two would each start Codex in one home, could send two keys and spend two resets, and could renew one sign-in twice at once.
It runs these steps:

1. Check the CLI as above.
2. Start the app-server and read the account (`account/read`, without refreshing its token).
3. When Codex has no ChatGPT sign-in in that home, sign it in (below), or, for a use with no way to show a sign-in - the first mate's, or a card's click while Codex is not signed in - refuse in words that say to choose Use a saved reset on the account's row.
4. Read the allowance (`account/rateLimits/read`) and check that Codex is signed in to the same ChatGPT account as Infinitary's own sign-in: the answer's `accountId`, or the account id in Codex's own sign-in file when the answer leaves it out, against the `chatgpt_account_id` in the account's own token (`chatgptAccountId`).
   When Codex said it was signed in and refuses this read, the sign-in it kept no longer works: Codex is signed out, then signed in again where a sign-in can be shown, or refused in words that say to sign Codex in again on the account's row.
   Either id missing is refused, saying Infinitary could not check the account; a different account signs Codex out (`account/logout`) and is refused, so nothing is used on an account the captain did not choose.
5. With no attempt kept and none held, say none is left without asking.
6. Pick the available reset that expires first (`earliestExpiring`; one without an expiry comes last), and keep the attempt - a new random key and that reset's id - on the account's registry row before sending (`AccountRecord.savedResetAttempt`).
7. Use it (`account/rateLimitResetCredit/consume` with that key and reset id).
   `reset` and `alreadyRedeemed` are used, `nothingToReset` is nothing to reset, and `noCredit` is none left; each clears the kept attempt.
   An error, a lost answer or an outcome Infinitary does not know keeps the attempt and is refused in words that say Codex did not say whether a reset was used, and that trying again asks about the same reset: the next use sends the same key and reset id, so Codex answers for that attempt and never uses a second one.
8. After a reset is used, read the allowance again for how many are left, then close the app-server.

Codex failing before step 7 - stopping, not answering or refusing a read - is refused in words that say nothing was used.
The home says each clear outcome in its feed, naming the account, reads the allowance again at once (`demand`), and takes down that account's crew run-out card once a reset is used (`SavedResets` in `src/core/codex/savedResets.ts`).

## Codex's sign-in

Codex signs in with its own ChatGPT sign-in (`account/login/start` with `type: chatgpt`), which answers a sign-in id and the page to open.
Infinitary opens the page in the browser and shows its link under the account's row, through the same prompts and notices a provider sign-in uses (`AuthInteractionBridge`), and waits up to fifteen minutes for Codex's `account/login/completed`; Cancel on the row cancels it (`account/login/cancel`).
The page returns to Codex's own address on the computer the use runs on (a loopback `redirect_uri`).
When the browser is on another computer, that address does not reach Codex, so the row also asks for the address the browser ended on: Infinitary sends its `code` and `state` to Codex's own address on that computer, as the browser would have (`loopbackRedirect`, `callbackFor`), and a pasted address without them asks again.
How the sign-in ended always comes from Codex itself.
Codex's device-code sign-in is not used.

## Where it runs

A use of this computer's own account runs here; an account on a computer that runs work is used on that computer, with its own Codex CLI and its own Codex home, through the `inf:sign-ins:use-saved-reset` order (`docs/helper.md`, "Its own sign-ins").
The home shows that use under the account's row beside any sign-in there: neither cancels the other, since Codex may be spending the reset, and a second use of the same account while one runs is refused.
A computer without the change, or out of reach, is offered no Use a saved reset on its run-out card, and a press that reaches its row anyway ends under the account's row saying why (`DeviceSignIns.redeemSavedReset`).
The window asks with `inf:accounts:use-saved-reset` (`accounts.redeemSavedReset`), the first mate with the `account-use-reset` catalog line, and a card with the `use-saved-reset` host operation (`docs/quota.md`, "Saved resets").

## Signing out

Removing an account whose Codex home exists first signs Codex out there (`account/logout`, best effort, `signOutCodexHome`), then deletes the account's folder, its Codex home with it (`AccountVault.remove`).
A missing or older CLI leaves the folder to the removal.
