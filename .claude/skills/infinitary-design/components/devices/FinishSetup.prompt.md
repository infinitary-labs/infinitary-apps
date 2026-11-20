Finishing a computer's setup, from the computer where the first mate lives (captain's picks on FI3-1350, 2026-10-08).
A computer that runs work does nothing until it has sign-ins of its own and a project set to run on it, and the join alone said so only once in the feed.
So the moment one joins, the app raises one card of its own, from facts it holds - never from the first mate's judgment - and keeps it in step until the computer is set up.
Signing in on it is `SignInOnAMac.prompt.md`; giving it a project `RunsOn.prompt.md`.

**The card** (chip "Attention", the app's own, like its GitHub sign-in card).
Title "Finish setting up Mac mini", or "Finish setting up Running as Builder" for another user on this computer; its mono meta line is the computer's label.
It opens with what the join found: "Mac mini joined with git and Claude Code.
It runs work once it has:" ("Running as Builder is set up with git and Claude Code." for a user; "with git, and no Claude Code yet." when the join did not find Claude Code).
Then one row per need, each a bold need over its state:
- "A subscription of its own" · "Sign in under Mac mini in Settings → Intelligence." open, or `signed in to Codex and Grok` done, as a `mark`;
- "Its own GitHub sign-in, to clone and push" · "Needed for a project that lives on GitHub.
  Sign in under Mac mini in Settings → Integrations." open, or `signed in as octo` done;
- "A project that runs there", last and worded as optional: "Optional: Mac mini runs nothing until a project's Runs on names it, and that is fine." open, or `runs website and api` done.

Under the rows the muted line "Nothing from this computer's sign-ins goes there."
Once work connects and reports, the footer holds a button for each open row with a usable Settings destination, the first as the primary: "Add a subscription" opens Settings → Intelligence at the computer's group; "Sign in to GitHub on Mac mini" ("as Builder") opens Settings → Integrations with that computer's GitHub sign-in started, its code to read under its row; "Choose a project" opens Settings → Projects, where Runs on is.
A ghost "Not now" closes it.
Every button closes the card, as every card's does; the app raises it again, under the same card, as a need is met.

**How it moves.**
While work is not connected or has not reported its sign-ins, the card says what is missing instead of offering sign-in links.
An open card changes when work disconnects or reconnects.
An answered card stays closed across connection changes and returns only when a setup need or its offered action changes.
While work is unavailable, the card shows the Devices reason or “It is not connected for work yet.” and only Not now.
While waiting for a first report, it says “Its work is connected.
It has not reported its sign-ins yet.”
If the read did not answer, the card says that the computer did not say what it is signed in to and may need this computer's version.
Once reported, a computer with no subscription option shown here gets “Add a sign-in on Mac mini.” instead of a link to Intelligence.
Without a GitHub option, the row says “Needed for a project that lives on GitHub.
Mac mini does not offer GitHub sign-in here.”
A subscription row is done once the computer reports any account, whatever its allowance read: a Claude login whose allowance that computer cannot read without macOS asking still counts (captain's pick).
The GitHub row is done once the computer reports a sign-in for GitHub, whatever its health; the project row once a project's Runs on names it.
The card revises only when a row moves - never on a reading that says the same again - so a row the person is already on does not come back.
Once every row is done it comes down by itself, and the feed says once "Mac mini is set up.
It runs website with its own sign-ins."
Not now takes it down for good: nothing raises it again for that computer, even after a restart, until it is removed and added again.
A computer taken off the list takes its card with it.
A computer that joined before this card existed gets none; the backstop below speaks for one set up later, or signed out again.

**The backstop.**
A task about to start on a computer with no sign-in at all waits, and the feed says "Mac mini has no sign-ins yet. website's next task waits until it has one."
(`RunsOn.prompt.md`); it starts by itself the moment that computer reports a sign-in, with "website's next task started on Mac mini."
A project that lives on GitHub set to run on a computer with no GitHub sign-in of its own raises "Sign in to GitHub on Mac mini" (`SignInOnAMac.prompt.md`, "GitHub on another device"), unless this card is up and already asks in its own row; a clone that computer's GitHub refuses holds the task the same way, and it starts by itself once the computer signs in.
Never the words credential, token, secret or keychain, and never device, helper or runner for the computer (`copy/Vocabulary.prompt.md`).
