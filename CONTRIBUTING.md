# Contributing

Infinitary Labs, Inc. licenses its own Infinitary source code and documentation under the MIT License (see `LICENSE` and `NOTICE`). Third-party material retains its own terms and notices.
[`infinitary-apps`](https://github.com/infinitary-labs/infinitary-apps) is the home for source, issues, pull requests and releases, not a mirror.
The maintainers have not finalized the contributor agreement. Please open an issue to discuss a change before sending an outside pull request; outside contributions will not be merged until that policy is in place.

## How the code is worked on

`AGENTS.md` is the project's own account of how it is built, tested and released, and it applies to people as much as to agents. The short version:

- Before merge, finish the smallest relevant proof for the current version (`docs/testing.md`).
  The PR's Linux check owns typecheck, lint/adherence and build; opening the PR can start proof and does not require a duplicate complete local gate.
  Portable journeys use Linux CI; every edited unit file runs three total times locally, including portable files; selected native journeys can run locally through the admitted build-to-cleanup route even in CI mode.
  An edited test file runs three total rounds, ordinary coverage plus two more; an affected unedited journey runs once per required platform.
  A phone test whose own code changed runs three rounds on the iPhone and one on the iPad or the iPhone Duo when the part is about that device, all in its one affected phone request through CI, whatever the size of the selection.
  Shared test helpers reach their consumers once rather than repeating them.
  Weakening, skipping or deleting a test still requires the captain's approval.
  Full local journeys remain prohibited, and full pre-merge verification is exceptional, not a response to breadth, confidence or care alone (`docs/testing.md`, "When to request full verification").
  Rolling main supplies broad coverage except the old journey set; a fully passing run automatically cuts its exact commit as an alpha, which runs every journey, unless the swept batch already ran them, and the release-specific gates without repeating main's checks.
  It cuts nothing while an earlier alpha is still being cut or a stable is being promoted, or when nothing the desktop app is built from changed since the previous release (`docs/alpha.md`, "An alpha with nothing new to build").
  Full unit, integration and probe sweeps remain on main, manual runs and release verification, not PRs.
  Passing checks never grants merge permission.
- All UI work follows the design skill under `.claude/skills/infinitary-design/`.
- Commit subjects and pull request titles use `type(scope): summary` or `type: summary`, optionally with `!` and a `BREAKING CHANGE` footer. Types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`; scopes are open-ended. Do not call a fix a feature to force a release.
- A pull request says why it is needed, what changed, what stood before and after, how it was verified, its risks, required actions and unfinished work.
  Infinitary-authored new pull and merge requests share the completion card's saved story (`docs/forge.md`, "Saved change stories"): public GitHub and GitLab carry native attachments, while other description hosts carry text and keep media on the card.
  Plain branches and local-only changes keep the same story on their completion card; existing PRs that predate stories keep the five-heading format.
  Evidence files are never committed; release-note hero pictures remain part of the change.

## Reporting a security issue

Write privately to Infinitary Labs, Inc. at help@getinfinitary.com rather than opening an issue.
