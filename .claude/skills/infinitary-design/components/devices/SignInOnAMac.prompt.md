Signing in on another computer, or as another user on this computer, from the computer where the first mate lives (captain's picks on FI3-682, 2026-10-03).
Each device that runs work signs in to its own subscriptions and GitHub.
Nothing from this computer's sign-ins is sent there, and a task that runs there uses only that device's sign-ins.

**Settings → Intelligence, grouped.**
With nothing added that runs work, the tab is as it is today.
Once a device runs work, the account rows group under micro labels: `THIS COMPUTER` first, then each computer by name (`MAC MINI`), then `RUNNING AS BUILDER`.
Each added group carries one `--text-sm --fg-2` line: "Its own sign-ins.
A task that runs on Mac mini uses only these."
("as Builder" for a user).
Each group is the same list box and the same account rows (`SubscriptionCard`'s row: dot, "Codex · Personal", the mono allowance "5h · 88% left", its meter, its menu); the allowance is read on that device and shown here.
A Claude row whose allowance that device cannot read without macOS asking says why in its mono state line, "Infinitary can't read this allowance there: macOS asks before it may read your sign-in, and nobody may be at that screen to answer.", with no Retry: nothing on that device ever asks on a screen nobody may be at.
A row's state line that says this computer names that device instead, wherever the tab is open: a Claude row with no login yet reads "Sign in with Claude on Mac mini."
An empty group holds one `--fg-3` line, "No sign-ins yet."
Each group's foot is the `ConnectChips` foot, `ADD ACCOUNT`, whose chips start the sign-in on that device, and ends with a Custom API chip while that device is in reach.
The chip opens the same Custom API form, titled "Add a custom API on Mac mini", and every "this computer" in the form names that device; a localhost address reads "On Mac mini".
A saved connection is a block in the group, with each model's status, Edit and Disconnect, and no choice for the first mate.
While that device runs an older Infinitary, the chip stays disabled with "update Infinitary there first".
"Sign in again" is per device.

**The sign-in, in the aside** (captain's pick: in Settings, beside this computer's sign-ins).
The flow runs on that device and is drawn here, in the aside under its group, in the shapes `ConnectChips` already uses, headed "Sign in to Codex on Mac mini" ("as Builder" for a user):
- a code to read, for Grok and GitHub: "Open the link in your browser here and enter this code.
  Mac mini finishes the sign-in itself.", the code in a mono `--bg-3` chip with wide tracking, a primary "Open the link", and the mono line "waiting for you to finish in the browser".
- the address the browser ends on, for a browser sign-in whose link sends the browser back to the computer it opens on (Codex, OpenRouter): that page waits on Mac mini, not here, so it cannot be reached, and its address carries what the sign-in needs.
  "Open the link in your browser here and sign in.
  Your browser then ends on a page that cannot be reached.
  Copy that page's address and paste it here.", a secondary "Open the link", a mono password `Input` "paste the address", and a primary "Send to Mac mini", disabled while the box is empty.
  Running as Builder, that page is on this computer, so the sign-in usually finishes by itself: "Open the link in your browser here and sign in.
  Builder finishes the sign-in itself when your browser comes back.
  If the page your browser ends on cannot be reached, copy its address and paste it here."
- a code to paste back, for Claude, whose page shows one: "Open the link in your browser here and sign in.
  Then paste the code it shows.", a secondary "Open the link", a mono password `Input` "paste the code", and a primary "Send to Mac mini", disabled while the box is empty.
- a key, for OpenRouter: "Paste an OpenRouter API key for Mac mini.", a mono password `Input` "paste your key", and "Send to Mac mini".

Under a box that takes typing, the mono `--text-xs --fg-3` line "It goes to Mac mini once.
This computer keeps no copy."
What the person types goes to that device once and is kept nowhere on this computer: not in Settings, a card, a thread, a feed line or a conversation.
When it is done the row joins the group, and the feed says "Mac mini is signed in to Codex."
Claude Code must already be on that computer; when it is not, the chip carries the provider's own note, "install Claude Code there first".
Claude signs in from here as a code to paste back: its link opens in the browser here, and the code its page shows goes to Mac mini once.
A Claude login already on that computer is used as it is, and nothing is asked.

**Disconnect**, in a row's menu, signs that device out, and the feed says "Mac mini is signed out of Codex."
For Claude the line says what became of that computer's own Claude login (captain's pick on FI3-887: signed out when Infinitary made it from your code, never one that was there before):
- "Infinitary signed Mac mini out of the Claude login it made." when Infinitary made it from the pasted code;
- "Infinitary stopped using Mac mini's Claude login.
  It stays, since Infinitary did not make it." when it was there before, or another took its place;
- the warning "Infinitary stopped using Mac mini's Claude login, but could not sign it out." when Infinitary made it and could not.

Removing the device signs out that login the same way, and Terminal there says which.

**From a card.**
"sign in to codex on the mini" yields one decision from the first mate, "Sign in to Codex on Mac mini": "Mac mini signs in to Codex with a sign-in of its own.
Nothing from this computer's sign-in goes there." and "Sign in opens Settings, where it starts under Mac mini.", with a ghost "Not now" and a primary "Sign in".
The click is the captain's own on the card's chrome: it opens Intelligence with that sign-in started, the way today's sign-in actions open Settings.
The first mate never sees a code or a key, and no card holds a box to type one into.

**When a sign-in there lapses.**
A task that runs on Mac mini meets a lost sign-in, a refusal or a spent allowance on Mac mini's own sign-in, and that is Mac mini's fact alone: this computer's own sign-ins keep serving its first mate and crew, and their rows here change nothing.
A lost sign-in raises the usual crewmate sign-in card, "A provider needs sign in", which says where: "The crewmate on Mac mini could not reach Claude, which needs you to sign in again on Mac mini."
("as Builder" for a user).
Its "Open settings" lands on Intelligence, where Mac mini's group signs in again.
The task waits as a task on this computer's own lapsed sign-in waits (captain's pick on FI3-1001): Infinitary skips that sign-in for Mac mini's next task, holds the task without trying it again, and goes on by itself once Mac mini is signed in again or its allowance resets, when the card comes down.
Only the task that met it raises the card; another task for Mac mini waits for that sign-in with no card of its own, and the feed says "website's next task waits for Mac mini's own Claude sign-in." when the sign-in is lost or refused, or "website's next task waits for Mac mini's Claude plan's allowance, which resets 1:10pm." when the allowance is spent.
A reply under a held task's card is kept, and its waiting line names where: "Saved, not sent yet: Claude needs you to sign in again on Mac mini.
Sign in from Settings, under Intelligence, and it goes to crewmate 3."

**GitHub on another device.**
Settings → Integrations lists a row per device that runs work under this computer's own connections, in the same list box and on the same row grid (`components/integrations/IntegrationRow.prompt.md`): "GitHub · <account>" with the mono line "Mac mini · clones and pushes its own work", and a `RowMenu` whose one item is "Sign out" (danger), which signs that device out.
A device not signed in reads its name over "not signed in to GitHub", with a secondary "Sign in" whose code to read opens in the aside under it.
Settings → Projects holds no sign-in, this computer's or a device's (the captain: it "should be only in integrations tab").
Where that device has GitHub CLI installed, the aside closes as GitHub's own does on this computer (`components/integrations/IntegrationRow.prompt.md`): below a `--line-1` hairline, one `--text-sm --fg-3` line, "If your organization blocks apps like Infinitary, use the GitHub sign-in that GitHub CLI already holds on Mac mini.", and a small "Use GitHub CLI" that asks that device's own GitHub CLI; its row then reads "Mac mini · through GitHub CLI · clones and pushes its own work".
This computer's own GitHub connection above it is the one pull requests are still opened, checked and merged with.
Under a device's rows, a `fm-forges-add` strip holds a `HostChip` per kind of server that device signs in to, "+ GitHub Enterprise on Mac mini" and "+ GitLab on Mac mini".
A chip opens the same key form, or GitLab's browser setup, as this computer's own (`components/integrations/IntegrationRow.prompt.md`), its words naming that device ("It stays on Mac mini."); the signed-in host then joins the device's rows as "github.example.com · mona" over "Mac mini · clones and pushes its own work".
When a project is set to run on a device with no GitHub sign-in, the app raises its own card (chip "Attention"), "Sign in to GitHub on Mac mini": "website runs on Mac mini now.
Mac mini needs its own GitHub sign-in to clone it and push." and "Its next task waits for it.
This computer's GitHub sign-in is not sent there.", with one primary "Sign in to GitHub on Mac mini" that opens Integrations with that sign-in started.
The feed says "website's next task waits for Mac mini's own GitHub sign-in."
The same card is raised when a task is about to start there, and when that device's clone is refused for want of the sign-in; while the device's setup card is up (`FinishSetup.prompt.md`), its own GitHub row asks instead and no second card goes up.
The card comes down, and the task starts, the moment the device reports its GitHub sign-in.
Never the words credential, token, secret or keychain for what the person types (`copy/Vocabulary.prompt.md`).
