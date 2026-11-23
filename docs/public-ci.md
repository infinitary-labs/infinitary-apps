# Public CI and release access

`infinitary-apps` is the new home for development, pull requests, batches and releases after cutover.
The existing private repository keeps running until that switch.

## Pull requests and runners

`infinitary-apps` is public and open to pull requests from everyone: pull request creation is set to all, and forking is on.
Set fork run approval to require approval for all external contributors, and read it back ("Outside contributors").
Read back effective access, including team and organization grants, rather than using the displayed account role alone.
The swept batch accepts only pull requests whose head repository is the current repository, from its reserved branch prefix into the default base branch.
A fork's pull request never starts it, even when its branch looks like an internal batch.

## The project's own Linux jobs

The project's own Linux jobs run on GitHub's hosted Ubuntu, which costs nothing a minute in a public project and leaves the project's own machines to the Mac, Windows and signing work.
The one exception is the branch check each push of the project's own task branches starts: its jobs run on the project's own Linux places, where they finish about three times sooner (INF-5577's review, the captain's pick "Run your own task branches' checks on your own Linux machines again; contributors' checks stay on GitHub").
Leave the repository variables `LINUX_RUNNER` and `RELEASE_LINUX_PACKAGES_RUNNER` unset on the destination, and set `LINUX_QUEUES` to `{"typecheck":"fleet-linux-pr"}` alone: every other Linux job then falls back to `ubuntu-24.04` (`docs/testing.md`, "Each Linux job's kind").
An outside contributor's pull request takes hosted Ubuntu before any variable, so it never reaches that queue ("Outside contributors").
The existing private project keeps its variables until it is archived, since GitHub bills its hosted minutes.
The Windows installer's unsigned build runs on hosted `windows-2025` whenever `WINDOWS_RUNNER` is unset (`docs/windows.md`, "The checks"); leave it unset.
The Mac jobs, the fresh Windows 11 check, signing and TestFlight keep their runner variables and stay on the project's own machines.
Use neutral runner registration names that identify platform and queue, not people or machines.
Keep routing labels intact, and verify an ordinary internal batch and release rehearsal select their existing lanes.
Do not share reusable runner workspaces, dependency stores, caches or deployment artifacts with untrusted jobs.

## Outside contributors

An outside contributor's pull request runs only on GitHub's hosted machines, whatever the routing variables say (`docs/testing.md`, "An outside contributor's pull request"):

- the branch check and the docs site's check on hosted Ubuntu;
- the tests the swept batch runs: the code checks, every Linux test group and journey and the Linux startup fixtures on hosted Ubuntu, and the three Mac lanes with every journey on hosted macOS;
- each journey file the change edits three rounds and then by itself on hosted Ubuntu, and once on hosted macOS;
- the Windows installer's build on hosted Windows, when the change reaches it.

Nothing from an outside change runs on the project's own machines, before or after the captain's merge click.
An outside change never joins the swept batch: once approved it merges as its own pull request (`docs/forge.md`, "Batches of your own").
So the fresh Windows 11 check, the phone check, the signed installer checks, signing and TestFlight first meet it after it reaches `main`: main's own check, and for the fresh Windows 11 install the next alpha's release check (`docs/alpha.md`).

### How an outside pull request moves

1. **It opens.**
   GitHub starts the contributor agreement check and the Careful review check at once, which need no run approval ("The contributor agreement check", "The Careful review check"); every other check waits for the captain's approval of the run.
   The check-file flag labels it `needs triage` ("Intake").
2. **The crew reads it when the captain asks.**
   Nothing reads new outside pull requests on a schedule.
   A crewmate reviews one the captain names (`check_change pull`), reads its code and GitHub's runs, and puts it on a card for the captain.
3. **The captain starts its checks.**
   The captain approves each run on GitHub, after reading any change under `.github/`, `scripts/`, the package and lock files or the packaging settings, since a pull request runs the check files it carries.
4. **GitHub's machines run them.**
   The checks in the list above run on the pull request's own version, merged with the current `main`.
5. **The captain merges it.**
   With every check passing, the crewmate shows the merge card with `asks_first`, and only the captain's click merges the contributor's pull request; no standing rule that lets a change merge on its own covers an outside one.
   A later push needs a new review and a new click.

The crew's safety rule: a crewmate reviewing an outside pull request runs nothing from it on the project's own machines or the captain's computers before the click; it reads the change and GitHub's runs, and starts nothing on the project's own runners for it.
The fork guard on the project's own runners refuses a job whose pull request comes from another copy of the project in any case.

Routing is not the guard: a pull request runs the check files it carries, so it can send itself to the project's own machines by editing them.
The guards are GitHub's approval of each outside run and the fork guard on the project's own runners.
Set the destination's fork run approval to "Require approval for all external contributors"; the first-time contributor options stop asking once a person has one change merged.
Approve a run only when the change leaves the check files alone, and read any change to them before approving.
The check files are what decide which checks run, where they run and what installs: `.github/`, `scripts/`, every `package.json` and `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/`, `packaging/` and the `electron-builder*.yml` files.
`check-file-flag.yml` marks such a pull request before anyone approves a run: it labels it `edits checks` and names its check files in one comment, and removes the label once a later version edits none (`scripts/check-file-flag.mjs`).
It also labels a pull request whose changed files GitHub lists only in part, since GitHub lists at most 3,000, and says so in that comment.
It marks and never fails or blocks a pull request, and leaves the project's own pull requests alone.
Like the agreement check below, it runs from the default branch on `pull_request_target`, checks out only its script and `scripts/intake-labels.mjs`, never the pull request's code, uses no secret beyond its own token, holds only issue and pull request writes (GitHub refuses a label on a pull request without pull request writes), and runs on GitHub's hosted Ubuntu (`tests/check-file-flag.test.ts`).
Started by hand with a pull request number, it reads any pull request of the project, its own included, so the flag can be proved before an outside copy exists.
Keep fork workflow write tokens and secrets restricted at the host: an outside pull request gets a read-only token and no secrets.

### Intake

GitHub sorts each new outside issue and pull request with no model, and a maintainer's reply settles it (`CONTRIBUTING.md`, "What happens after you open an issue or pull request").

- **Forms.**
  `.github/ISSUE_TEMPLATE/` holds three issue forms, a problem (`bug.yml`), an idea (`idea.yml`) and a question (`question.yml`); each labels its issue with its kind and `needs triage`, states the two-working-day answer window and points to `/feedback` in the app (`docs/feedback.md`).
  `config.yml` turns blank issues off and sends a security report to the private address in `CONTRIBUTING.md`.
- **New pull requests.**
  `check-file-flag.yml` labels a newly opened outside pull request `needs triage` ("Outside contributors").
- **Waiting on the author.**
  After each required check writes its status, it labels an outside pull request `waiting on author` while either required check fails; once both pass on the author's own event (a push, an edit, a reopening or an acceptance), the label comes off and `needs triage` goes on (`scripts/intake-labels.mjs`).
  A maintainer's event never takes the label off, so a reply asking for changes holds although both checks pass.
- **The triage mark.**
  `triage-mark.yml` reads each new comment (`scripts/triage-mark.mjs`).
  A comment from an account that can write to the project, judged by GitHub's collaborator permission API and never by the comment's author relation, may end with `<!-- infinitary-triage v1 disposition=NAME -->`.
  Each disposition takes `needs triage` off:

  | Disposition | Labels | Closes |
  | --- | --- | --- |
  | `duplicate` | adds `duplicate` | as not planned |
  | `needs-info` | adds `waiting on author` | no |
  | `accepted` | adds `accepted` | no |
  | `declined` | none | as not planned |
  | `answered` | none | as completed |
  | `changes-requested` (pull requests only) | adds `waiting on author` | no |

  Every disposition but the two that wait on the author takes `waiting on author` off too, and a pull request closes with no reason, which GitHub keeps for issues.
  The same mark from anyone else changes nothing, and a name off the list is no mark.
  When an item's own author comments while it is labeled `waiting on author`, the label comes off and `needs triage` goes on, so the next answer reads the reply.
- **The timer.**
  `waiting-on-author.yml` runs each day on hosted Ubuntu and reads only open items labeled `waiting on author` (`scripts/waiting-on-author.mjs`).
  An item starts waiting at the later of the label's newest addition and its author's newest comment, reopening or push.
  After 14 days it gets one reminder; 14 days after that reminder it closes, issues as not planned, with a note inviting a new one that links it.
- **The pull request limit.**
  The project's interaction limits allow each account without write access at most 3 open pull requests, drafts not counted; GitHub offers this setting in Settings, Moderation options, Interaction limits, and no API to read it.

The labels are `needs triage`, `waiting on author`, `accepted`, `idea` and `question`, beside GitHub's defaults and the project's own.
Like the agreement check, the triage mark and the timer check out only their own scripts from the default branch, never a pull request's code, read words only as data, use no secret beyond their token, hold only issue and pull request writes and run on GitHub's hosted Ubuntu; neither uses `pull_request_target` (`tests/outside-intake.test.ts`).

### The contributor agreement check

An outside pull request merges only once its author accepted the Contributor License Agreement (`CLA.md`, `CONTRIBUTING.md`).
`contributor-agreement.yml` sets the commit status "Contributor License Agreement" on each pull request's newest commit, which a branch rule on `main` requires once the project is public (`scripts/contributor-agreement.mjs`):

- a pull request from one of the project's own branches, a task's or a batch's, passes at once;
- an outside one passes when its author's numeric GitHub id accepted the version named on `CLA.md`'s "Version" line;
- otherwise the author's ticked template box or reply with the agreement's sentence writes one entry to the record and passes, while anyone else's reply changes nothing;
- until then it fails and leaves one comment saying how to accept.

The record is a locked issue of the project titled "Contributor License Agreement record", opened by a maintainer; each entry is a comment the Actions token writes there, naming the login, numeric id, pull request, the box or reply, the version and the time, and the check reads back only those comments.
A maintainer is an account with write or admin permission on the project, which the check reads through GitHub's collaborator permission API.
It never reads the issue's author association, because GitHub tells the Actions token that an organization member whose membership is private is only a contributor.
The Actions token comments on a locked issue with its issue write access, and no one outside the project's collaborators can.
Without the issue the check fails on every outside pull request and names what is missing.

It writes on an outside pull request, as the check-file flag does, so it runs from the default branch on `pull_request_target` and `issue_comment` rather than from the pull request's own files, and needs no run approval.
It checks out only its script, `scripts/intake-labels.mjs` and `CLA.md` from the default branch, never the pull request's code, reads the contributor's words as data, uses no secret beyond its own token, holds only issue, pull request and status writes (GitHub refuses its comment on a pull request without pull request writes), and runs on GitHub's hosted Ubuntu.
`tests/contributor-agreement.test.ts` holds each of these.

### The Careful review check

An outside pull request is raised with Infinitary at the Careful care level: an independent review and live validation that the review accepted, of its newest version (`CONTRIBUTING.md`, "Infinitary's Careful review").
Infinitary then writes a record at the end of the pull request's story: no-mistakes' signature line and its v1 attestation, with `producer` set to `infinitary` and a `live_validation` object (`src/core/forge/pipelineAttestation.ts`).
`careful-review-check.yml` sets the commit status "PR raised with Infinitary's Careful review" on each pull request's newest commit (`scripts/careful-review-check.mjs`):

- a pull request from one of the project's own branches, a task's or a batch's, passes at once;
- an outside one passes when its description carries the signature line and its first record parses, has `producer` `infinitary` with a `live_validation` verdict and counts, names the pull request's newest version, and marks review, test and document completed;
- otherwise it fails and keeps one comment, edited in place, saying why and how to raise the pull request with Infinitary; once a later version passes, the comment says so.

The status names the live validation's verdict and counts on a pass and the reason on a failure.
A record written by no-mistakes alone fails, since only Infinitary's Careful record counts here.
The check reads the description and newest version live from GitHub's API, never from the event, because a rerun replays its first event's payload.

The record is words in the description, and the author can type it by hand, so the check tells contributors what the project expects and never proves that a review happened.
It never stands in for reading the change, or any edit to check files before approving a run; the guards stay GitHub's approval of each outside run and the fork guard on the project's own runners.

It writes on an outside pull request, as the agreement check does, so it runs from the default branch on `pull_request_target` (opened, reopened, a push or an edit of the description) rather than from the pull request's own files, and needs no run approval.
It checks out only its script and `scripts/intake-labels.mjs` from the default branch, never the pull request's code, reads the description as data, uses no secret beyond its own token, holds only issue, pull request and status writes, and runs on GitHub's hosted Ubuntu.
Started by hand with a pull request number, it reads any pull request of the project; on one of the project's own it writes its verdict to the job summary alone, so the reading can be proved without changing that pull request's status.
`tests/careful-review-check.test.ts` holds each of these.

## Release environments

At the destination, configure branch rules allowing only `main` on `desktop-release`, `mac-installer-signing`, `ios-release` and `docs-site`, and on `windows-signing` if Windows signing is enabled.
Do not add a tag rule or a bypass for ordinary branch checks.
Place credentials in the environment of their consumers, not in repository- or organization-wide secret stores accessible from the destination:

| Environment | Credentials |
| --- | --- |
| `desktop-release` | Developer ID certificate and password, App Store Connect values for notarization and the phone gate, download-storage credentials and Homebrew tokens |
| `mac-installer-signing` | Developer ID certificate and password and the App Store Connect values used by signed installer verification |
| `ios-release` | App Store Connect values used for TestFlight readiness, upload and availability |
| `docs-site` | Docs site publishing credentials |

The signed installer workflow (`mac-installer.yml`) declares no credentials, and `release.yml` and `verify.yml` call it with `secrets: inherit`: a called workflow reads its job environment's credentials only when its caller hands its secrets on.
The old private project retains its existing secrets and release routes until cutover; its signed installer checks read the same `mac-installer-signing` environment.
On the public project, desktop release rehearsals use the main workflow and publish nothing.
A fresh manual signed installer verification on the public project uses the exact commit of its main dispatch, not a caller-selected branch.
An affected alpha runs the signed installer check before upload using merged release code selected by the protected release workflow.
Reusing an existing verified signed artifact does not invoke the signing build.
Before exposure, rehearse with the actual destination environments and verify signed installers, update feeds, both Homebrew taps and phone release continuity through their authorized checks.
Do not change signing keys or publish a release just to test a workflow change.

## Repository security controls

Enable dependency graph and Dependabot alerts on the destination before visibility changes, and read each back.
GitHub refuses secret scanning and push protection while the repository is private, so turn both on right after the visibility change and read them back.
A scan is not credential clearance; review findings privately and rotate any exposed credential through its owner.
Apply any settings changes only with the repository owner's approval.
