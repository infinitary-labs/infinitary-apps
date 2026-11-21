# Public CI and release access

`infinitary-apps` is the new home for development, pull requests, batches and releases after cutover.
The existing private repository keeps running until that switch.

## Pull requests and runners

Set GitHub pull request creation to collaborators only for the initial rollout.
Read back effective access, including team and organization grants, rather than using the displayed account role alone.
The swept batch accepts only pull requests whose head repository is the current repository, from its reserved branch prefix into the default base branch.
A fork's pull request never starts it, even when its branch looks like an internal batch.

## The project's own Linux jobs

The project's own Linux jobs run on GitHub's hosted Ubuntu, which costs nothing a minute in a public project and leaves the project's own machines to the Mac, Windows and signing work.
The one exception is the branch check each push of the project's own task branches starts: its three jobs run on the project's own Linux places, where they finish about three times sooner (INF-5577's review, the captain's pick "Run your own task branches' checks on your own Linux machines again; contributors' checks stay on GitHub").
Leave the repository variables `LINUX_RUNNER` and `RELEASE_LINUX_PACKAGES_RUNNER` unset on the destination, and set `LINUX_QUEUES` to `{"typecheck":"fleet-linux-pr"}` alone: every other Linux job then falls back to `ubuntu-24.04` (`docs/testing.md`, "Each Linux job's kind").
An outside contributor's pull request takes hosted Ubuntu before any variable, so it never reaches that queue ("Outside contributors").
The existing private project keeps its variables until it is archived, since GitHub bills its hosted minutes.
The Mac, Windows, signing and TestFlight jobs keep their runner variables and stay on the project's own machines.
Use neutral runner registration names that identify platform and queue, not people or machines.
Keep routing labels intact, and verify an ordinary internal batch and release rehearsal select their existing lanes.
Do not share reusable runner workspaces, dependency stores, caches or deployment artifacts with untrusted jobs.

## Outside contributors

An outside contributor's pull request runs only on GitHub's hosted machines, whatever the routing variables say (`docs/testing.md`, "An outside contributor's pull request"):

- the branch check and the docs site's check on hosted Ubuntu;
- the journeys its change can break on hosted Ubuntu, and their tests that need a Mac on hosted macOS;
- the Windows installer's build on hosted Windows, when the change reaches it.

The fresh Windows 11 check, the phone check, the signed installer checks, signing and TestFlight wait for the batch, which runs every check again on the project's own machines.

Routing is not the guard: a pull request runs the check files it carries, so it can send itself to the project's own machines by editing them.
The guard is the owner's approval of each outside run.
Set the destination's fork run approval to "Require approval for all external contributors"; the first-time contributor options stop asking once a person has one change merged.
Approve a run only when the change leaves `.github/` alone, and read any change there before approving.
Apply the same rule before a contributor's change enters a batch, which runs on the project's own machines with its secrets.
Keep fork workflow write tokens and secrets restricted at the host: an outside pull request gets a read-only token and no secrets.

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

Enable dependency graph and Dependabot alerts, secret scanning and push protection on the destination, and read back each control before visibility changes.
A scan is not credential clearance; review findings privately and rotate any exposed credential through its owner.
Apply any settings changes only with the repository owner's approval.
