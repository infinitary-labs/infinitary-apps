# The Subscriptions tab

The Instruments direction of Settings → Intelligence → Subscriptions and the honesty rules its rows keep.

## Action failures

Settings requests whose rejections are shown directly (allowance refresh, its model-list reload, account connection/sign-in and task-data purge) use the same preload presentation boundary as card actions/replies: `src/preload/readableRequest.ts`.
It removes Electron's matching remote-method wrapper and error-class prefix, preserves a useful reason, and names the failed Settings operation.
Empty, malformed transport and response-validation failures use an operation-specific retry message instead of diagnostic text.
Successful responses and IPC schemas are unchanged; the renderer does not parse transport messages.
Refresh and purge retain their in-flight guards, and a refused purge resets the confirmation so retry requires confirming again.

`src/preload/readableRequest.test.ts` owns exact error composition and fallbacks.
`tests/e2e/card-action-feedback.spec.ts` exercises real rejected Electron calls for refresh, its model-list reload, purge, account connection and sign-in, including clean fallbacks and retry controls.
Card wording and behavior remain unchanged.

Routing (including pins), notifications, presence, model-slot membership/reset and decision-model/key writes also use that boundary.
Each saved view has one ordered writer (`settings/settingSave.ts`): controls show the confirmed value until receipt, and a refusal re-reads the saved view, including partial writes.
If recovery cannot read it, the feedback says so rather than claiming the previous value is still saved.
Older polls cannot overwrite a save or its recovery; feedback remains until the next attempt and is brought into view without moving focus.
General switches and the model board are disabled during their writes.
A refused decision-key save stops the dependent model-selection write, and the write-only key draft still clears at submission.

The look (size, theme, wash, crew model names and the usage unit), Your panels, the first mate model, the sharing switches and the one-time ask, and account edits (prefer, rename, pause or resume, disconnect) use that boundary and a writer of their own too.
A value the core pushes is saved state as well (`SettingSave.apply`), and like a poll it never replaces a save or its recovery.
The look's writer lives in the shell store, because the usage-unit command writes it from anywhere.
Its controls show a choice at once, each write sends the whole saved look with only that choice changed, and the window takes the saved look again once every write is answered; a refusal is told beside the control that made it, the usage unit's in Usage.
Opening Appearance or Usage reads the saved look again, so the advice to reopen Settings after a failed recovery holds there too.
An account's refused edit is told under its row while the list shows what is saved; when that row is gone, as after a disconnect that went through before failing, it is told under the list.

`settings/settingSave.test.ts` covers receipt, partial-write recovery, failed recovery, ordering, stale polls and pushes; `app/store.test.ts` covers the look's writer.
`tests/e2e/settings-save-recovery.spec.ts` drives the controls through rejected Electron requests, retries real writes and checks their saved state after reopening Settings, the General and model board ones in both themes.
The login-item interface is boxed because login items are shared OS state; all other data is disposable.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The Subscriptions tab is the Instruments direction (captain's pick from the three-way prototype review, 2026-09-05; spec and evidence in the mini's `fm3000-subscriptions-ux-proto-s1/report.md`, handoff section): ONE flat list of accounts in catalog order then age - status dot, provider, label + plan/identity, every window as a `QuotaMicroMeter` with the row's one verdict, actions behind a `RowMenu` kebab - providers with no account are chips in the "Add account" foot, and Models is a disclosure expanded by default.
  The row's state is one function (`rowView` in `src/renderer/src/settings/SubscriptionsTab.tsx`) and its honesty rules must not regress: the verdict comes from `providerScopes().allModels` where a combined bound exists, a stale row dims its raw numbers and says `as of 3h ago` where the verdict goes, only `auth_required` (and an empty store) says "sign in again" and keeps the ONE inline action - `accounts.signIn` re-runs the provider's login into the account's EXISTING store (`AccountVault.signIn`), never a new account - `not_measured` renders the sensor's `detail` verbatim, an unread window is "–", and the internal account id never renders.
  The three components are design-skill rules first (`components/core/StatusDot`, `RowMenu`, `components/quota/QuotaMicroMeter`); layout that inline styles cannot express (row grid, hover, the 640px container query, reduced motion via the shared zeroed duration tokens in `design/tokens/effects.css`) is `settings/subscriptions.css`.
  `tests/e2e/subscriptions-instruments.spec.ts` runs the review's eleven-account every-state dataset; how the rows fit is judged by eye and by pictures (`docs/testing.md`, "The e2e assertion contract").
  A `RowMenu` swallows its own Escape so the shell's Escape-closes-Settings listener does not fire.

## Allowance forecasts

The row's verdict reads only the shared `providerScopes` projection, never a single window's exhaustion timestamp.
An account-wide scope stays authoritative even when its headroom or runway is unknown; a readable window cannot bypass an unread bounding window.
When only narrower scopes exist, the row uses the lowest-headroom scope, giving unknown headroom precedence, and never adds the all-models check mark.
Each scope includes all its own bounds, excludes extra usage, and warns of projected exhaustion only before the limiting window's reset.
An unknown runway has no verdict, while an already empty scope still reports empty now.
`SubscriptionsTab.test.ts` owns verdict wording and boundaries; `tests/e2e/subscriptions-instruments.spec.ts` checks that the tab renders the scope projection from an isolated allowance snapshot.

## The first mate's account and crew work's preferred account

Two account choices sit on this tab, and each names whose work it steers.
An account row's menu holds "Prefer for crew work", the provider's account pin (`AccountVault.setPin`) that account selection for crewmates and decisions reads; its row carries a ✱ that says "Crew work prefers this account" on rest and in its accessible name, a Tab stop hooked as `data-crew-preferred` (`docs/keyboard.md`, "Facts shown on rest").
The first mate's own account is the persisted `firstmate-account` setting (`docs/architecture.md` §16, "The flagship"); the row it names carries the `firstmate` tag.
The first mate model row carries a second dropdown, first mate account (`FirstmateAccountSelect`), beside the model's, when two or more accounts here of the provider of the first mate's model can answer (the captain, FI3-215); the row is then titled "First mate model and account" and its description names the provider (`firstmateSeatDescription`).
With fewer there is no choice, the row is the model's alone, and the tag alone shows the first mate's account.
The picker lists that provider's accounts by label in the list's order, and an account its row shows as paused, needing a sign-in or not ready stays listed with that word and cannot be picked (`firstmateAccountChoices`).
A pick goes through the `firstmate-account` catalog line, so it leaves one feed line naming the account, moves the first mate at once when it is idle and otherwise at its next idle moment, and pushes `inf:models:changed` so an open tab shows it whoever made it.
The setter refuses an ineligible account with the seat's own reason, and an account of another provider in words that point at the first mate model; the picker shows a refusal through the readable request boundary.
From the keyboard, Tab from the model's dropdown reaches the account's, which draws the focus ring, and typing an account's first letter picks it (`docs/keyboard.md`, "A new feature").
It is a setting chosen now and then rather than an action a person repeats, so it adds no command, as First mate model adds none.
`SubscriptionsTab.test.ts` and `intelligenceBoard.test.tsx` own the choices and the picker's words; `tests/e2e/subscriptions-instruments.spec.ts` owns the journey, driven by keys, and `tests/e2e/phase5-quota.spec.ts` the crew pin's.

## A computer's own sign-ins

Once a computer that runs work is on the list (`docs/helper.md`, "Its own sign-ins"), this Mac's accounts sit under the micro label `THIS COMPUTER`, and each computer gets a group of its own below them, as the design skill's `components/devices/SignInOnAMac` draws it (`settings/DeviceSignIns.tsx`).
A group is labeled by the computer's own name, or `Running as Builder` for another macOS user on this Mac, says "Its own sign-ins.
A task that runs on Mac mini uses only these.", and holds the same account rows, with the allowance that computer read, or "No sign-ins yet."
Its "Add account" foot starts the sign-in on that computer, and ends with a Custom API chip while that computer is in reach.
The chip opens the same Custom API form, titled for that computer, and every "this computer" in the form names it; a localhost address reads "On Mac mini".
That computer reads the address, fetches the model list, checks each model and saves.
The key and headers go there once, and this Mac keeps no copy.
A saved connection shows in the group with each model's status, Edit and Disconnect, and never offers the first mate's own model.
Its checked models join the one Models board tagged with the computer, start not in use, and only a task on that computer routes to a placed one.
While that computer runs an older Infinitary, the chip stays and reads "update Infinitary there first".
Its Claude chip says "install Claude Code there first" when Claude Code is not there.
The sign-in runs there and is drawn in the aside under the group, headed "Sign in to Codex on Mac mini": a code to read with Open the link, a code to paste back, the address the browser ends on, or a key, with "It goes to Mac mini once.
This computer keeps no copy." under a box that takes typing.
Claude adopts the login already on that computer; with none, the aside is a code to paste back: Claude Code's sign-in link opens here, and the code its page shows goes there once.
A browser sign-in whose link sends the browser back to the Mac it opens on (Codex, OpenRouter) asks for the address of the page the browser ends on, which cannot be reached from another Mac; running as another user on this Mac, it says that user finishes the sign-in itself when the browser comes back.
A computer older than `FORGE_SIGN_INS_SINCE` still ends a Claude sign-in with no login there as "Claude Code signs in on Mac mini itself", and the aside says to log in there once.
A Claude row shows the allowance that computer read with its own login, or, when macOS there would have to ask first, why it is not read there, with no Retry: that computer never asks on a screen nobody may be at (`docs/helper.md`, "Claude's allowance, never asking").
A row's menu holds Disconnect, which signs that computer out, and the feed says so; Sign in again runs on that computer too.
For Claude, Disconnect signs that computer's own Claude login out only when Infinitary made it there from the pasted code, leaves a login that was there before, and the feed line says which (`docs/helper.md`, "Its own sign-ins").
The first mate's card for a sign-in on a computer opens this tab with that sign-in started (`pendingDeviceSignIn`).
`settings/DeviceSignIns.test.tsx` owns the aside's words and the Claude row's, and `tests/e2e/device-sign-ins.spec.ts` the journey.

## Custom API connections

The separate Custom API chip opens the same bounded aside as first setup.
Connection rows expose checked models (typed, or chosen from the server's own list with its limits), explicit first mate/crew use and existing Pause/Resume/confirmed Disconnect actions.
HTTP connections show an Unencrypted tag.
The existing setup offers organization and public HTTP/HTTPS, requires separate HTTP risk approval (stronger for public addresses), and allows organization no-key servers.
Destination-review refusals use the readable request boundary.
Keys remain owner-only; edits reuse private drafts rather than returning saved credentials.
Public CA identities may be reviewed without returning PEM.
These accounts do not appear as built-in provider rows.
See `custom-api.md`.
