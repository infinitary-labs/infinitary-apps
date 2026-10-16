# Infinitary

Local-only Electron desktop product. This is not the Firstmate orchestration repo.

Users bring their own LLM subscriptions. There is no hosted product or SaaS from this repository.

## Getting started

```
git clone <this repo>
cd infinitary
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
