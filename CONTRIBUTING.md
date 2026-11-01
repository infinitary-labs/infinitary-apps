# Contributing

Infinitary is licensed under the Apache License, Version 2.0 (see `LICENSE`). By contributing, you agree that your contribution is licensed under those same terms, as section 5 of the license and GitHub's Terms of Service (section D.6) already provide. There is no contributor license agreement to sign and no sign-off line to add to your commits.

## While the repository is private

Pull requests from outside are not merged yet: the repository opens with the public beta, and the first outside contribution lands after the company that will publish Infinitary is the Licensor. Until then, feedback is a conversation - an issue here if you have access, or the channel you were invited through.

## How the code is worked on

`AGENTS.md` is the project's own account of how it is built, tested and released, and it applies to people as much as to agents. The short version:

- Before every push, `pnpm typecheck && pnpm check && pnpm lint:adherence` pass (on a computer that sends its checks through CI, the pull request's own check runs them; `docs/testing.md`, "Where the heavy checks run"), along with the relevant existing end-to-end specs that cover what changed. Which tests to write, and how to repair a failing one, follows the crew's default rule on tests (`docs/delivery-rigor.md`, "The default rule on tests"), with one ruling of this project (`docs/testing.md`, "This project's rulings on tests"): weakening, skipping or deleting a test waits for the captain's approval. A new end-to-end journey follows the six-word rule like any other test, with no ask, and its review names the promised result, the data, the completion signal, the platform prerequisites and the shared resources (FI3-1732). The full unit suite runs in the pull request checks (`ci.yml`), its probes only where a change reaches them, and the full `pnpm build && pnpm exec playwright test` runs in `verify.yml` before every alpha and on demand for any branch (`docs/testing.md`). Full end-to-end runs are CI-only, never local development or release preparation; request one through `github_write` as described in `docs/forge.md` ("Verification workflow requests"). Locally, name only affected spec files, with `--no-deps` for renderer/application specs.
- All UI work follows the design skill under `.claude/skills/infinitary-design/`.
- Commit subjects and pull request titles use `type(scope): summary` or `type: summary`, optionally with `!` and a `BREAKING CHANGE` footer. Types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`; scopes are open-ended. Do not call a fix a feature to force a release.
- A pull request says why it is needed, what changed, what stood before and after, how it was verified, its risks, required actions and unfinished work.
  Infinitary-authored future github.com pull requests and gitlab.com merge requests share the completion card's saved story and native attachments (`docs/forge.md`, "Saved change stories"); existing PRs and other hosts keep the five-heading format.
  Evidence files are never committed; release-note hero pictures remain part of the change.

## Reporting a security issue

Write to the maintainer privately rather than opening an issue.
