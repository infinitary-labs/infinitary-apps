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
A pull request adds a release note under `release-notes/changes/` when people using the app will notice the change, or an exclusion with a reason when they will not; a note for a feature, improvement or removal also names the docs site pages the pull request updated in `docsSite`, or says why none needs to in `noDocsSite`. The release-note check fails until it has them (`docs/release-notes.md`).

## Infinitary's Careful review

Raise an outside pull request with Infinitary at the Careful rigor level: an independent review, and live validation that the review accepted, of the pull request's newest version.
Open it from your own copy of the project with Infinitary, which writes its story and a record at the end of the description; after each later push, let Infinitary review and validate that version too, so the record names it.
The pull request's "PR raised with Infinitary's Careful review" check reads that record and passes; until then it fails and leaves one comment saying why.
A record written by another tool does not count (`docs/public-ci.md`, "The Careful review check").

## What happens after you open an issue or pull request

Open an issue from one of its forms: a problem, an idea or a question.
Inside the app, `/feedback` in the message box writes a problem or an idea for you, with the app's diagnostics and no personal details.
An issue opened from a form or with `/feedback`, and a new pull request from your own copy of the project, is labeled `needs triage` until a maintainer answers, usually within two working days.

The answer says what happens next, with a label:

- `accepted`: the project takes it on. A problem is reproduced before it is fixed, so it is accepted only once the maintainers' crew has made it happen on the version named in the answer; until then its first answer says it was read and keeps `needs triage`. If the maintainers later stop the work without shipping it, a new answer says so and closes the issue as declined.
- `released`: the release named in the answer holds the work, and the answer thanks you and closes the issue if it is still open.
- `waiting on author`: the answer asks you for something, such as more detail, the steps for a problem that did not happen when the maintainers' crew tried it, or a change. Your reply, or a new version of your pull request, puts it back in line.
- `duplicate`, declined or answered: the issue or pull request is closed, and the answer says why.

A pull request also waits on you while its "Contributor License Agreement" or "PR raised with Infinitary's Careful review" check fails; each check's comment says what it needs.
Once a maintainer approves its runs, a check that fails on your version labels it `waiting on author` with one automatic comment linking each failed check's log; the comment says when `main` is failing too, so a failure may not be yours. A new push, or a rerun that passes, puts it back in line.
When every check that failed also fails on `main`, the comment says so and nothing waits on you: a maintainer can run them again once `main` passes.
Something that waits on you gets one reminder after 14 days, and closes 14 days after that reminder; you are welcome to pick it up again in a new one that links the old.
Each account without write access to the project may have at most 3 pull requests open at a time, drafts not counted, so please finish or close one before opening a fourth.

## How the code is worked on

`AGENTS.md` and the pages under `docs/` it points to (`docs/README.md`) are the project's own account of how it is built, tested and released, and they apply to people as much as to agents. The short version:

- Before merge, finish the smallest relevant proof for the current version; `docs/testing.md` says what each change runs and where.
- Weakening, skipping or deleting a test that was there before the change requires the captain's approval.
- Passing checks never grants merge permission.
- All UI work follows the design skill under `.claude/skills/infinitary-design/`.
- Commit subjects and pull request titles use `type(scope): summary` or `type: summary`, optionally with `!` and a `BREAKING CHANGE` footer. Types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`; scopes are open-ended. `feat`, `fix` and breaking changes drive release versions, so do not call a fix a feature to force a release.
- A pull request says why it is needed, what changed, what stood before and after, how it was verified, its risks, required actions and unfinished work.
  Infinitary-authored new pull and merge requests share the completion card's saved story (`docs/forge.md`, "Saved change stories"): public GitHub and GitLab carry native attachments, while other description hosts carry text and keep media on the card.
  Plain branches and local-only changes keep the same story on their completion card; existing PRs that predate stories keep the five-heading format.
  Evidence files are never committed; release-note hero pictures remain part of the change.

## Reporting a security issue

Write privately to Infinitary Labs, Inc. at help@getinfinitary.com rather than opening an issue.
