The provider chip row and its sign-in aside: how an account joins, wherever the row sits - the first-launch gate on the stage, or the Intelligence tab's "Add account" foot.
```jsx
<ConnectChips providers={PROVIDERS} accounts={[]} variant="stage" onConnect={connect}/>
<ConnectChips providers={PROVIDERS} accounts={ACCOUNTS} busyProviderId="openai-codex" variant="foot" onConnect={connect}/>
```
One wrapping row in catalog order: the providers whose accounts can serve the first mate itself - today every one of them (Codex, Grok, Claude, Kimi Code, Copilot with a mono `connects through Pi` note, then OpenRouter with a mono `browser sign-in or API key` note; Claude serves the first mate since 2026-09-26).
A provider whose accounts could only run crew would follow a hairline apart, under the micro label `CREW ONLY` at `--fg-3`; the grouping is the guidance, it is derived from the catalog's roles, and the current catalog has no such provider, so the row is one group.
On the `stage` only, a second group follows the provider row a hairline apart under the micro label `YOUR FIRST MATE IS ON ANOTHER COMPUTER`: one chip, "+ Paste its link", which opens the aside that joins the first mate on another computer (`components/devices/JoinAnotherMac.prompt.md`).
It is not a provider and never appears on the `foot`.
Every chip stays a live button.
A chip is a `--radius-pill` hairline button, `--text-xs` on the foot and `--text-sm` on `--bg-1` on the stage, with a 12px plus glyph; hover lifts to `--bg-3`; a chip in flight reads "Connecting..." and disables; a Claude or Antigravity chip is off once the computer's login is connected ("Claude uses the login on this computer"), since each program keeps one login for the computer.
A chip that cannot be pressed for a reason (nothing on this computer runs it, or that login) stays a Tab stop, marked off rather than disabled at half opacity, and its reason shows on rest, the pointer's or the keyboard's focus, and is its description (readme, "Facts shown on rest").
On the `stage` a connected account (one that cannot answer yet, or the gate would be down) shows in its chip's place as a `StatusDot`-toned dot, the provider in `--fg-1` weight 500 and the account label, because nothing else on the stage lists it - and when that account cannot answer yet, the dot is the hollow `ring` tone and a mono note follows the label, its sentence on rest (the account is a Tab stop, and the sentence is its description), so the stage says why the gate is still up: the provider's own note when nothing can run it on this computer (Claude with no Claude Code: "install Claude Code first"), else "not signed in" for a login that is not signed in yet; on the `foot` the accounts are rows above and a connected provider's chip offers another account.
Sign-in is the provider's own flow and the aside renders it under whatever started it.
A provider that signs in either way asks first, in the same aside and the same shape as a select - "How do you want to connect OpenRouter?" with two small secondary Buttons, "Sign in with your browser" and "API key", plus a ghost Cancel - and a provider with one way in goes at once.
A provider whose terms need saying first (Antigravity on a Google AI plan) shows them in the same aside before anything starts: its title in `--fg-1` weight 500, its sentences as `--text-sm` `--fg-2` lines, its links (Google's terms, Google's forum reply) as small text links that open in the browser, then a primary small Button that starts the sign-in ("Sign in with Google") beside a ghost "Not now" that closes the aside; nothing runs until the primary is pressed.
Then the flow itself: Pi's select as a row of small secondary Buttons plus a ghost Cancel; a browser bounce or device code as one `--text-sm` line, the code in a mono `--bg-3` chip with wide tracking; a key as a mono password Input with a primary Submit.
On the stage the aside is framed (`--line-1`, `--radius-m`, `--bg-1`, 560px); inside the tab's list box it sits flush.
Never the word "harness".

Custom API is a separate plus chip after the catalog providers, never a renamed built-in provider.
On a computer that runs work the same chip ends the Add account row while that computer is in reach, and stays disabled with "update Infinitary there first" until that computer speaks the orders.
Both entry points open the same connection form, arranged from password Input, labeled select, small Buttons and fieldsets.
Because its explicit destination, model limits and independent approvals do not fit the first-setup caption band, use a focus-contained, Escape-closeable window aside: 560px maximum width, `--bg-1`, `--line-1`, `--radius-m`, `--space-4` padding, scrolling within the viewport rather than through the composer.
The surrounding window uses `--bg-0` at 80% and `--blur-overlay`; restore focus to the launching chip on close.
Connection facts and fingerprint text use the mono face and wrap, never truncate the approved full destination.
A key stays masked and clears on preparation/cancel.
Separate checkbox labels approve the destination, local HTTP, public CA fingerprints, and optional server-retention defaults.
Saving paused makes no requests; a billable synthetic check and explicit first mate or model-board placement are distinct actions.
Models may be left empty: after the approved Continue the server's own list reads under "Models on this server", one row each with the mono ID, its limits in words ("Limits unknown" when none are listed) and a small ghost Add that reads "Added" once chosen.
The account row uses the existing rename, Pause/Resume and Disconnect actions.
Disconnect asks once with its work-stopping and local-only consequences.
Checked is not selected; unknown allowance, usage and price are not zero.
