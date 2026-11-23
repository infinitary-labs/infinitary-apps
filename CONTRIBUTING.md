# Contributing

Infinitary Labs, Inc. licenses its own Infinitary source code and documentation under the MIT License (see `LICENSE` and `NOTICE`). Third-party material retains its own terms and notices.
[`infinitary-apps`](https://github.com/infinitary-labs/infinitary-apps) is the home for source, issues, pull requests and releases, not a mirror.
For a large change, open an issue to discuss it before sending a pull request.

## Contributor License Agreement

Before a contribution from outside the maintainers can be merged, its author accepts the [Contributor License Agreement](CLA.md).
You accept once, and it covers that contribution and every later one.
To accept, tick the box at the end of the pull request template, or reply to your pull request with exactly this sentence:

> I agree that my submission is governed by the Contributor License Agreement

The pull request's "Contributor License Agreement" check then records your GitHub account, the pull request and the agreement's version in the project's public record issue, and passes.
Until you accept, the check fails and leaves one comment saying how.
Only the pull request's author can accept, and a new version of the agreement asks again.

Material that is not your own work goes in a separate submission (section 3 of the agreement): keep the copyright and license information it came with, and in the pull request's description write "Submission containing materials of a third party:" followed by the third party's name and any licenses or other restrictions you know of.

A maintainer approves each run of the project's checks on an outside pull request before it starts, and every one of them runs on GitHub's machines; how an outside pull request is checked and merged is in `docs/public-ci.md`, "Outside contributors".
A pull request adds a release note under `release-notes/changes/` when people using the app will notice the change, or an exclusion with a reason when they will not; the release-note check fails until it has one (`docs/release-notes.md`).

## Infinitary's Careful review

Raise an outside pull request with Infinitary at the Careful care level: an independent review, and live validation that the review accepted, of the pull request's newest version.
Open it from your own copy of the project with Infinitary, which writes its story and a record at the end of the description; after each later push, let Infinitary review and validate that version too, so the record names it.
The pull request's "PR raised with Infinitary's Careful review" check reads that record and passes; until then it fails and leaves one comment saying why.
A record written by another tool does not count (`docs/public-ci.md`, "The Careful review check").

## How the code is worked on

`AGENTS.md` and the pages under `docs/` it points to (`docs/README.md`) are the project's own account of how it is built, tested and released, and they apply to people as much as to agents. The short version:

- Before merge, finish the smallest relevant proof for the current version; `docs/testing.md` says what each change runs and where.
- Weakening, skipping or deleting a test requires the captain's approval.
- Passing checks never grants merge permission.
- All UI work follows the design skill under `.claude/skills/infinitary-design/`.
- Commit subjects and pull request titles use `type(scope): summary` or `type: summary`, optionally with `!` and a `BREAKING CHANGE` footer. Types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`; scopes are open-ended. `feat`, `fix` and breaking changes drive release versions, so do not call a fix a feature to force a release.
- A pull request says why it is needed, what changed, what stood before and after, how it was verified, its risks, required actions and unfinished work.
  Infinitary-authored new pull and merge requests share the completion card's saved story (`docs/forge.md`, "Saved change stories"): public GitHub and GitLab carry native attachments, while other description hosts carry text and keep media on the card.
  Plain branches and local-only changes keep the same story on their completion card; existing PRs that predate stories keep the five-heading format.
  Evidence files are never committed; release-note hero pictures remain part of the change.

## Reporting a security issue

Write privately to Infinitary Labs, Inc. at help@getinfinitary.com rather than opening an issue.
