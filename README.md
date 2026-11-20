# Infinitary

**Your own AI studio.** A first mate and crew that work for you, on a computer that is yours. Open source.

Infinitary is a desktop app for Mac and Linux. You talk to one AI assistant, the first mate, by typing or by holding a key and speaking. It plans the work and hands each task to a crewmate: an AI agent that does that one task in its own working copy. It comes back to you with short cards: a decision to make, or a result to see. Many crewmates work at once, each on its own task.

## Made with care

Craftsmanship, not mass production. Every piece of work is made the same way:

- **One task, one crewmate.** Each task gets its own working copy and branch, so work never collides.
- **Checked.** A crewmate runs your project's own tests and checks. A change can get an independent review before it reaches you.
- **Shown.** The result arrives as a card with what changed and the evidence: pictures, recordings, test results.
- **Recorded.** Every task keeps a record of your words, the plan, each report, the pull request and its checks.
- **Yours to decide.** Nothing merges until you say so, unless you turn on autonomy for a project.

## Yours

- **Your computer.** The first mate, your tasks, what it knows and the record of every task live on your computer.
- **Your model provider, on your own account.** Sign in with the Claude, Codex or Grok subscription you already pay for, or connect OpenRouter or another provider with a key.
- **Straight to the provider.** Your work goes from your computer to that provider. Infinitary never sits in between, never charges you for model use and never resells it.
- **Your projects.** Work in a folder on your computer, or on projects that live on GitHub or GitLab.
- **Your knowledge and panels.** Your standing directions, saved knowledge and the panels you build are yours to read and change.
- **Your other computers.** Add your other Macs and Linux computers once. Each can control your first mate or run a project's work with its own sign-ins. They connect over your own private network, with no account and no service of ours in between.
- **Open source.** [infinitary-apps](https://github.com/infinitary-labs/infinitary-apps) is the public home for Infinitary’s source code and releases.

## Beyond code

The same first mate answers research questions on a card. It drives a web page in a task's own browser while you watch. It runs schedules you set, teaches a subject across days, and builds panels for your window.

## What you need

- A Mac with Apple silicon or Intel, or a Linux computer with an x64 chip.
- At least one AI subscription or API key. For Claude, install Claude Code first; Infinitary uses your copy.
- Ideally a computer that stays on. The first mate works while that computer is awake, and your other devices reach it there.

## What leaves your computer

Your work goes to the model provider you chose, and to GitHub or GitLab for a project that lives there. Nothing you write comes to us. An installed build sends anonymous usage events, such as the app opening or first-time setup advancing, with a random install ID. It tells you on first launch, and Settings → General → Sharing turns it off. Whatever that switch says, an installed build's first update check of each day and month also says it is the first, with no ID, so we can count the computers using Infinitary. A build you make from this source sends nothing. `DATA-TERMS.md` is the draft of the terms for anything you choose to share with us.

## License

Infinitary Labs, Inc. licenses its own code and documentation under the [MIT License](LICENSE). [NOTICE](NOTICE) identifies separately licensed components and credits.

## Develop

```
git clone <this repo> infinitary-apps
cd infinitary-apps
pnpm install
pnpm dev
```

A dev run keeps its state in `~/Library/Application Support/infinitary-dev`, apart
from the installed app's `infinitary`, so it never opens the database the release
is using (`src/shared/userDataFolders.ts`). The first dev run moves an older
`firstmate-3000-dev` folder into it once.

That's it - no hidden step to fetch the Electron binary. `pnpm install`'s postinstall
downloads it for you (see `scripts/ensure-electron-installed.mjs` and the note on
Electron's dropped `postinstall` in `docs/architecture.md`).

`pnpm dev` also gives the local app a stable macOS code identity, so a
Keychain "Always Allow" survives relaunches, reinstalls, and Electron upgrades
instead of being re-asked each time. It generates a self-signed certificate on
your machine only - no shared secret, no Apple certificate, nothing committed.
It does not touch that signing keychain when the dev app is already signed, and
an install never does: pnpm also installs on its own, so `pnpm install` only
checks. `pnpm codesign:verify` reports what it did; `docs/local-code-signing.md`
explains it and how to reset it.
