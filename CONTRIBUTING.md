# Contributing

Infinitary is licensed under the Apache License, Version 2.0 (see `LICENSE`). By contributing, you agree that your contribution is licensed under those same terms, as section 5 of the license and GitHub's Terms of Service (section D.6) already provide. There is no contributor license agreement to sign and no sign-off line to add to your commits.

## While the repository is private

Pull requests from outside are not merged yet: the repository opens with the public beta, and the first outside contribution lands after the company that will publish Infinitary is the Licensor. Until then, feedback is a conversation - an issue here if you have access, or the channel you were invited through.

## How the code is worked on

`AGENTS.md` is the project's own account of how it is built, tested and released, and it applies to people as much as to agents. The short version:

- Before merge, finish the smallest relevant proof for the current version (`docs/testing.md`).
  The PR's Linux check owns typecheck, lint/adherence and build; opening the PR can start proof and does not require a duplicate complete local gate.
  Portable journeys use Linux CI; every edited unit file runs three total times locally, including portable files; selected native journeys can run locally through the admitted build-to-cleanup route even in CI mode.
  An edited test file runs three total rounds, ordinary coverage plus two more; an affected unedited journey runs once per required platform.
  Phone parts retain three rounds per device when directly edited, with complete selections through CI and proper subsets retaining local repeats.
  Weakening, skipping or deleting a test still requires the captain's approval.
  Full local journeys remain prohibited, and full pre-merge verification is exceptional, not a response to breadth, confidence or care alone (`docs/testing.md`, "When to request full verification").
  Rolling main supplies broad coverage; a fully passing run automatically cuts its exact commit as an alpha without repeating the broad check, retaining release-specific gates.
  It cuts nothing while an earlier alpha is still being cut, or when nothing the desktop app is built from changed since the previous release (`docs/alpha.md`, "An alpha with nothing new to build").
  Full unit, integration and probe sweeps remain on main, manual runs and release verification, not PRs.
  Passing checks never grants merge permission.
- All UI work follows the design skill under `.claude/skills/infinitary-design/`.
- Commit subjects and pull request titles use `type(scope): summary` or `type: summary`, optionally with `!` and a `BREAKING CHANGE` footer. Types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`; scopes are open-ended. Do not call a fix a feature to force a release.
- A pull request says why it is needed, what changed, what stood before and after, how it was verified, its risks, required actions and unfinished work.
  Infinitary-authored new pull and merge requests share the completion card's saved story (`docs/forge.md`, "Saved change stories"): public GitHub and GitLab carry native attachments, while other description hosts carry text and keep media on the card.
  Plain branches and local-only changes keep the same story on their completion card; existing PRs that predate stories keep the five-heading format.
  Evidence files are never committed; release-note hero pictures remain part of the change.

## Reporting a security issue

Write to the maintainer privately rather than opening an issue.
