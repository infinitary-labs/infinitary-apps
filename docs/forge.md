# The forge seam: where a project lives

Git integration PR 1.1 and PR 1.2 (captain verdicts of 2026-09-24: direction C, GitHub only for now, a plain host's proposed change is sent up, the app's own GitHub sign-in with the device flow, ignore any other GitHub sign-in on the Mac).
GitHub Enterprise and GitLab share the host layer (the captain's "Shape the host layer for both" on FI3-1446).
GitLab signs in through the browser or with a key on gitlab.com or a self-hosted server, lists, finds and clones projects, delivers through merge requests whose pipelines read as checks, gives crewmates its job logs, artifacts archives and API, and lists the person's open merge requests.
This is the one home of what the seam is in the code.

## What it is

`src/core/forge/` answers every question the app asks of the place a project lives, without the rest of the core knowing which host answers:

| Call | GitHub | GitLab | Plain Git host | Kept on this Mac |
|---|---|---|---|---|
| `changeFor(branch)` | the open pull request for the branch | the open merge request from the project's own branch | the branch, if it has been sent up | never one |
| `checks(change)` | every page of the check runs (a cancelled run superseded by a later run of its workflow set aside) and commit statuses on the head; a suite past the ten pages read keeps a pending item, so it never reads green | the pipelines for the head and each one's jobs ("GitLab merge requests" below) | none: green with zero checks | none |
| `holdsCommit(sha)` | whether the Git database holds that exact full commit id (`git/commits`), since the commit reads `checks` uses resolve a longer id by its first 40 characters; a 404 counts only once the repository reads | whether `repository/commits` answers that exact full id, once the project reads | absent | absent |
| `branchesAt(sha)` | the branches whose head is that version (`branches-where-head`), where a pushed or dispatched run can still start | the branches `repository/commits/:sha/refs` says hold it whose own head it is; a full page is unknown | absent | absent |
| `pull(number)` | the pull request by its number, open or not, merged or not, with its readiness (`mergeable_state`: clean, conflict, behind, blocked by the branch's rules, computing, draft) | the merge request by its number, with its readiness from `detailed_merge_status` | absent | absent |
| `putIn(change, headSha)` | merge, only at the checked head, taken only when GitHub answers `merged` | squash merge, only at the checked head (`sha`), taken only when GitLab reads it merged | fast-forward the default branch onto the checked head and send it up, never forced | not through the seam: the local land (`WorkspaceService.landTaskWork`) through the local-only posture |
| `close(change)` | close without merging | close without merging | take the sent-up branch back | nothing to close |
| `openChange` | open a pull request onto the default branch | open a merge request onto the default branch | send the branch up | refused as `unsupported` |
| `label(change)` / `url(change)` | `#N` and its page | `!N` and its page | the branch, no page | the branch, no page |
| `listProjects()` | the person's repositories, newest first, every page up to 1,000 (`listProjectsPaged` also says whether that was all; `findProject` reads one exact owner/name) | the person's projects, newest first, up to 1,000 (`findProject` reads one exact nested path) | none | none |
| `hasChecks` | yes: the app watches them (below) | yes | no: nothing is watched, and the crewmate is told so | no |
| `workflows` | read-only Actions runs, jobs, logs and artifact downloads, whole or in parts | read-only pipelines, jobs, logs and artifacts archives | unsupported | unsupported |
| `api` | the gateway's raw REST call under GitHub's policy | the gateway's raw REST call under GitLab's policy | unsupported | unsupported |

A `Forge` is per repository.
`createForgeResolver` in `src/core/forge/index.ts` picks it from the repository's `host`, which the registry stamps from its `origin` through `forgeOf` (`src/shared/forge.ts`) at insert and migration 40 backfilled for older rows (logged in `forge_backfill`).
The composition root binds an implementation per kind (`ForgeBindings`); a kind with none is a plain host.
GitHub and GitLab are bound; they are the kinds with change requests (`hasChangeRequests`, `src/shared/forge.ts`), which the merge path, the kept merge approval and the settle words read instead of naming GitHub.
Bitbucket is recognised by name and behaves as a plain host.

## The kinds

- `github`: `providers/github/githubForge.ts`, GitHub's REST API with the app's own GitHub sign-in as a bearer token (git integration PR 1.2; below), on github.com and on each GitHub Enterprise host at that host's own API (`githubApiBaseFor`).
  `INFINITARY_GITHUB_API_URL` (github.com) and `INFINITARY_GITHUB_ENTERPRISE_API_URL` (every enterprise host) are honoured only in an unpackaged app.
  The home's forge wiring (`src/core/forge/homeForges.ts`) binds every GitHub project to it; no other program's GitHub sign-in is ever read, and the app no longer runs any GitHub tool of the Mac's.
- `gitlab`: `providers/gitlab/gitlabForge.ts`, GitLab's REST API (`/api/v4`) with the app’s own sign-in, on gitlab.com and on each self-hosted server ("GitLab merge requests" below).
- `git` (and `bitbucket`): `providers/plainGit.ts`, git against the repository's own `origin` with prompts off.
- `none`: `providers/noHost.ts`.
  There is nowhere to send a change.

## The app's own sign-in (PR 1.2)

The owner's verdicts: an OAuth App with the device flow; ignore any GitHub sign-in already on the Mac; and nothing ever makes a host look required.
The OAuth App is Infinitary, owned by the infinitary-labs organization, with `https://getinfinitary.com/` as its homepage; renaming it and moving it there kept its client id, which every released version sends (INF-875).
GitHub, each GitLab host and each GitHub Enterprise host are shown in Settings -> Integrations (`docs/integrations.md`); Projects keeps the pointer and other computers' own GitHub sign-ins.

- **The flow** (`providers/github/oauth.ts`): `POST /login/device/code` with the registered client id `GITHUB_OAUTH_CLIENT_ID` (public; there is no secret) and the scopes `repo workflow read:org`, then `POST /login/oauth/access_token` every `interval` seconds - `authorization_pending` waits, `slow_down` adds five seconds (or takes GitHub's new interval), `expired_token` ends as "The code expired." with a fresh code on request, `access_denied` ends quietly.
  The Settings aside shows the current code with a keyboard-accessible "Copy code" button; a polite live status confirms clipboard success or honestly reports failure, resetting for each code/sign-in attempt.
  Only our renderer has the write-only clipboard permission; clipboard reads and foreign documents remain denied.
  Copying never changes the sign-in flow, and "Open GitHub" still hands the page to the system browser.
  `INFINITARY_GITHUB_OAUTH_URL` points the flow at a stub in dev and e2e only.
- **The store** (`signIns.ts`, `ForgeSignInStore`): `userData/forges/<host>/sign-in.json`, a 0700 directory and a 0600 one-line file `{ token, scopes, login, createdAt }` - plus `refreshToken`, `expiresAt` and `refreshExpiresAt` for a short-lived sign-in (below) - one per host.
  It is a sibling of the account vault, never a `PROVIDER_CATALOG` row and never visible to routing.
  Signing out deletes the directory; an OAuth App with no secret cannot revoke from the app, so the person revokes on GitHub's own page (github.com/settings/applications).
  Observe's redaction covers every GitHub sign-in shape (`gho_`, `ghu_`, `ghs_`, `ghr_`, `ghp_`, `github_pat_`), and the sign-in never rides an environment variable, an argument, a log line, a timeline event, a card, or anything the window reads.
- **Health** (`ForgeSignIns`, the five rules of `src/core/accounts/credentialHealth.ts`) on the supervisor's 60s tick and once at boot: `GET /user` 200 is `ok` and refreshes the login; a 401 is `needs_reauth` only on proof - a sign-in with no refresh token, a renewal GitHub refused, or a 401 that survived a real renewal (the account credentials' rule, `docs/quota.md`); a 401 whose renewal could not reach GitHub is `unavailable`; a 403 on a spent allowance, a 5xx and no network are `unavailable`, retried, never a sign-out; an unreadable store is `unknown`.
  A forge request GitHub refuses with 401 asks for a health read at once (`onSignInRejected`) rather than trusting one refusal.
  With nothing signed in nothing is read.
  Every change of health, every completed sign-in and every sign-out is one dated line in `userData/forges/health.log` (0600, beside the hosts' folders so it outlives a sign-out, newest 64 KiB kept) and on the console: `<ISO time> github.com sign-in ok -> needs_reauth (answered 401)` - the states and GitHub's HTTP status, or why it could not be asked, never the sign-in.
  Once anyone has signed in here, the app's start and quit add one line each - `app start: signed in since <createdAt>` / `app quit: ..., last read ok` or `not signed in` - so a sign-in that dies while the app is closed is bracketed by the quit that last saw it and the start after.
  A packaged app's console reaches no file, and the owner's first real sign-in (revoked on GitHub while the app was closed, 2026-09-24/25) left no local trace of when GitHub began refusing it; the log is that trace, and the `signed in` lines count the sign-ins this install made.
  The view rides `inf:forges` (read `inf:forges:list`; `inf:forges:sign-in|cancel|sign-out`).
- **Short-lived sign-ins** (the owner's first real sign-in, 2026-09-24/25): GitHub gives every OAuth App registered since its 2026-08-14 change eight-hour sign-ins by default, in the device flow too (changelog "Multiple redirect URIs and token refresh for OAuth apps"; docs "Authorizing OAuth apps" -> expiring access tokens).
  The answer then carries `expires_in`, a `refresh_token` (six months without use) and `refresh_token_expires_in`.
  The app once kept only the access token, so the owner's sign-in died eight hours in, while the app was closed, with no revoke in the captain's security log.
  Now `pollForToken` keeps all three, and `ForgeSignIns` renews with `refreshSignIn` (`POST /login/oauth/access_token`, `grant_type=refresh_token` and the client id; a device-flow sign-in needs no secret): ahead of the end by `RENEW_LEAD_MS` (10 minutes) on the tick and before handing a forge request its sign-in, at the first read after a start when it ran out while the app was closed, and once when GitHub answers 401.
  A refresh token works once and retires the access token it came with, so renewals run one at a time per host, and a renewal never writes over a sign-out or a new sign-in made while GitHub answered.
  A refused refresh token is dropped from the file.
  A renewal fires `onRenewed`, which takes down a card a git refusal raised and dispatches the work held behind `forge-sign-in:<host>`.
  The health log dates each renewal (`sign-in renewed, short-lived until <ISO>`) and each refusal.
  A sign-in GitHub issues without a refresh token behaves as before.
- **The one host card**: `card-forge-<host>`, "Sign in to GitHub again", raised only on `needs_reauth`, naming how many proposed changes wait on it; its one action is `open projects` with `signIn`, which lands on Settings -> Integrations, where the host sign-ins live, with the code already on screen (`openedSection`, `docs/integrations.md`).
  It takes itself down when GitHub answers again.
  An unreachable GitHub is one feed line ("Could not reach GitHub - trying again."), written only while a project lives on that host, so a sign-in no project uses writes none (`src/core/forge/healthNote.ts`); a 403 on opening a change is one feed line asking for write access.
  No card for either.
- **Not signed in, as a refusal with ways** (`signInRefusal.ts`): `locate_project` (when nothing was found on this Mac), the setup card's answer to the first mate (a clone the captain's Add project could not make from a host whose sign-in the app lacks, through the shared action dispatcher; `docs/fleet.md` "Asking the first mate to add a project") and a settle's put-in answer "Not signed in to GitHub (github.com)" with two typed ways: an `open` effect `{ target: "projects", signIn: "github.com" }` ("Sign in to GitHub") and `app_change project-settings` with `changes.delivery: local-only` ("Keep it on this computer", where there is a project to keep).
  The shared dispatcher carries the clone's typed refusal in `SignInRequiredError`; `app_change` renders its ways for the first mate, while Settings keeps its tab-specific sign-in sentence.
  A clone offers only the sign-in way because no project exists yet.
  Other clone failures keep their original error.
  The first mate turns them into one decision card under one prompt rule (contract v4.8); the host raises no card of its own for it.
  A crewmate's `open_change` and `check_change` answer the same fact as its blocker to report - it never signs in.
  The crewmate is told that once, in its prompt (`tests/crewmate-fixed-context.test.ts`); the tools do not repeat it.
- **Git that never prompts** (`src/core/hostEnv.ts`): every child the core starts - host git, a crewmate's shell, Claude's client - carries `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` naming the shipped helper `resources/git-askpass` (extraResources, executable, outside the archive; the release contract and `scripts/verify-app.sh` pin it) and `INFINITARY_GIT_SIGNIN_DIR`.
  The helper answers the stored sign-in for an `https://` host with a sign-in here, with the user name its file names (`gitUser`) or `x-access-token`, and nothing for any other.
  `GIT_CONFIG_PARAMETERS` empties the credential helpers for `https://github.com` and each host on the person's own server with a sign-in here, read at each spawn - so neither the keychain's helper nor another program's GitHub sign-in ever answers for them under the app, while a plain host keeps the person's own helpers - and an SSH origin is the person's own agent, untouched.
  The username `x-access-token` is the plan's choice; the helper's answer is proven against a local HTTPS host (`hostEnv.gitSignIn.test.ts`), and it is NOT yet verified against a private repository on github.com with a real sign-in (the plan's open item; no real sign-in exists on the machines that built this).
- **Dispatch-time sign-in refusal** (`src/core/workspace/forgeAuth.ts`): before a task starts, a failed `origin` fetch on an HTTPS remote of a host the app signs in to - github.com, or a known host on the person's own server - is held only when Git reports the askpass username prompt could not be answered or explicitly reports authentication failure (`ForgeAuthRequiredError`, carrying the host and its name).
  The worktree is not created and the task returns to the queue behind `forge-sign-in:<host>`; a host card opens Integrations with that host's sign-in started.
  When the host's existing sign-in reports `ok`, the gate is cleared and the task is dispatched again, re-fetching its base.
  DNS, connection, SSH, other-host and unstructured text failures continue through the ordinary stale-ref fallback; they never trigger GitHub sign-in.
- **The crewmate's pair** (`src/core/pi/forgeTools.ts`): `open_change` offers the pushed branch, on the task's own project or another project the app manages (`repository`, a project it does not manage refused; "A change in another project" below) and onto the branch it names (`base`; the default branch otherwise); `check_change` names the task's change (`change`) and reads raw check and mergeability facts and records evidence-backed declarations without deciding readiness or repair settlement.
  A base other than the default branch is a stacked change's; the app retargets nothing when that branch merges, and the host's own behavior decides where the change then points, which each reading records (`TaskDelivery.prBase`).
  Existing diagnosis, repair and rerun fields remain readable; conflictRepair and captainGuidance retain the captain's approval boundary.
  Handed to every crewmate whose task ships a change, never on the personal workspace or an answer task.
- **The personal panels' read**: `forge.changes` (`inf:forges:changes`) - the captain's open pull requests on every GitHub and GitLab host the captain signed in to, newest first across them, each with its checks and the host's own name for it (`label`: `#12`, `!4`).
  GitHub's come from one GraphQL request per host with each one's check rollup (`providers/github/changes.ts`); GitLab's from `GET /merge_requests?scope=created_by_me&state=opened`, 20 at most, then each merge request's own read for its head pipeline, five at a time (`providers/gitlab/changes.ts`): a passed or skipped pipeline is passed, a failed or cancelled one failed, any other pending, and none is none.
  A host that cannot be read makes the read unreachable this time, never a guessed row; a GitLab 401 counts as a sign-in only once GitLab no longer answers for the key.
  The `github-prs` authoring skill teaches it; no panel shells out for it.
  `tests/gitlabStub.test.ts` reads GitLab's rows on both kinds of host, and `tests/e2e/ui-kit-panel.spec.ts` shows a GitLab merge request as `!1` beside GitHub's pull requests in the panel that skill teaches.
- **Where it shows**: all this computer's host sign-ins in Settings -> Integrations (`src/renderer/src/settings/IntegrationsTab.tsx`; design skill `components/integrations/IntegrationRow`), one row per host.
  Projects keeps the pointer to Integrations and other computers' own sign-ins; with no integrations, the tab shows its quiet line and connect chips.
  The first launch never shows it.

## Hosts on your own server

GitHub Enterprise - GitHub Enterprise Server, or GitHub Enterprise Cloud on its own `<name>.ghe.com` - is GitHub on the person's own server.
The app's OAuth App lives on github.com alone and does not exist there, so such a host signs in with a key the person makes on it, the way a custom API connection takes a key (FI3-1446 mapped the GitHub assumptions this layer removes).

- **Which hosts it knows** (`KnownForgeHost`, `src/shared/forge.ts`): a host and the kind it runs.
  `forgeOf(origin, known)` reads a public host by its name, a `<name>.ghe.com` host as GitHub by its name alone, and any other host as the kind `known` names, else a plain Git host.
  `ForgeSignIns.knownHosts()` is every host with a key sign-in on file (its file names its kind) and every host the person's projects are stamped with, for a kind the app offers a sign-in to.
  Nothing is guessed from a host's name beyond `.ghe.com`, and nothing asks a host what it runs: a GitHub Enterprise Server is known once the person signs in to it.
- **Its projects** (`RepoRegistry`): a new project on a known host is stamped that kind at setup, and `stampKnownHosts` stamps the ones already there - at a key sign-in, and at each start (a `.ghe.com` project an earlier run stamped a plain host, or an unstamped row).
  Nothing is stamped back: after a sign-out the host stays GitHub, as a github.com project does, and asks for its sign-in the same way.
- **The kinds of server** (`ForgeServer`, `forgeSignInServers` in `src/core/forge/index.ts`): what it is called ("GitHub Enterprise"), the user name git gives it (`x-access-token`), and one host's sign-in check (`createGitHubServer`, `providers/github/oauth.ts`: `GET /user` at the host's API).
  The view lists them as `servers`, one chip each.
- **The key sign-in** (`ForgeSignIns.signInWithKey`, `inf:forges:sign-in-key`): Settings hands the kind, the address as typed (the host's name, a page on it, or a project's address there; `hostOfAddress`) and the key to the core once.
  The core refuses what it can tell alone - no host, github.com (which signs in with its own button), another public host, a kind it does not offer, a key that is not letters, digits, `_`, `-` and `.` - then asks the host who the key is and keeps only a key it answers for.
  A 401 or 403 is `refused`, no answer or a 5xx is `unreachable`, anything else is `not-server`; the answer names the problem and the host, and Settings says it in `forgeKeyProblemText`'s words.
  The key is kept in the same 0600 file with `kind` and `gitUser`; the health log dates it (`signed in with a key, answered 200`) and never holds it, and nothing the window reads carries it.
- **Its health and cards**: the same five rules on the same tick, with nothing to renew, so the host's 401 is `needs_reauth` at once and raises `card-forge-<host>`, "Sign in to github.example.com again", whose open effect lands on the key form for that host.
- **Its name**: the host's own address ("github.example.com") everywhere a host is named (`forgePlace`; `serverHostName` falls back to "GitHub Enterprise" for an address too long for a row).
  The first mate's `lives` fact reads `github (signed in as mona)` for it like github.com's.
- **Its API** (`githubApiBaseFor`): `api.<name>.ghe.com` for GitHub Enterprise Cloud, `https://<host>/api/v3` (GraphQL at `/api/graphql`, `githubGraphqlUrl`) for a server.
  Every GitHub read and write - the listing and lookup, pull requests, checks, merges, workflow logs and artifacts, the open-changes panel and the gateway - goes there with that host's sign-in; the gateway's `nextPath` stays under the API's own path.
- **Its git**: the helper answers the host's name from the file (`resources/git-askpass` reads `gitUser`, else `x-access-token`), and the credential helpers are emptied for each such host with a sign-in on file, read at each spawn (`ForgeSignIns.gitHosts`), so only the app's key answers it.
  One the app holds no key for keeps the person's own helpers, as before the app knew it.
- **A refused fetch** waits for that host's sign-in (`forgeAuthRequired`, below), keyed `forge-sign-in:<host>`.
- **Settings -> Integrations** (`IntegrationsTab.tsx`, with forms in `ForgeSection.tsx`, design skill `components/integrations/IntegrationRow`): "+ GitHub Enterprise" opens the key form; a known host's chip, its row's "Sign in again" and a card's sign-in open it filled in for that host.
  The row reads "github.example.com" over "GitHub Enterprise · as mona · 2 actions".
- **How GitLab fits**: a self-hosted GitLab is one more `ForgeServer` (kind `gitlab`, git user `oauth2`, its own `whoAmI`), one more binding for `gitlab`, and its kind in `forgeAuthRequired`'s list; the known hosts, the stamping, the key form, the store's `kind`/`gitUser`, the helper and the host-keyed waits are already its.
- **Not yet**: a computer that runs work signs in to github.com alone (`docs/helper.md`), so a GitHub Enterprise project set to run there is tried with that computer's own git setup; a host whose certificate comes from a company's own authority is not trusted by the app's requests; a workflow artifact a server keeps on storage other than its own host or GitHub's is refused as an unsafe download; and only the captain's own words sign the first mate out of github.com, not another host.

## GitHub CLI's sign-in

Some organizations do not approve third-party OAuth apps such as Infinitary, and GitHub then hides their private repositories from the app's own sign-in.
GitHub lists GitHub CLI among the GitHub-owned apps a person may authorize even where an organization owner restricted OAuth app access ("Privileged OAuth apps"), so a person who already set up GitHub CLI can let the app use its sign-in instead (INF-1774, the captain: "provide an alternative way for them to connect infinitary with their github, which is through gh cli").
It is a third way inside the one sign-in store, so everything above `ForgeSignIns.token` - the forges, the gateway, the workflow tools, the panels, the crew's tools and the first mate's facts - is unchanged.

- **Finding it** (`githubCli.ts`): GitHub CLI on the search path the app captured (`findOnPath` over `hostEnv()`), never installed or updated by the app.
  `INFINITARY_GITHUB_CLI` stands in for it in dev and e2e only - a program's path, or `none` - and the e2e launcher sets `none`, so no test finds the one installed on the Mac it runs on.
- **Choosing it** (`ForgeSignIns.signInWithCli`, `inf:forges:sign-in-cli`): one line under the GitHub code aside, and under the GitHub Enterprise key form, shown only while GitHub CLI is found (`ForgesView.githubCli`); nothing asks GitHub CLI until the click.
  The core asks `gh auth token --hostname <host>` and the host who that is (`GET /user`), and keeps only a sign-in the host answers for.
  GitHub CLI holding no sign-in is `none`, a missing program `missing`, a 401 or 403 `refused`, no answer `unreachable`; Settings says each in `forgeCliProblemText`'s words.
- **The file**: `{ scopes, login, createdAt, way: "cli", program }`, with `kind` and `gitUser` for a GitHub Enterprise host - never GitHub CLI's token.
  The health log dates it (`signed in through GitHub CLI, answered 200`).
- **The token** (`ForgeSignIns.token`): asked of the program the file names at the moment a sign-in is needed, kept `GITHUB_CLI_KEPT_MS` (a minute) so a burst of requests asks once, and dropped on a refused request.
  GitHub CLI refreshes an expiring token of its own before it prints it, so nothing here renews it.
- **Its git**: the helper reads `way` and runs the named program for the host's token each time git asks (`resources/git-askpass`); the credential helpers stay emptied for the host, so only the app's helper answers it.
- **Its health and card**: the health read asks GitHub CLI afresh, then the host.
  GitHub CLI holding no sign-in, or the host's 401, is `needs_reauth`; a program gone from its path is `unknown`; one that could not be asked is `unavailable`.
  Only the person signs GitHub CLI in again, so the row reads "Sign in to GitHub CLI again, then Check now." with a Check now button, and the host card names GitHub CLI and opens Integrations without starting a code (`forgeCliRefusedText`).
- **Its row** reads "as octo · through GitHub CLI · 2 actions"; "Sign out and remove" deletes the app's file only, and GitHub CLI stays signed in for the person's own use.
- **The owner's earlier verdict**, "ignore any GitHub sign-in already on the Mac", stays the default: GitHub CLI is asked only for a host whose sign-in the person chose to make through it (`tests/e2e/forge-seam.spec.ts` keeps asserting that nothing else asks it).
- **Not yet**: a computer that runs work keeps its own github.com sign-in and does not use GitHub CLI (`docs/helper.md`); the row does not say which of the app's three scopes GitHub CLI's sign-in lacks; and the app cannot tell a blocked organization from a missing repository.

## GitLab sign-in and projects

GitLab offers browser sign-in and a key alternative on gitlab.com and on the person's own server.
The GitLab chip opens browser setup with gitlab.com; changing Address selects a self-hosted server.
The browser flow uses GitLab's device authorization grant (generally available in GitLab 17.9), reusing the same code, Copy code, Open and Cancel aside as GitHub.
Older servers keep key sign-in.

### Registering the application

An application belongs to one GitLab host, never every server.
The project carries no shared gitlab.com application, so the app guides a personal registration there as well as on self-hosted servers.
Settings opens `https://<host>/-/user_settings/applications` and explains the host's fields: name Infinitary, Confidential off, scopes `api` and `write_repository`, Device authorization grant on, and Redirect URI `https://<host>/oauth/device` (required by registration, unused by the device grant).
GitLab leaves Device authorization grant off on a new application and refuses its code sign-in as `access_denied` until the person turns it on.
The person supplies the Application ID, never the Secret; if server policy prevents registration, its administrator can supply an ID or the person can use a key.
The Application ID survives a successful sign-in in the same host's file and prefills a later browser setup; signing out forgets it with the sign-in.

### Browser sign-in and renewal

`inf:forges:sign-in-browser` hands the host, kind and public Application ID to `ForgeSignIns.signInWithBrowser`.
`providers/gitlab/oauth.ts` sends `POST /oauth/authorize_device` with `client_id` and `scope=api write_repository`, then polls `POST /oauth/token` at the server's interval with the device grant, device code and client ID.
Pending waits, slow-down adds five seconds, expiry offers a fresh code, denial closes quietly, and Cancel or a replacement ends the attempt, including a delayed start or identity read.
Only the user code and same-origin verification page reach the view; the device code, access token and refresh token never do.
Both endpoints refuse redirects and bound their answers to 16 KiB and each request to 30 seconds; errors never repeat server response text.
A start GitLab refuses throws `ForgeStartError` with a closed `ForgeStartProblem` (`src/shared/forges.ts`) read from the status and OAuth error code alone: `not-allowed` (`access_denied`, `unauthorized_client`), `client` (`invalid_client`), `scope` (`invalid_scope`), `not-found` (a 404 or an answer that is not OAuth JSON), `unreachable` (no answer or a 5xx) or `answer`.
`ForgesView.ended.problem` carries it to browser setup, which says what to change (`forgeStartProblemText`), and the app's forge log line names it with the status and code, never the Application ID.
`INFINITARY_GITLAB_OAUTH_URL` overrides the host only in an unpackaged development/test run.

The host's existing 0600 sign-in file keeps `applicationId`, `kind: gitlab`, `gitUser: oauth2`, the access token, expiry and refresh token when issued.
The existing renewal owner serializes refreshes, renews before expiry and after a 401, and never writes over a sign-out or a new sign-in.
A renewal uses the saved sign-in's Application ID, not a different registration an unfinished attempt supplied.
GitLab refusing a refresh grant is proof; a network failure, 403, rate limit, server error or unreadable answer is not sign-out.
The shared health rules, host-keyed waits and project stamping remain the same.

### Key sign-in

Use a key instead opens the existing masked key form, preserving Address; Use browser sign-in returns without carrying a key.
The Make a key button opens `/-/user_settings/personal_access_tokens` with `api` selected.
`createGitLabServer` supplies the kind `gitlab`, git user `oauth2`, and `GET /api/v4/user` to verify either method and read its health.
`ForgeServer.hosts` names public hosts that accept keys; this exception applies only to the named kind, never GitHub's code sign-in.
A key is never renewed: a refused key needs a new sign-in, and an unreachable host or a 403 is never proof of sign-out.
Observe redacts the standard `glpat-` token shape as well as sensitive token headers.

`gitlabApiBaseFor` uses `https://<host>/api/v4`; `INFINITARY_GITLAB_API_URL` overrides it only in an unpackaged development/test run.
`GitLabClient` sends `Authorization: Bearer` (accepted by GitLab for both keys and browser sign-ins) only to that API, refuses redirects, bounds each response to 256 KiB (a gateway answer past it is held, up to 100 times the cap, only to page it; "Caps", below) and each request to 30 seconds, and asks the existing health service to check a 401.
`GitLabProjects` reads `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc`, 100 per page up to 1,000, reporting an incomplete listing honestly.
Exact lookup uses `/projects/<encoded full namespace>` so nested groups are preserved.
`locate_project` preserves subgroup paths and recognises GitLab's `/-/` page routes.
Settings' Add project lists the host's projects and clones using the app's own git helper; a self-hosted project's kind is stamped GitLab once the host is known.
An HTTPS authentication refusal on either GitLab kind waits for that host's sign-in through `forgeAuthRequired`; SSH still uses the person's own setup.

A crewmate's job logs, artifacts archives and API calls on a GitLab project are "Workflow logs and artifacts" and "The gateway" below; the open-changes read is "The personal panels' read" above.

**Not yet:** sign-in on a computer that runs work.
A server with a private certificate authority is not trusted by the app's API requests.
No shared application is registered on gitlab.com; guided per-host registration works without a secret, and a personal access key remains available.

## GitLab merge requests

A GitLab project's direct-pr task delivers the way a GitHub one does: the crewmate pushes its branch and calls `open_change`, the checks gate and `check_change` read the pipelines, the check watch follows them, and the captain's merge, or a kept merge approval (FI3-304), squash-merges the checked version.
`GitLabForge` (`providers/gitlab/gitlabForge.ts`) reaches the project at `/projects/<encoded group/subgroup/name>`, so nested groups keep their whole path, through the same `GitLabClient` and per-host sign-in.

- **Its change** is a merge request from the project's own branch onto the default branch (`POST /merge_requests`, `source_branch`, `target_branch`, `title`, `description`); a fork's merge request from a branch of the same name is never taken for it.
  A new merge request's description is its saved story: gitlab.com confirms every selected upload first, while a self-hosted server publishes the text and retains media on the completion card ("Saved change stories" below).
  It is named `!N` with GitLab's page, and recorded on the task as `changeLabel`, `prNumber` and `prUrl` like a pull request; surfaces keep the app's word, pull request.
  Its head is the merge request's `sha`.
- **Its checks** are read for the head and nothing older (`checks()`):
  - every pipeline on the head counts - a branch pipeline, a merge request pipeline (`refs/merge-requests/<N>/head`) - and so does a merged-results or merge-train pipeline (`.../merge`, `.../train`), whose own commit is a merge of the head into the target branch: the app reads that commit's parents and counts it only when the head is one of them;
  - a later pipeline on the same ref for the same head stands for that ref, the way a rerun does on GitHub; pipelines on different refs all count;
  - each counted pipeline is one check and each of its jobs another; pagination limits mark the reading incomplete rather than inventing a pending check;
  - a running, created, pending, scheduled or waiting job or pipeline is `pending`; a failed one is `failure`, a cancelled one `cancelled`, a skipped one `skipped`;
  - a manual job a person must start, and a pipeline GitLab marks `manual`, is `neutral`, a reported state distinct from a pass, a failure or a running check;
  - a failed job the project allows to fail and a manual job it marks optional read `skipped`, their names saying so, because GitLab's own pipeline passes without them;
  - no matching pipeline yields an empty list, not an expected check inferred from earlier heads or project history; A read GitLab refuses or answers unreadably fails the reading; it is never taken as no checks.
- **Its readiness** (`pull`) reads `detailed_merge_status`: `mergeable` is clean; `conflict` (or `has_conflicts`) is a conflict; `need_rebase` is behind; a draft is a draft; an approval, a discussion, a required pipeline or another rule is blocked; GitLab still checking, or a status the app does not know, is computing.
  A server older than `detailed_merge_status` answers `merge_status`.
- **Its merge** (`putIn`) checks the merge request's title is conventional, then asks `PUT /merge_requests/<N>/merge` with `sha` (GitLab refuses 409 when the merge request moved on), `squash: true` and the squash commit message `<title>`, a blank line and the description.
  A saved story ("Saved change stories" below) gives its plain summary and breaking-change footer in the description's place.
  A 200 is not a merge on its own: an answer that does not read merged is read back once; a merge request GitLab has locked while it merges is a transient answer the merge path reads back again, and anything else but merged is refused with GitLab's `merge_error`.
  A locked merge request reads open and computing, never closed.
  GitLab's 405, 409 and 422 are `refused`; the kept approval reads the merge request's own readiness for the cause, and the feed recognises 422 "Branch cannot be merged" as a conflict.
- **A 401 is not always a sign-in.**
  GitLab answers 401 when a working key may not accept a merge request; the client then asks `GET /user` with the same key, and a key GitLab still answers for makes the refusal `permission`, while only a key it refuses there is `sign-in` and asks the health service to look again.
- **Its words** name the host: "Merged !4 on GitLab.", "gitlab.example.com holds it for a required review or another rule on the main branch", "the app's GitLab sign-in is needed" - `forgePlace` and the forge's label, never GitHub by default.

Evidence: `tests/gitlabStub.test.ts` drives the real forge against the e2e stand-in on both host kinds (open, find, close, every check rule above, the stale-head, conflict and closed refusals, the squash and its message), `providers/gitlab/gitlabForge.test.ts` holds every readiness status, the merge read back and the 401 rule, `changeMerge.test.ts` ("a merge request on GitLab") and `settleOwners.keptMergeRepairs.test.ts` (a kept GitLab merge approval waiting on GitLab's rules, then merging) hold the delivery path, and `tests/e2e/gitlab-delivery.spec.ts` runs the journey on gitlab.com and a self-hosted server: a crewmate's merge request, its pipeline as the card's checks and the captain's squash merge at the pushed version, and a moved head, a conflict, a failed pipeline, a running job, a manual job nobody started and a failed merged-results pipeline each merging nothing.

## A computer's own sign-in

A computer that runs work (`docs/helper.md`) signs in to GitHub for its own clones and pushes, and never uses this Mac's sign-in; pull requests are still opened, checked and merged from this Mac, with its own (design skill `components/devices/SignInOnAMac`, "GitHub on another device").

- **The same service, there.**
  The computer keeps a `ForgeSignIns` of its own over `work/forges/` (`startComputerForges`, `src/core/helper/forges.ts`), from the same providers as this Mac (`forgeSignInProviders`, `src/core/forge/index.ts`): the same 0700/0600 files, health log, five health rules and renewal of a short-lived sign-in, on that computer's own minute tick.
  This Mac holds no store for it, so it can neither read nor renew it.
- **The device flow runs there, and is drawn here.**
  Settings -> Projects asks `inf:devices:forge-sign-in`, which asks the computer `inf:sign-ins:forge` (`DeviceSignIns`, `src/core/devices/deviceSignIns.ts`).
  The computer asks GitHub for the code and sends it here as a step of the sign-in (`inf:work:sign-in`, a `device_code` notice); the captain enters it on GitHub's page here, and the computer asks GitHub until it says yes and keeps the sign-in.
  Each flow's end reaches whoever started it once (`signIn(host, { onEnd })`), so the computer says signed in, "The code expired.", "Could not reach GitHub - try again." or, for a no on GitHub's page or a Cancel, nothing.
  `inf:devices:forge-sign-out` deletes the sign-in there.
- **What crosses.**
  The computer's sign-ins whole (`inf:work:sign-ins`) carry its `forges`: each host it is signed in to, who GitHub says it is, its health and since when, and each host it offers - never the sign-in.
  The feed says "Mac mini is signed in to GitHub."
  (`device_signed_in`).
- **Its git.**
  Every child the computer starts carries the app's own helper pointed at its `forges/` (`configureComputerGit`; "Git that never prompts" above), so its git answers GitHub with the computer's own sign-in, never prompts, and never reaches another sign-in on that Mac.
  Its clones and pushes themselves are piece 10.
- **Where it shows.**
  Projects lists a row per computer and host under the pointer to Integrations (`settings/DeviceForgeRows.tsx`): "GitHub · octo" over "Mac mini · clones and pushes its own work", or the computer's name over "not signed in to GitHub" with a secondary Sign in, whose code to read shows in the aside under the row.
  This Mac's row then reads "GitHub · octo" over "this computer · opens, checks and merges pull requests".
  A computer older than `FORGE_SIGN_INS_SINCE` says no hosts, so it gets no row.
- **The card, and the typed refusal** (the captain's picks on FI3-1350).
  A project that lives on GitHub set to run on a computer that offers a GitHub sign-in from here and holds none raises the host's own card for that computer, "Sign in to GitHub on Mac mini" (`CardService.addDeviceForgeSignInCard`, its words `src/shared/deviceSetup.ts`): "website runs on Mac mini now.
  Mac mini needs its own GitHub sign-in to clone it and push." and "Its next task waits for it.
  This computer's GitHub sign-in is not sent there.", with one button that opens Settings -> Projects with that computer's sign-in started under its row (`forgeSignInOn`); the feed says "website's next task waits for Mac mini's own GitHub sign-in." once per project and computer.
  It is raised when Runs on names such a computer (`DeviceSetup.runsOnChanged`), when a task is about to start there (`TaskPlacement.placedWaitFor`, before anything is tried), and when that computer's clone is refused: the computer answers `inf:working-copy:prepare` with `{ refused: "forge-sign-in", host, name }` rather than a failure's words (`SessionHost`, from `forgeAuthRequired`), the home reads it as `ForgeAuthRequiredError` (`PlacedCopies.prepare`), and the task waits behind `forge-sign-in:github.com@<device>`, never this Mac's own GitHub card.
  While that computer's setup card is on the stack (`docs/devices.md`, "Finishing its setup"), its own GitHub row asks instead and no second card goes up.
  The moment the computer reports its GitHub sign-in, the card comes down and every task held for it starts (`TaskPlacement.resumeDeviceForgeSignInTasks`).
  A computer too old to offer the sign-in from here is tried, and a refusal there holds the task the same way.

## Workflow logs and artifacts

Crewmates collect CI diagnosis and measurement evidence through the app's own sign-in.
A program the captain asks a crewmate to run still runs; these tools do not read another program's sign-in.
`read_workflow` and `download_artifact` are entries of the same runtime-neutral tool spec as `open_change`; both Pi and Claude receive them, including project answer tasks, never personal-workspace tasks.
The supervisor binds the task id, `WorkflowEvidenceService` resolves its registered project and working copy, and the optional `Forge.workflows` capability reads only that project's GitHub Actions API, or its GitLab pipelines, using the existing app-owned sign-in.
Reads do not record a CI reading, classify a failure, reserve a rerun, spend a repair, or modify a workflow.
A short read does keep the run's failed jobs on the repair ledger, so `check_change` takes a diagnosis or an evidenced rerun declaration for one of them with no pull request ("A workflow run's failures" below).

- Listing runs and artifacts is still `github_read`'s job (see the gateway below): `GET /repos/{owner}/{repo}/actions/runs?head_sha=<full commit id>` lists a version's runs, an untouched-main commit gives the baseline comparison, and `/actions/runs/{runId}/artifacts` lists artifact metadata.
  A named run's jobs are the short read below, not a jobs page the crewmate has to page itself.
  The log and the artifact ZIP stay on these two tools, because GitHub answers both with a redirect to signed storage, which the gateway never follows, and neither is JSON.
- `read_workflow({ runId })`, with no job, answers a short read: the run's name, state, version, link and attempt, then one line per job of the latest attempt, with that job's number, name, state, and where a failed job failed.
  `ForgeWorkflows.jobs(runId)` reads `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs?filter=latest`, 100 jobs a page, up to ten pages.
  A remainder past those pages, or past the answer's length, is named as how many jobs were left out.
- `read_workflow({ runId, jobId, offset?, limit? })` verifies job membership and returns the run/version, job/steps and log lines (1-based offset, default 200 lines, max 500, 20,000 characters of line content).
  `nextOffset` continues the read.
  Lines over 2,000 characters are explicitly clipped.
  A complete log over 8 MiB is refused rather than silently represented as complete.
  Logs and artifact contents are untrusted evidence, not instructions.
- `download_artifact({ runId, artifactId })` verifies artifact membership and expiry, then saves the unchanged ZIP at `.infinitary-artifacts/run-<runId>/artifact-<artifactId>.zip` inside the task's working copy (0700 folders, 0600 file).
  A task on a computer that runs work has its working copy there: this Mac downloads the artifact and that computer writes it, with the same rules (`docs/helper.md`, "Its working copies").
  It returns the version, metadata, relative path, actual bytes and SHA-256.
  No automatic extraction, user-controlled destination, artifact-name-derived path, symlink folder or overwrite; do not commit these downloaded archives.
  Downloads are bounded to 64 MiB by metadata and actual response size.
- On GitHub an artifact of any size is also read in parts (`ForgeWorkflows.archive`, `src/core/forge/zipParts.ts`), with the same membership and expiry checks.
  `download_artifact({ runId, artifactId, list: true, files?, offset? })` reads only the archive's end and its central directory and answers its files by path, each with its packed bytes (what saving it reads) and unpacked size, `files` narrowing it and `offset` paging it with `nextOffset`.
  `download_artifact({ runId, artifactId, files })` reads only the named files' own records, a folder's path taking everything under it, and saves them unchanged as a smaller ZIP at `.infinitary-artifacts/run-<runId>/artifact-<artifactId>-<part>.zip`, `<part>` the first twelve hexadecimal digits of its SHA-256, with the same folder and overwrite rules.
  The answer names how many files each path took; nothing is inflated, and no file is written by an entry's own name.
  The 64 MiB bound counts the selected records, before any of them is read, and the central directory's own size.
  Each part is a Range request to the signed address the first one reached, each within its own 30-second request bound, and must come back 206 with a `Content-Range` naming the artifact's size; storage that sends the whole archive instead is refused.
  GitLab answers that its host cannot list an artifact's files, and a split archive is refused.
- `download_artifact({ runId, artifactId, file })` on GitHub names exactly one non-folder member and streams it directly into the task's evidence folder, without the buffered ZIP's 64 MiB limit.
  It cannot be combined with `list`, `files` or `offset`; duplicate member names and missing files are refused.
  Stored and deflated members, including ZIP64, are read in 1 MiB ranges, unpacked incrementally, and checked against the declared unpacked size and CRC before publication.
  The host chooses a safe name from the run, artifact and member-name digest, retaining only a simple extension; member paths never become filesystem paths.
  The answer carries the run/version, artifact, original member, absolute evidence path, actual bytes and SHA-256, with `extracted: true`.
  A partial or corrupt local download is removed; an existing destination, a linked evidence folder or a linked destination is never overwritten.
  On another computer, the home stages the verified file in task temporary storage and reuses the bounded source-file transport with `evidence: true`; the receiver verifies size and SHA-256 before publishing in evidence, and the home removes staging even after transfer failure.
  Incomplete receiver pieces stay only in the task's temporary folder until a deliberate resumed transfer or task cleanup; they are never reported as complete evidence.
  A computer on an older contract major takes no work from the home, so this mode never falls back to downloading the whole archive.
  This evidence-only transfer has no total-size cap; other source-file transfers retain their 1 GiB bound, and disk space or an expired signed address can still stop a download.
- Download redirects are followed manually with a 30-second request bound and at most three redirects.
  The app's sign-in is sent only to the initial GitHub API request, never signed storage; production accepts only HTTPS GitHub-owned storage or Azure Blob storage.
  Neither signed URLs nor sign-in material is returned.
  Local development stand-ins may redirect within their API origin.
- Missing sign-in, a 401, permission/rate-limit refusal, missing/expired evidence, unsupported hosts and bounded-download failures are explanatory tool results.
  A 401 asks the existing health service to look again, never signs the person out on its own.
  The crewmate reports a sign-in blocker rather than looking for another account.
  Missing evidence is no attribution proof.

On GitLab (`providers/gitlab/workflows.ts`) a run is a pipeline, a job one of its jobs, and an artifact a job's artifacts archive, named by the job's id:

- Listing pipelines is `github_read`'s job here too: `GET /projects/<url-encoded group/name>/pipelines?sha=<full commit id>` lists a version's pipelines, and a job's artifacts stay on that job.
  A pipeline's jobs are the same short read: `read_workflow({ runId })` with the pipeline id and no job.
  `ForgeWorkflows.jobs` reads `GET .../pipelines/{id}/jobs`, which leaves retried jobs out, 100 a page, up to ten pages, and names a remainder the same way.
- `read_workflow({ runId: <pipeline id>, jobId })` reads the pipeline (`GET .../pipelines/{id}`) and the job (`GET .../jobs/{id}`), refuses a job from another pipeline, then reads `GET .../jobs/{id}/trace` under the same bounds.
  GitLab keeps the terminal's colour codes and its collapsible-section markers in the log it serves; the lines come back without them.
  The job has a `stage` and no steps, and both attempts read 1: a retried job is a new job with its own id.
- `download_artifact({ runId: <pipeline id>, artifactId: <job id> })` refuses a job from another pipeline, a job with no archive (expired once `artifacts_expire_at` has passed) and an archive over 64 MiB by its size, then saves `GET .../jobs/{id}/artifacts` at `.infinitary-artifacts/run-<pipeline id>/artifact-<job id>.zip` with the same rules; `expiresAt` is null for an archive GitLab keeps until someone removes it.
- GitLab sends an archive from object storage through a redirect (`GitLabClient.download`): up to three are followed by hand within the 30-second bound, the key goes only with the first request to the API, and a next address must be the API's own origin or known artifact storage over HTTPS - gitlab.com's `cdn.artifacts.gitlab-static.net` and Google Cloud Storage, and Amazon S3, Azure Blob and Google Cloud Storage for a self-hosted server (`isArtifactStorage`).
  A server that keeps artifacts on other storage, such as its own MinIO, is refused as an unsafe download.
- A 401 asks GitLab who the key is (`GET /user`): only a key it no longer answers for is a sign-in, which asks the health service to look again; otherwise it is a permission refusal.

Evidence: `src/core/forge/providers/github/workflows.test.ts` drives the actual tool entries through the task service and real HTTP stand-in, lists runs, failed steps and artifacts with `github_read`, checks log continuation, verifies the archive bytes/hash/mode, and exercises authorization, membership, expiry, byte limits, unsafe redirects, linked folders and overwrite refusals.
Its parts tests list and select files from an archive past 64 MiB built from records of a real phone-logs artifact (`tests/fixtures/forge/phone-logs-sample.zip`) and a 64-bit one (`phone-logs-zip64.zip`), unpack the selection with an independent reader, and hold the bytes read under 1 MiB.
`tests/e2e/forge-signin.spec.ts` commissions a crewmate in the hermetic app with the app's sign-in, lists the version's run, jobs and artifacts with `github_read`, reads a failed measurement job, downloads and reads the ZIP's JSON, and separately proves missing sign-in reports a blocker without an Actions request.
`crewmateTaskTools.test.ts` holds the Pi and Claude tools to the same callbacks, descriptions and schemas.
`src/core/forge/providers/gitlab/workflows.test.ts` drives the same tool entries over a GitLab stand-in - the version's pipelines and jobs with `github_read`, a log paged without colour codes, the archive saved from signed storage the key never reaches - and every refusal: another pipeline's job, a missing, expired or oversized archive, a 401 by whether GitLab still answers for the key, an unknown redirect, and the bounds; `tests/gitlabStub.test.ts` reads the e2e stand-in's log and archive on both kinds of host, and `tests/e2e/gitlab-delivery.spec.ts` has a crewmate on gitlab.com and on a self-hosted server list a failed pipeline, read its job's log, save and read its archive, and be refused a write to another project.

## The gateway (`github_read`, `github_write`)

The captain's plan (FI3-70, locked 25 Sep): crewmates reach the rest of a project's GitHub REST API through the app's own sign-in.
Use this connection for the crewmate's own GitHub work.
When the captain's own words ask a crewmate to run a program, that rule is in the crewmate prompt.
Two entries of the runtime-neutral tool spec, both Pi and Claude, served by `GithubGatewayService` (`src/core/orchestrator/githubGateway.ts`) over the optional `Forge.api` (`src/core/forge/api.ts`): each host's raw call, its own policy (`route`) and its next page (`nextPath`).
On a GitLab project the same two tools reach GitLab's API (below); they keep their names, because GitLab's paths are not GitHub's and a crewmate names the one where its project lives either way, and a renamed tool would break every crewmate session that already holds them.
`github_read` (GET/HEAD) and `github_write` (POST/PATCH/PUT/DELETE) go to any non-personal task; a task that only answers starts or reruns a run on its own project at once, and every other write it makes asks the captain (below).

- **Reads reach what the sign-in may read; writes go at once only to the task's project.**
  `path` is a relative path checked by `parseApiRequest`; the caller never names a host, token or header.
  A read that passes the shape checks is sent, and the host's own status and answer come back (FI3-1571 piece 3): there is no read list.
  That reaches the person's account, organizations, notifications and members as well as every repository the sign-in can see; the sign-in's own permissions decide.
  A write to `/repos/{owner}/{repo}/...` of the task's registered project, from a task that ships a change, is sent at once; the policy routes it as `own`.
  From a task that only answers, only a start or rerun of a run on its own project is sent at once: a workflow dispatch or a run or job rerun on GitHub, a pipeline start, a pipeline or job retry or a manual job's play on GitLab (INF-729, the captain's way D, so a nightly check starts with no click).
  Such a start may be a release workflow, as a building task's already may.
  Every other write is kept for the captain's click ("A write that asks", below).
  A task with no project, or whose project lives where the app has no JSON API - kept on this computer, or on a plain Git host - reads and asks through the github.com sign-in (`accountForge`).
  No GraphQL (`/graphql` is refused for reads and writes alike, and never becomes an ask).
  A release file is not this JSON body: it goes through `github_write`'s `file` field ("Release files", below).
  Private content from any repository the sign-in sees can reach the crewmate; an organization that has not approved the app still hides its private repositories.
  The captain chose this on FI3-1309 for repositories and on FI3-1571 for everything else the sign-in may read.
  Traversal, encoded separators or dots, empty segments, fragments, repeated query keys and `per_page` over 100 are refused.
- **Merges and the default branch use the merge card.**
  Raw writes that merge a pull request or branch are refused before send, including GitHub's asynchronous merge and merge-upstream calls, with a pointer to `check_change pull` and `request_merge`.
  A ref update, creation or deletion, branch rename, or file/commit write that moves the default branch is refused too, as is changing which branch is the default.
  The gateway reads the current default branch where the project lives when a write can touch it; an unreadable default branch never grants permission.
  Other branches remain available, including their ref updates and deletion; git pushes remain governed by the task's brief, outside this gateway rule.
  Workflow operations, workflow-file edits on another branch, repository dispatches, other project settings, permissions, secrets, keys and hooks go through the same API.
  The crewmate must still act only within the captain's task.
  A write to account or organization administration (keys, emails, members, settings, billing, `/enterprises/...`) is never the task's own, so it asks like any other.
  This is not a workflow-specific exception or a filename allowlist.
- **Caps.**
  A JSON request body is 256 KiB, one answer 256 KiB (never cut), a JSON call times out at 30 s, and a task may make 200 calls per app run.
  A read whose answer passes 256 KiB is paged rather than refused when its answer is one list: the gateway holds the answer whole up to 100 times the cap, finds the largest page of that list that fits, and reads it again at that `per_page` (`smallerPage`, `src/core/forge/api.ts`).
  The smaller page keeps the asked page's place: its size divides the items before it, so its `page` starts at the same item, and the host's own link names the next page at that size.
  A read that names no `per_page` asked for the host's default page size (`ForgeApi.defaultPerPage`: 30 on GitHub, 20 on GitLab).
  Each try is one of the task's calls, and each smaller try asks for fewer items, so the tries end.
  The answer's note names the `per_page` it was read at, and its `nextPath` goes on at that size.
  An answer no smaller page would shrink is refused with the reason: one object, a list that ignores `per_page`, a first item that alone passes the cap, a page not named by number, or an answer past the hold.
  An answer within the cap that is still longer than a crewmate's model takes whole, 50,000 characters, reaches the crewmate as a file in its task's temporary folder whose path the answer names (`docs/claude-client.md`, "Complete task reads through the tool-result cap").
  A release file has its own 2 GB cap and a 30-minute send ("Release files", below).
  Redirects are never followed.
  The answer carries the status, request id, rate limit or retry-after, and `nextPath` whenever GitHub's next page stays on the API origin and under its own path - including a repository listing's `/repositories/{id}/...` pages (FI3-1546).
  An absolute link in the answer's body loses a `token` or `access_token` query parameter before the crewmate or any saved file sees it; the file's content stays, and the answer says the download tokens were removed.
  A nonempty `temp_clone_token` field, which GitHub puts on a private repository's answer, is left out at any depth the same way, and the answer says the temporary clone tokens were removed; an empty one, as on a public repository, stays.
  Tokens already saved are left where they are.
  A GitHub refusal (422, 404, 403) is a status in the answer; a 401 asks the health service to look again.
  Apart from a smaller page of an oversized list, nothing is retried for the crewmate.
- **Release files.**
  `github_write` takes an optional `file`: a regular file in the task's working copy, relative to it, never a link anywhere on the way.
  With `file` set, the method is POST and `body` stays out.
  The gateway streams the bytes through `ForgeApi.upload`.
  On GitHub the path is the release's own `upload_url`, or `/repos/{owner}/{repo}/releases/{id}/assets`, and it is accepted only on that host's upload origin: `uploads.github.com`, `uploads.<name>.ghe.com`, or a GitHub Enterprise Server's `/api/uploads`.
  A GitHub Enterprise Server address is accepted only under that `/api/uploads` prefix, which is removed before the path is checked.
  An unpackaged stand-in sends to the API base the test pointed at, never to GitHub.
  The file's type comes from its name, and a file over 2 GB is refused before anything is sent.
  A missing `name` query is filled from the file's name.
  On GitLab the path names the release, `/projects/{id}/releases/{tag}`.
  The bytes go to that project's generic package registry, under the package `release` at that tag, and a link on the release points at that package file.
  A server whose package registry is not available is refused in plain words, and no release link is created.
  The file stays within the same 2 GB cap.
  The own-project and ask rules stay: a file for another project is kept, and the click reads the file then, so the ask stores the path and not the bytes.
  A task running on another computer is refused, because the file is in that computer's working copy and the call is sent from here.
- **Reading a project's pull request history.**
  A `/pulls` page carries two repository objects and the whole description of each pull request, so on this project even 15 to a page passes the 256 KiB cap and comes back as a smaller page.
  `/repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc` lists pull requests too, each with `pull_request.merged_at`, and 30 to a page fits here, so it pages in fewer calls.
  GitHub names a repository listing's next page by repository id (`/repositories/{id}/...`); that answer's `nextPath` reads it, so the crewmate pages on without adding `page=N` itself (FI3-1546).
  File-level work belongs in git, not the API: `git fetch origin '+refs/pull/<n>/head:refs/remotes/pr/<n>'` brings a pull request's head into the working copy through the app's own sign-in.
  `refs/pull/*/head` brings them all, into refs that every working copy of the clone shares.
  `git merge-tree --write-tree --merge-base=<base> <head> <other>` then replays a conflict between two of them with no API call, and a squash merge on the default branch carries its pull request's checked title as its subject.
- **Verification workflow requests reuse the gateway.**
  A crewmate calls `github_write` with `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` and GitHub's normal JSON body, such as `{"ref":"<workflow-branch>","inputs":{"suite":"full","ref":"<exact-source-commit>","task":"<task-key>","reason":"<why the Linux sweep is needed>"}}` for `source-journeys.yml`.
  This Linux-only route retains all eight full-suite groups without Mac tests, signing or packaging; `suite: alone` remains the separate fresh-state pass.
  Before requesting work, read existing same-source checks, including running checks, and reuse applicable evidence rather than duplicate it.
  A manual `verify.yml` full-system request uses `{"ref":"<workflow-branch>","inputs":{"full_system":true,"ref":"<exact-source-commit>","task":"<task-key>","reason":"<named exception; why narrower proof cannot suffice>"}}`.
  A Mac-only request, such as a Mac runner's trial, passes `"mac_only":true` in place of `"full_system":true` with the same source, task and reason: the three Mac jobs run and no Linux job does, and the two selections cannot be combined.
  Both verification profiles include Linux and Mac; `all_journeys: false` narrows Mac journeys, not the broad Mac job, signing or packaging.
  Without the explicit selection, verification stops before expensive jobs; installer-only/reuse routes remain separate and reject a simultaneous full-system or Mac-only selection.
  Main and release reusable callers need no manual selection, and together keep full-system coverage: main runs every check but the old journey set, and every alpha runs every journey or reuses the swept batch's.
  A Linux-only or Mac-only result cannot satisfy their full-system proof, and a request for all Linux tests does not authorize Mac work.
  The caller chooses the workflow, ref and optional inputs its task needs; the host adds no task-branch or input restrictions.
  In this repository, `verify.yml` on request runs only the tests tagged `MAC_ONLY_TAG` on the Mac; a request may pass `"all_journeys":true` to run every journey there, as every alpha does (`docs/testing.md`, "Tests that need a Mac").
  Starting, cancelling, enabling, disabling and rerunning workflows are project operations, not account administration.
  A successful response means GitHub accepted the request, not that checks passed; find its run with `github_read`, confirm `head_sha`, then take a short `read_workflow({ runId })` read to watch that run and end the turn.
  Use `check_change` separately for a pull request's checks.
  Dispatch itself changes no check or repair facts.
  A write whose outcome is uncertain is never retried automatically; read the project's state before deciding what happened.
- **Accepted reruns refresh the checks.**
  `POST .../actions/runs/{id}/rerun`, `.../rerun-failed-jobs` and `.../actions/jobs/{id}/rerun` are available without a gateway reservation veto, like other project operations.
  On acceptance, the gateway dates an existing unspent reservation when this rerun is the one it reserved: a rerun of the workflow run a run-bound reservation names (the route's run, or a rerun job's own `run_id`), otherwise a rerun at the change's current head; it neither invents repair history nor rewrites a previous receipt.
  It then takes the crewmate's check reading up to three times, two seconds apart, until the rerun reads as running, arming the ordinary check watch.
  The crewmate still follows its CI diagnosis and evidenced-flake rerun instructions; those govern its work, not which GitHub endpoints exist.
- **Not built yet:** automatic retry of safe reads.

Operations send their own project’s writes at once, like code changes, but receive no pull request delivery tools.
Outside-project and account writes retain the same consent boundary.

### A write that asks

FI3-1571 piece 4, the captain's answers: the crewmate asks, and the app adds the exact call and the button; a task that only answers asks for every write it makes but a run start or rerun on its own project (INF-729 way D); GitLab follows the same rule.
`github_write` keeps, instead of sending, a write outside the task's own project, any other write of a task that only answers - cancelling a run included - and any write through the github.com sign-in.
The merge guard runs first: a merge or default-branch move on the task's own project is refused with its pointer to the merge card, asked or not, and so is deleting a GitLab project or a GraphQL call.
The kept write is a `WriteAsk` on the task's delivery facts - its host, whose sign-in sends it (`project` or `account`), the method, the policy's path, the JSON body, and for a release file the path of that file in the working copy - kept through `TaskService` (`keepWriteAsk`), newest first, at most 8 (`WRITE_ASK_CAP`).
An integration's action that changes or sends is kept in the same list as an ask of kind `integration`, carried by the same `request_write` card and taken once by the same click, which runs it through its integration rather than this gateway (`docs/integrations.md`, "The rules").
A release file's bytes are read when the click sends it, not when the ask is kept.
The answer names the ask's id and tells the crewmate to put it on a card.
`emit_card` takes an action whose effect is `{ kind: "request_write", ask }`, beside the crewmate's own Not now and its words on why.
The emit refuses an ask that is not the task's or was already taken, two asks on one card, and an ask beside a merge or discard; only a crewmate's card on its own task may carry one.
The host names the button "Send it to GitHub", after the host's own name ("Send it to GitLab", or a server's address), and draws the exact call at the end of the body (`.inf-call`, `writeAskStrip`): the method and path, the JSON body as kept, and whether it goes through the github.com sign-in.
A card that asks is never a task's answer: the captain's click on it leaves an answer task open.
Only the captain's click from the card's own controls sends it (`GithubGatewayService.sendAsk`); a script on the card, a reply, the who-merges setting and the first mate never do.
`TaskService.delivery.takeWriteAsk` marks the ask taken in one transaction before anything is sent, so a second click, a restart or a revised card naming it sends nothing again, and the emit refuses it.
The click sends exactly what was kept, through the same sign-in, after the same policy and merge guard; a host that changed since the ask sends nothing.
It spends one of the task's 200 calls only when it is sent.
The outcome is recorded on the ask: the host's status, nothing sent (a refusal or a missing sign-in), or unknown - a call that may have reached the host without an answer - which is never sent again.
The crewmate hears it once (`write-answered`), with the host's answer within the gateway's caps, and the task's timeline keeps one line.
A task's close drops its asks that were never sent.
A crewmate on another computer asks the same way: its write and its card reach the home, which keeps the ask and sends it (protocol 5.0, `docs/contract.md`).
Evidence: `tests/e2e/forge-signin.spec.ts` - a write to another repository, a project kept on this computer creating its GitHub repository through the github.com sign-in, and a task that only answers writing to its own project - each shows the exact call on the card, nothing sent before the captain's key, one request after it, the crewmate hearing the answer, and the same ask on a revised card refused; `tests/e2e/gitlab-delivery.spec.ts` keeps a write to another GitLab project unsent.
The gateway tests (`src/core/forge/providers/github/gateway.test.ts`, `src/core/forge/providers/gitlab/gateway.test.ts`) send a task that only answers' run start and rerun at once, watch the run, and keep its cancel, its other writes, a start elsewhere and a start through the github.com sign-in.

### On GitLab

`GitLabForge.api` sends the same requests to `https://<host>/api/v4` with the app’s own sign-in there, under GitLab's own policy (`providers/gitlab/api.ts`), with the caps above.

- **Its paths.**
  A project is `/projects/{id}/...`, `{id}` its number or its URL-encoded path (`group%2Fsubgroup%2Fname`); `%2F` is accepted in any segment, as GitLab's project and group ids, file paths and branch names need, and every piece a segment decodes to is held to the same rules as a segment, so `..`, an empty piece, an encoded dot, backslash, percent sign or null, and a trailing slash are refused.
- **Reads** reach whatever the key may read, as on GitHub: there is no read list (FI3-1571 piece 3).
  That includes the key's own account, a group's members and the instance's administration where the key may read them.
  GitLab returns CI/CD variables' values, a project's or a group's, to a key with a maintainer's role, where GitHub returns only secrets' names; the captain accepted that with one rule on both hosts.
- **Writes** go at once only to `/projects/<the task's own URL-encoded path>/...`; one that names a project by its number, or any other project, the key's account or a group, asks like any other write, and the ask names the path to use when it is the task's own.
  Deleting a project itself is refused, as the app's GitHub sign-in cannot delete a repository (it holds no `delete_repo` scope).
  Raw merge-request merges, default-branch deletion, and file/commit writes on the default branch are refused with the same pointer to the merge card; writes on other branches still reach GitLab.
  On every GitLab host, the task's own merge request is opened, and its saved description replaced, only through `open_change` ("Saved change stories").
- **Reruns**: `POST .../jobs/{id}/retry`, `.../jobs/{id}/play` and `.../pipelines/{id}/retry` are reruns: an accepted one records an existing reservation and arms the check watch as on GitHub.
- **Its answers** carry GitLab's `x-request-id`, its `RateLimit-Remaining` and `RateLimit-Reset`, `Retry-After`, and `nextPath` whenever the next page stays under the server's own `/api/v4`.
  A redirect is refused, and a 401 asks GitLab who the key is before it asks the health service to look again.
  An absolute link in the answer's body loses the same `token` and `access_token` query parameters as a GitHub answer, before it is saved.
  Refusals and the call budget name the host: "Cannot call GitLab", "Cannot call gitlab.example.com".

Evidence: `src/core/forge/api.test.ts` (the policy) and `src/core/forge/providers/github/gateway.test.ts` (the tool entries over a real HTTP stand-in, including caller-selected refs/inputs, project operations, reads of other repositories, search and the account, a task with no project, GraphQL and account-write refusals, the rerun arming the watch, a private file read that keeps the file and drops GitHub's download token, and a private repository read that drops its temporary clone token), and the journeys in `tests/e2e/forge-signin.spec.ts`: the verification requests (an existing disposable ref with workflow inputs, app-owned sign-in, queued run and cancellation, account-scope refusal and missing sign-in), and a project kept on this computer reading the person's notifications and a repository listing's `/repositories/{id}` next page through the github.com sign-in, with GraphQL never sent.
GitLab's are `src/core/forge/providers/gitlab/api.test.ts` (its policy: encoded paths, reads anywhere, account writes kept out, own-project writes, the project's deletion, reruns and next pages) and `src/core/forge/providers/gitlab/gateway.test.ts` (the tool entries over a GitLab stand-in: reads by encoded path with GitLab's ids, allowance and next page, other projects' reads, refused writes, a 401 by whether GitLab still answers for the key, a job retry arming the watch, redirects, oversize, a missing sign-in and the budget).

## The app's own git (phase 2)

The owner's verdict: git is bundled with the app, the GitHub Desktop model, because most people who use Infinitary have never installed developer tools, and a Mac without them has no git a Dock-launched app can run.

- **What ships**: dugite-native's macOS git, pinned by the `dugite` dependency's own manifest (`script/embedded-git.json`, its archive and checksum per platform).
  `scripts/ensure-bundled-git.ts` (postinstall, macOS only) fetches BOTH architectures, verifies each against that checksum, caches the archive under `~/Library/Caches/infinitary/bundled-git/`, unpacks it once into `trees/` beside it, and clones that tree into `vendor/git/darwin-<arch>/` (gitignored); dugite's own postinstall is off (`pnpm-workspace.yaml`), since it fetches only the machine's architecture.
  The clone (`scripts/clone-or-copy.ts`, macOS's `cp -c`, since Node cannot clone there) lets every working copy on APFS share the tree's blocks; a disk that cannot clone gets a plain copy.
  Git Credential Manager and its .NET runtime are left out - another sign-in that could answer or prompt for a host, which the owner ruled out - and so is git-lfs, which nothing under the app configures.
  The same postinstall builds the launcher a crewmate's shell runs that git through: `scripts/git-launcher.c`, compiled by `scripts/build-git-launcher.ts` with Apple's developer tools for both chips in one file, into gitignored `vendor/git-bin/git`, and rebuilt only when its source changes.
  It is a compiled program, not a `#!` script, because macOS 26 keeps a 1 KB kernel buffer for each script started from inside a script-started tool, and none for a compiled one.
  Only a Mac that builds Infinitary needs those tools; a person who installs the app gets the launcher built, and a checkout on a Mac without them skips it with a note and runs the system git.
  `electron-builder.yml` ships the two trees outside the archive (`extraResources` to `Contents/Resources/git/`), names them in `mac.x64ArchFiles`, and ships `vendor/git-bin/` beside them as `git-bin/`; the launcher already holds both chips, so the universal merge takes it as it is and it needs no line in `mac.x64ArchFiles`.
  `scripts/check-bundled-git.sh` (run by `scripts/verify-app.sh` at every release gate and by `verify.yml`'s package smoke) fails a bundle without either tree, with the wrong architecture in one, or whose launcher is not a program for both chips, and runs the tree for its own architecture through `git-bin` with an empty environment.
- **Who runs it** (`src/core/workspace/bundledGit.ts`, taken once by each composition with `adoptBundledGit`: the app's own and the work mode's, `docs/helper.md` "Running"): every host git (`git.ts`) runs the tree for `process.arch` by path, with the environment dugite's `setupEnvironment` gives it (`GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM`, which includes the Mac's `/etc/gitconfig`); the person's own `~/.gitconfig` still applies.
  `hostEnv` puts `git-bin/` - holding only the launcher `git`, which runs the tree named by `INFINITARY_GIT_DIR` with the same three variables, or else steps aside once for the next git on the search path - first on every child's search path, so a crewmate's shell, and the shells Claude's client runs, find the app's git first.
  The git sign-in environment above rides every one of those runs unchanged.
- **Without it**: an unpackaged checkout that has not vendored the trees (any platform but macOS), or whose Mac could not build the launcher, runs the git on its search path, as before; `INFINITARY_SYSTEM_GIT=1` asks for that on purpose in dev and e2e, and a packaged app ignores it.
- **A limit**: Apple's git reads its own system config, which names the Mac keychain's credential helper; the app's git does not, and that helper is not part of it.
  A plain host reached over `https://` whose sign-in only that helper held now answers nothing under the app (git fails at once, never prompts).
  GitHub (the app's sign-in), SSH origins (the person's agent) and helpers named in the person's own `~/.gitconfig` with a path are unaffected.

## Check facts and crew judgment

`check_change` reads the newest change through the forge and returns a `facts` JSON object: the change's id and base, the version, whether it moved since the recorded reading, mergeability as the host reports it, and each check's name, state, run, workflow and event where available.
It takes the change's id (`change`) and refuses another task's; a task reads only its own change (INF-1868 piece 2, INF-1873).
A pull request's checks are the runs the host started for it (INF-1891, the captain: "for merge we only care about the PR checks"): on GitHub a check whose run carries an event stays only when that event is `pull_request` or `pull_request_target`, so a run a person or a tool started on the branch by hand, such as a dispatched heavy check, is read through `read_workflow` and never holds or passes the merge (`ownChecksOf` in `src/core/forge/forge.ts`); a check with no event, such as a commit status, stays as read, and a branch's own checks, read with no number, keep every run at their version.
When a reading of the task's own pull request finds a check red, the same reading asks the host for the default branch's own checks (`Forge.branchChecks`) and records that branch's newest run of each failed check beside the reading - its version, when, and each check's state there (`TaskDelivery.mainChecks`, `facts.main`, `ChangeChecks.main`; INF-1915 fix 1).
That is evidence about the failure's cause for the crewmate's diagnosis and the completion card, never a merge input: the merge boundary does not read it, a default branch that fails the same check passes nothing, and a selected pull request gets none.
The completion card's checks hold does read it (`docs/delivery-rigor.md`, "Check facts and declarations"): when that branch's newest run of every failed check at the offered version failed too, the card goes up at once, says so under its Checks cell and offers Merge anyway, so the crewmate spends no rerun and asks for no reopening; the merge is still the captain's click.
The evidence is kept while the same checks fail at the same version, read again when the failures change, and cleared by a reading with no failure; a host that cannot read a branch's checks, or a read that fails, records none.
GitHub check runs retain their reported status, conclusion and available run identity.
The captain’s F26 choice restores the existing exception for a cancelled duplicate: a later run of the same workflow and event decides that check of the same name; unrelated and latest cancellations still count.
No observed checks or workflow runs yields an empty list.
The restored cancellation filter keeps a replacement pending while its known later workflow run has not created that check; it does not invent a successful check.
The reading identifies incomplete lists rather than inventing a check for a physical read limit.
An empty hosted reading stays pending and watched until checks register or the crew records positive, exact-version absence evidence through `absentChecks`, with `pull` or, for the task's own pull request, alone (INF-1955: `CheckChangeTool.declareOwnAbsence` matches it to the pull request the task's branch holds, by number, branch and version, and stores it on an owned merge review).
A declaration the record cannot match - no open pull request yet, another version, a host that runs no checks - is refused in words, never dropped; the completion card's checks hold names the declaration when an empty reading holds the card.
That evidence names an explicit no-CI policy from the trusted default branch and the applicable local gate; elapsed time, history and missing workflow files are not evidence of that policy.
A host that runs no checks, such as a plain Git host, needs no invented hosted check.
An absence declaration never removes registered checks from the reading or marks them passed.
The completion strip, shared task facts, task record Activity and first-mate facts show the reported check facts for their recorded version, never a newer unread version.
A lasting refusal to list workflow runs stays on the partial reading with its reason, so the task says that all checks cannot be read rather than silently appearing complete or endlessly running.
A lasting unreadable reading has no running duration, and the check watch reports it through its unreadable outcome rather than claiming the checks are still running.
A typed transient read failure preserves the existing bounded watch and its retry clock, including on a crewmate’s own read (F25).
A refused default-branch reading also appears on each task waiting on those checks, without sending a non-final default-branch wake.

The crewmate's merge offer itself expresses its judgment that the work is ready.
There is no separate ready/red declaration, current verdict cache or verdict cell.
The offer neither marks failed checks passed nor authorizes a merge: actual check facts still hold it and the captain still gives separate consent.
The crewmate declares only `flake` or `settled` with its version and evidence using `declaration`.
Older ready/red declarations remain history and grant no authority; the old current cache is ignored without rewriting that history.
A settled declaration names a recorded repair and its outcome; raw check reads never settle, void or supersede repairs.
The host places no repair, review-round or rerun count hold.
The delivery judgment is the delivery runbook's (`resources/runbooks/delivery`) and what each care asks is the care runbook's (`resources/runbooks/care`); the crewmate's core prompt carries the consent rule and the facts alone (`docs/runbooks.md`, "Built-ins").

The merge boundary still checks the captain's authorization or standing autonomy, the exact approved change and version, GitHub's rules and mergeability, and the send-once result.
The sign-in, consent and unknown-outcome boundaries are unchanged.

## A requested merge

`request_merge` is the agent-facing request to merge one reviewed pull request (FI3-1543).
`check_change` with `pull` stores a review of that number in the task's project and returns its id.
Any open pull request there may be named, whoever opened it: naming it makes it one of the task's changes (INF-2490, [changes](../primitives/changes.md)).
Preparing the review grants no approval and merges nothing.
A review on another branch becomes the task’s current change, its explicit check target (`delivery.checkTarget`), so status, `check_change` and the check watch follow that pull request’s branch and number rather than the task’s own branch (INF-1246).
Opening the task’s own change, selecting its own pull request or naming its own change id returns status to its own branch.
The task's single pull request fields then name its own pull request at its own head, keeping none of the other pull request's number, head or checks; opening it names none until the opened pull request is noted.
Every change id a reading reports is the id of the change it read, so passing it back selects that same change; a change whose review the capped list no longer keeps is read again by its number, never swapped for the current one.
`open_change` with `branch` opens or updates the pull request of an existing pushed branch the captain asked for, without moving its head, and that pull request becomes the current change (INF-2184).
A crewmate on a computer that runs work does the same with a branch it checked out there: the home reads its checkout for the story and brings that branch home to read it (`docs/helper.md`, "Reading its branch here").

### A change in another project

`open_change` with `repository` naming another project the app manages opens the change there (INF-2510, the captain's INF-1868 answer: "Only repositories the app manages as projects").
The crewmate pushes a branch to where that project lives and names it with `branch`; the branch needs a name other than the task's own branch, which names the task's own change.
The home reads that branch from the project's host into the project's folder under a private ref (`refs/infinitary/opened/<task>`), beside its default branch, and checks the branch's own commit names there, so a placed task's crewmate needs nothing brought home.
The change opens through that project's host with `body` as its description: it carries no saved story, since `prepare_change` prepares the task's own project's.
The project must be on a host with pull requests (GitHub or GitLab); a plain Git host is refused in words, and so is a name the app does not manage, with the names it does.
The opened pull request becomes the task's current change through a review that names its project (`MergeReview.repoId`), so `check_change`, the check watch, `check_change pull` of that number, the kept approval, the completion card's merge and the reads by number after a merge all go to that project, and the change record keeps it under that project's id.
Its merge follows that project's delivery: a `queue-pr` project's queue holds it as it holds the project's own changes.
Discarding the task closes only the task's own change; the change in the other project stays open.
Evidence: `changePublication.test.ts` (INF-2510) opens, reads and merges a change in a second project through that project's host, and refuses a project the app does not manage.
The card effect `request_merge` names that id.
With autonomy off, only the captain's button authorizes the merge.
A merge card names one change, and the host writes on it whether its click closes the task (`mergeClosesLine`, `src/shared/cards.ts`): "Merging closes this task" on the completion card's settle merge, "The task continues after this merge" on a `request_merge` card, and on a settle merge too while a question or another pull request on the task is open.
A card that carries both is refused.
A `request_merge` merge is a continuing merge, on the task's own branch or any other: it keeps the task and its working copy and wakes the crewmate once.
The completion card's settle merge is the finishing merge: it merges the task's current change, whichever branch it is on, through the same gates, and closes the task as merged.
The captain's words on INF-2525: "if they both got raised, then we should make sure the merge card doesn't close the task directly".
So every merged close shares one rule: a task closes as merged once its finishing change merged and nothing else on it is open - an open question of its crewmate's or the first mate's (`keepsTaskOpen`, `src/shared/cards.ts`), or another of its pull requests that is open or could not be read (`SettleService.stillOpen`).
With one open, the captain's Merge click, the first mate's merge and a kept approval merge without closing the task: the change is recorded as merged, the task, its working copy and its cards stay, and its crewmate hears the merge once with what is still open.
The first mate's close of a change already merged refuses while one is open, and the watch on outside merges wakes the crewmate instead of closing.
What comes next is the crewmate's judgment, never a close the host schedules: the captain's words were "it should become the agent's judgment for what's the appropriate next steps".
A changed head, a failed or unreadable check, or a draft or protected branch sends no merge.
An ordinary requested-merge click keeps the same head-bound approval as a completion click, including for another branch's pull request (INF-1246).
Its immutable review snapshot lives on `delivery.mergeAuthorization`, independently of the capped review list, and the existing repair declarations, guidance hold, revocation and restart reconciliation apply.
A behavior-preserving repair merges only at the accepted head after checks pass; changed work needs a new offer and click.
Both merges read the change's saved story through one owner (`withPublishedStory`), so a kept approval on a story whose repair the host accepted refreshes the story to the repaired version before either merge goes.
A confirmed continuing merge consumes the approval and wakes the crewmate once without closing its task or removing its working copy.
A host merge result is not new captain guidance about that approval.
Only a pull request GitHub reads as clean at the reviewed head is sent, so a sign-in that could bypass the branch's rules never does.
GitHub answers `mergeable: null` while a check it has just started works out a test merge, often just after the default branch moved, and asks to be read again shortly (INF-457).
At the captain's click, that answer is read again after 1, 2, 3, 5, 8 and 11 seconds (`UNDECIDED_REREAD_MS` in `src/core/orchestrator/mergeReviews.ts`), and every read is checked as the first one was.
The merge goes as soon as GitHub reads clean at the reviewed head; a moved head or a closed pull request still sends nothing, and GitHub still undecided after half a minute refuses the attempt, saying how long it asked.
An ordinary click remains kept through that wait, while a closed or replaced pull request ends its approval.
The card's own read before it goes up asks once.
Evidence: `tests/e2e/request-merge.spec.ts` ("... waits while GitHub works out whether it can merge ...") merges an adopted pull request after two undecided answers, and `mergeReviews.test.ts` (INF-457) holds the refusal after the wait and a version that moves during it.
An absence declaration is stored only when it names that exact head, with evidence and a local gate.
It waives only the host's own "checks have not started yet" marker, never a failed, pending or unreadable check.
A confirmed continuing merge wakes the crew once.
Dropping the task does not close another branch's pull request, because the task's own change is still what discard closes.

The first mate's `settle_task merge-pr` merges the task's current change with autonomy on, and is held for the captain with it off.
When that change is already merged where the project lives, it closes the task as merged and sends nothing, with autonomy on or off, once none of the task's other pull requests reads open (`SettleService.otherOpenChange`, over every change the record keeps); one still open, or one that cannot be read, refuses the close in words and the task stays open.
A first mate settle merge card on a task with a saved story is bound to the published story (`CrewSupervisor.bindFirstmateOffer`), so its click passes the same story gate as the crewmate's completion card; before the story is published it is refused.
Evidence: `tests/e2e/request-merge.spec.ts` and `tests/e2e/declared-close.spec.ts`.

### A merge past the branch rules

A merge that skips the branch rules (FI3-1571 piece 2) is the same request, prepared with `skipRules`.
The captain's answer: every rule the account may skip, failed checks included.
`check_change` with `pull` and `skipRules` - the version the crewmate read and `squash` - stores a review on GitHub only, including GitHub Enterprise.
It is stored only at that version, when a rule or a failed check holds the pull request, every check has finished, and squash is allowed.
GitHub must also say this sign-in may skip every rule set holding the default branch: `GET .../rules/branches/{branch}`, then each rule set's `current_user_can_bypass` (always, pull requests only or exempt; `GitHubForge.branchRules`).
A conflict, a draft, GitHub still working it out, or a hold outside the rule sets, such as classic branch protection, is refused.
The review names each rule that can hold a merge, in plain words with its rule set (`mergeRuleWords`), and each failed check; rules that only guard creating, deleting or force-pushing the branch are not named.
The host draws them at the end of the card (`.inf-call`, `src/core/orchestrator/requestStrips.ts`) and names the button "Merge, skipping the rules".
Before the card goes up and again on the click, the host reads it fresh: a moved version, a closed pull request, or a rule or failed check the review did not name sends nothing.
Only the captain's click sends it; who merges, `settle_task` and a kept merge approval never do, and an ordinary review never sets `bypass_rules`.
The review is marked sent first, then GitHub's asynchronous merge goes once (`PUT .../merge-async` with `sha`, `squash`, `direct_merge` and `bypass_rules: true`, at API version 2026-03-10), and its result is read by its id up to five times, two seconds apart.
A result the app could not read, or a transport failure, is unknown, and the pull request is read once to see whether it merged.
Nothing is ever sent again for that review: a second click, a restart or a revised card naming it answers from the record.
Like every `request_merge`, it continues the task.
Not established: whether GitHub honours `bypass_rules` for the app's sign-in, an OAuth App, or on GitHub Enterprise Server.
No real merge past the rules has been attempted; the check is the captain's, on a throwaway repository.
Evidence: `tests/e2e/request-merge.spec.ts` ("a merge that skips the branch rules ...") has a scripted crewmate prepare an adopted release pull request held by a review rule and a failed check, reads the rules and the check off the card, finds nothing sent before the captain's key and one asynchronous merge with `bypass_rules` after it, and refuses the same review on a revised card.
`mergeReviews.test.ts` holds each refusal word for word, the review marked sent before the request, and every outcome of the one send: merged, refused, unknown, a lost answer read back as merged, and a second click that sends nothing.

## A project's queue

A project on GitHub may merge its pull requests through its own queue, a job of the project's that tests approved work together before it merges (INF-2430 piece 2).
It is off by default, and a project chooses it in Settings → Projects or through the first mate's project settings.
A person reads it as "batched pull requests" in Settings and "Batched pull request" on a task (`PROJECT_DELIVERY_WORDS`, `POLICY_DELIVERY_WORDS`).
The app supplies no queue workflow of its own, so while a project has the choice, Settings says the merge waits until the project has one and holds a short how-to behind "How to set one up": the three things the workflow does, that the first mate can write one, and a link to GitHub's guide to commit statuses (`QUEUE_HOW_TO_WORDS`, `src/renderer/src/settings/projectsWords.ts`).
The app's whole contract with any such queue is one commit status, `infinitary/queue` (`QUEUE_STATUS`, `src/shared/repos.ts`), on the pull request's version.
Nothing writes it before the captain's merge click: the pull request's own checks still hold the completion card as they do today.
The click publishes the story and checks the title as any merge does, keeps the captain's approval, and writes `infinitary/queue` as `pending` on the approved version with the words "Waiting for the batch check" (`GitHubForge.markQueued`).
A repair that carries the click marks its new version the same way, once that version's own checks pass.
The mark comes after the same last look a merge request takes - the same approval and head, the crewmate idle, no newer completion card - which records no attempt, since nothing is sent to merge.
Until the queue passes a version, GitHub's rules reading the pull request as held are not a stop: a required `infinitary/queue` status is what holds it, and the mark answers it.
Every route to a merge waits on the queue the same way: the completion card's click, a `request_merge` review the task owns or references, and a merge past the branch rules, whose click marks the version and sends nothing, so the same review merges on a new click once the queue passes.
The project's queue finds the versions marked `pending`, tests them, and sets the status to `success` or `failure` on each, with its reason in the description and a link to the run in `target_url`.
The status is read as one more check (`GitHubForge.checks`), so the check watch follows it, and the kept approval merges only once it reads `success` at that exact version, through the same version guard and with no new click (`ChangeMerge.mergeOnce`).
A failed status wakes the crewmate through the failed-check wake like any failed check; the crewmate reads the batch's reason and link off the status with `github_read`, and its repair declarations decide whether the click carries to the fixed version.
No checks override passes the queue.
While the queue runs, the kept approval waits on `queue`, the pending note reads "Waiting for the batch check", and the tick reads it again every ten minutes past the watch's bound, revising the note's words from what the app now knows of the queue.
A first mate merge on project autonomy marks the version the same way and stops; it keeps no approval, so the first mate merges again once the queue passes.
Evidence: `changeMerge.test.ts` ("merges a queue-pr change only once its queue passes ...") and `githubForge.test.ts` ("marks a version waiting for the project's queue ...").

### What the app reads about a project's queue

Nothing in the app can prove a project has a queue, so it keeps three reads and says only what they found (INF-2886, `src/core/orchestrator/projectQueue.ts`).
The first is the workflow files on the default branch that mention `infinitary/queue`, each with whether it is on (`GitHubForge.queueWorkflows`): GitHub's list of the project's workflows, then each file read.
The app reads them when the batched delivery is chosen, whoever chooses it (`RepoRegistry.onQueueChosen`), and again at each merge click that marks a version; a failed read keeps the last one.
The second is when anything other than the app last wrote the status on one of the project's versions (`queueAnsweredAt`).
The third is whether a waiting version still holds only the app's own mark: the mark keeps the status id GitHub gave it back (`queueMark` on the task's delivery), and any reading of the version's checks whose status is no longer waiting, or carries another id, is an answer.
`RepoRegistry.recordQueue` is the one writer of the first two, on the project's row, and every change reaches Settings as a `repo_queue` event.
Settings → Projects shows a warning under "Where changes go" while the project is batched, its queue has never answered, and no workflow that is on mentions the status (`queueSettingsWarning`, `src/shared/repos.ts`); it clears once one does or the queue answers.
The waiting note warns from the click while the project's queue has never answered, naming what the workflow read found.
On a project whose queue answered before, a version nothing has written for the check watch's two hours says so on the note, and the watch's two-hour wake to the crewmate carries the same fact; the app adds no timer of its own.
Evidence: `githubForge.test.ts` ("reads the workflows that mention the queue status ..."), `changeMerge.test.ts` ("warns on the waiting note ...") and the Settings section of `tests/e2e/queue-merge.spec.ts`.

## The check watch

The host reads a change's checks for the crewmate while they run, with plain forge calls and no model turn (`src/core/orchestrator/checkWatch.ts`).
It wakes the crewmate once when the first check fails and others are still running, and once more when the checks finish.
Before it, a crewmate re-read `check_change` until its checks settled - up to 40 full-context model turns on one task.
The design follows the firstmate repo's PR poll: a watcher that is not a model, bound to the change and its head, never doubled.

- **Armed** by a reading that finds a check still queued or running (`ChangeChecks.record`), on a forge whose `hasChecks` is true: the crewmate's `check_change` or the completion card's CI gate.
  A reading that is only held back by a neutral check arms nothing: nothing is left to finish.
  A plain Git host or a project kept on this Mac has no checks, so nothing is watched and `check_change` says no wake will come; a new forge kind with checks implements `checks()`, sets `hasChecks`, and is watched with no change here.
- **Durable**: the watch is a delivery fact on the task, `ciWatch { head, since, nextAt, tries, failureSeen }`, so it outlives a restart and ends with the task.
  A reading at the head already watched keeps its start.
  `failureSeen` means the early wake for that head already went, or the crewmate already read a red check, so that wake is not sent again.
- **Read** on the shared 60 s tick (`CrewWatch.pollCheckWatches`, through `ChangeChecks.readWatched`): every minute for 10 minutes, then every 2, up to the two-hour bound.
  Every successful reading updates the saved reading time, even when running checks keep the same status and head, so the reading time shown on rest stays current.
  A reading - the watch's, the quiet refresh's or `check_change`'s - records a `ci` event only when it changes the check state: the status, the head, or the repair ledger (a failure first seen there or a crew declaration).
  A reading that changes none of them adds no CI event; it advances the reading time and retains observation-forwarding bookkeeping (`changesCheckState`).
  Raw readings retain named failure history without settling repairs or counting attempts.
- **Quiet refresh** continues every five minutes (`CHECK_REFRESH_MS`) for live tasks with a recorded open pull request, even after a watch ends, using the same reading and delivery facts.
  It runs on the shared tick after a restart too and backs off unreadable checks.
  Changed raw readings retain a durable `ciObservation` identity until a crew tool response or the existing inbox forwards them.
  The quiet reader forwards changed observations once, including across a restart; only the crew's declaration changes readiness.
  Unchanged readings start no model turn.
  The same tick reads each live task's recorded pull request by number, independently of check completion, dependencies or a captain gate.
  A confirmed external merge immediately records `ci: merged`, but PR ownership alone never closes its task.
  The crewmate declares `report.merge_completes_task` with that task's recorded PR number and checked head only when that merge finishes all its work; `TaskService` keeps the declaration until its next turn or report.
  Only that matching declaration, an idle task with no running jobs or pending/in-flight instructions, and the existing child and dependency close checks allow `SettleService` to close the task as merged without a discard or another approval.
  Otherwise the task, instructions, cards and working copy stay intact, and one durable wake per merged version tells the crewmate the merge happened so it can continue or declare completion without asking again.
  An automatic close records the closed state synchronously before awaiting idle runtime shutdown, so new guidance cannot be accepted and then purged during that wait.
  This monitor survives a plain-reply “I'll merge the PR” choice without interpreting the button's words; it follows the task's recorded pull request, not unrelated pull requests reviewed by that task.
  A missing, unreadable or closed-but-unmerged pull request never closes the task, and its named read continues on later ticks.
  A named pull request needs only the project's saved host identity, not a reachable working copy or local project folder.
  A working copy on an unreachable computer remains recorded as present until `PlacedSessions` and `PlacedCopies` save its unmerged work and retire it on reconnection; the task itself is already done.
  It skips a task idle behind another task, the work posture the Tasks dot shows as blocked by another task (`CheckWatcherHost.idleBehindOtherWork`): the host does not read that task's checks while it waits, and its crewmate reads them itself on resuming.
  A settled result or same-head rerun updates displays without a diagnosis wake; a new head whose checks are running arms the ordinary bounded watch.
- **Bound to the head**: a new head where the project lives re-arms the watch for it, and only the head it last saw is woken about.
  A reading the crewmate takes itself that finds the checks finished ends the watch (it already knows); the completion card gate's does not, so the crewmate still hears.
- **Two wakes at most** for one head, each a `checks-settled` steer on the crewmate's own lane, the supervisor's, through the ordinary steer path (it resumes an idle task).
  The first is `first-failure`, naming each red check, while others are still running.
  A read that first sees a failure and also sees the checks finished sends only the end wake.
  The end wake carries the finished check states without a passing verdict; `timed-out`, still running after `CHECK_WATCH_BOUND_MS` (two hours); `gone` (no open change for the branch); `unreadable` (a sign-in, permission or other refusal; a transient failure reads again inside the bound).
  A spent hourly allowance is not a refusal: the watch keeps standing, wakes nobody, and reads again at the reset GitHub named (`ForgeAllowanceSpent.resetAt`, INF-2149); the quiet refresh and the merge read wait the same.
  Each wake is named by the watch and the event (`check-watch:<head>:<since>:failure` or `:end`), and the inbox records the name with the row it queues (`InboxStore.enqueueSteerOnce`), so a restart between the wake and the clear never sends it again.
  A wake recorded before the early wake existed, named `check-watch:<head>:<since>`, still counts as the end wake.
  The watch relays failure states without deciding readiness; the fact reader retains any explicit allowed-to-fail metadata.
  The early wake spends no repair round and does not change how a pull request goes green.
- **The idle ladder** reads a standing watch as the task moving (`Witnesses.checksWatched`, `docs/report-sort.md`): the crewmate that ends its turn to wait is neither nudged nor reported stuck, and its report wakes nobody until the checks finish.
  The early wake does not clear the watch, so the task still reads Waiting for checks.

## A main failure's wake

A pull request held because a check also fails on the default branch hears that branch's own finished checks, without waiting for the named task to close (INF-833 Fix 4), and its crewmate judges whether they clear the wait.
The standing baseline diagnoses name the checks, and so does the recorded default-branch run of each check that fails at the change's current version while a completion offer stands at that version (`TaskDelivery.mainChecks` and `completionOffers`; `standingBaselineChecks` in `src/core/tasks/dependencyWaits.ts`), so a merge card that says a check fails on main too is watched without a diagnosis, and a crewmate still driving its checks hears no wake about main.
On the check watch's tick, one read per project asks the forge for the default branch's checks (`Forge.branchChecks`, `ChangeChecks.readDefaultBranchChecks`).
A reading wakes nobody until it is final: an incomplete reading, a read problem, no checks or any pending check sends nothing (`MainCheckWatcher`, `src/core/orchestrator/mainCheckWake.ts`).
Each waiting task then hears one `main-check-observed` steer per commit, through the ordinary steer path, naming the commit and each check's state; the host declares no readiness, and the crewmate judges whether the reading clears its wait.
The inbox records `main-check-finished:<sha>`, so a restart does not send that commit's wake twice, and a later commit's finished reading does.
The named task's close still resumes the crewmate.
A host without `branchChecks` — a plain Git host, and GitLab until it can read a branch's checks apart from a merge request — keeps that close as the only resume.
A failed read waits out the check watch's slow pause and wakes nobody; on a spent hourly allowance it waits until the reset GitHub named, when that is later.
The same branch reading answers a crewmate's own failed check at once: a reading of the task's pull request that finds a check red records the default branch's newest run of it as evidence ("Check facts and crew judgment", INF-1915 fix 1), so the diagnosis a `baseline-blocked` classification needs starts from a typed fact rather than a second read.

## The checks cell's time

Wherever the app shows a task's checks - the fact strip on the crew summary and the task record, and the merge card's Checks cell - it says how long they have been running, or how long they took, counted by the host's own times (INF-587).
`checks()` keeps each check's start and finish where the host gives them (`ForgeCheck.startedAt`, `finishedAt`): a GitHub check run's `started_at` and `completed_at`, a commit status's `created_at` and, once settled, its `updated_at`, a workflow run not yet listed as a check by its `run_started_at`, and a GitLab job's `started_at` and `finished_at`.
Every reading writes `ciStartedAt` and `ciFinishedAt` on the task's delivery facts (`checksSpan` in `src/core/orchestrator/changeChecks.ts`): the first check's start; once green the last check's finish; once red the first failure's finish.
A reading with no start clears both, so a new version starts the count again, and a rerun that the host lists as the newer check counts from its own start.
The cell reads `running for 15m`, `passed in 14m · 5m ago` or `failed after 9m · 5m ago`, in whole minutes redrawn each minute (`src/shared/checksSpan.ts`); on rest it shows when the first check started and when the app last read them.
The crew summary says the checks as one state with that time beside the pull request, with no counts and no `ago` (`running for 11m`, `checkSnapshotState`, INF-2528).
Checks that have not started, not read yet or merged outside the app show no time.
The first mate's own facts keep the reading's age (`ciFact.ts`), because it judges a reading's freshness by it; Activity and the Now line keep each reading's own time.

A task with no change yet shows the run it started by hand instead, when the app watches one (INF-594, "The run watch" below).
The run reader keeps the host's times (`WorkflowRun.startedAt`, `finishedAt`): a GitHub run's `run_started_at`, the latest attempt's start, and once completed its `updated_at`, because a run has no `completed_at`; a GitLab pipeline's `started_at` and `finished_at`.
Every reading of a watched run - the crewmate's short read and the minute reader's - writes `runChecks` on the delivery facts (`runChecksOf` in `src/core/orchestrator/runWatch.ts`): the run, its state (running, passed, failed or cancelled), its times and the reading's time.
It stays after the watch ends, so a finished run says `passed in 3h 26m · 5m ago`.
A reading of another run replaces it only when that run started at or after it, so the newest run shows.
The run is read by its number, never by its commit, which may carry other checks; a task with a change shows the change's checks.

## The run watch

A crewmate's short `read_workflow({ runId })` of a run still going saves a watch in the task's `runWatches` delivery facts (`WorkflowEvidenceService`, `RunWatcher`).
The short read says the app is watching and tells the crewmate to end its turn, never sleep or loop on reads.
The run and its latest jobs are read on the supervisor's shared 60-second tick, through the project's forge and app-owned sign-in, with no model turn and outside the gateway's 200-call budget.
Each task watches up to five runs, each for three hours from its first read; another read preserves that start, and an over-cap read explicitly says no wake will come for that run.
A latest-attempt reading follows a GitHub rerun without starting another three-hour bound or adding wakes.
GitLab has no attempt counter: its pipeline stays the same number, and its jobs list omits retried jobs.

The watch queues at most two typed `run-watch` steers on the crewmate's own durable lane: the first failed job while the run still goes, then the run's end.
Each names the run and attempt, and failures name job numbers, names and the failed step or reason when the host supplies one.
If the first failure reading also sees the run ended, only the end wake goes.
GitLab jobs marked `allow_failure` do not send an early wake; GitHub exposes no such flag in its jobs API, and a continue-on-error job reported successful is not a failure.
The watch never guesses allowed failure from a job's name.
The end names passed, failed or cancelled; a run still going at three hours, a gone run or an unreadable run sends an end wake too.
A typed transient host failure reads again within the bound, and a spent hourly allowance reads again at its reset, also within the bound; a sign-in or other permission refusal ends the watch immediately.
An incomplete jobs list is named on a failure wake rather than claiming every failed job was seen.

Wakes use `run-watch:<runId>:<since>:failure|end`, recorded by the durable inbox's ordinary once mechanism.
A restart preserves each watch and each sent name, so neither wake goes twice.
A closed task receives no wake; an overlapping crewmate read or close supersedes an outstanding poll.
A crewmate's own short read of failures suppresses the early wake it already knows, and its short read of an ended run clears the watch without a wake.
Starting and ending a watch each writes one task timeline line.
While a watch stands, `checksWatched` keeps the idle ladder from nudging or reporting the task stuck, and its existing posture reads Waiting for checks.
Each reading also keeps the run's state and host times for the checks cell ("The checks cell's time").
An ordinary reading saves that checks cell with its own time, any newly failed jobs and the watch's next read in one write; a reading that wakes the crewmate saves its checks cell and failed jobs before the wake goes out (INF-2220).

The run watch never writes pull request check readings, diagnoses, repair counts or merge permission; like the short read, it keeps the run's failed jobs on the repair ledger ("A workflow run's failures" below).
`check_change` remains the pull request fact reader and declaration seam; `github_read`, job log reads and downloads keep their existing contracts.
An accepted own-project `github_write` dispatch with `workflow_run_id` arms the run watch immediately and says so.
The crewmate sends `"return_run_details": true` itself; the app never adds it, because older GitHub Enterprise servers may refuse it.
A GitHub dispatch that does not send `"return_run_details": true` gets no run number back, so the app lists that workflow's dispatched runs before sending it and again after, up to three times while GitHub queues the run (one budgeted call each, `GithubGatewayService.dispatchBaseline`, INF-1428).
The one new dispatched run on the dispatch's ref is its run, and the answer names it beside the watch's own words.
Two new runs are someone else's race and the app never guesses between them; then, as when the listing cannot be read, the answer says to find the run through `github_read` and take the short `read_workflow` read.
Never repeat an accepted write to obtain its number.
Accepted GitHub run reruns use the route's run number, and job reruns read the job's `run_id` through the gateway (one budgeted call).
GitLab pipeline starts use the returned pipeline `id`, pipeline retries use the route's number, and job retries or plays use the returned `pipeline.id`.
The watch is armed before reading the run, so a rerun still being queued cannot clear it through a stale ended-run reading.
An existing watch keeps its original bound and sent wakes; a rerun after that watch ended starts a new watch.
A write kept for the captain arms no watch until the captain's click sends it successfully, and writes outside the task's project never arm one.
The five-run limit still applies; a full watch list or an unavailable run number explicitly says to take a short read later.
Reruns of a task's pull request still record its existing rerun reservation and read its checks separately; a non-PR rerun makes no pull request reading.

### A workflow run's failures

A run a task reads needs no pull request for its diagnosis or an evidenced rerun declaration (INF-688).
Every short `read_workflow({ runId })` and every reading of the run watch records the run's failed jobs on the task's repair ledger (`observeRunFailures` in `src/core/orchestrator/checkRepair.ts`, `recordRunFailures` in `runWatch.ts`).
Each failed job's name joins `ciRepair.failures` at the run's version, so `check_change` accepts a diagnosis keyed to that version and job name, as it does a failed pull request check.
`ciRepair.runs` keeps each run's newest reading: its version, its attempt and that attempt's failed jobs.
A newer reading replaces it, so a job that passed on a rerun is no longer listed; an incomplete job list never drops a job the same attempt already showed failed.
A reading with no failed job is recorded only for a run already on the ledger.

A workflow reading retains its exact version, attempt and failed job names.
Diagnoses and evidenced rerun decisions are declarations, not requests for a host allowance.
A baseline-blocked diagnosis still names a separately owned dependency, whose closure and default-branch check observations can wake its crewmate.
Repair settlement always comes from the crew's explicit declaration, including before a pull request opens or after it moves to a newer version.

## Conditional reads

Every GitHub read the app makes goes through one store of the answers GitHub tagged (`conditionalGets` in `src/core/forge/providers/github/conditionalGets.ts`, INF-2149): the forge's own reads, the workflow reads, the gateway's `github_read` and the sign-in's health read.
The store keeps each signed-in JSON GET's `ETag` and answer, sends the tag as `If-None-Match` on the next read of the same address by the same sign-in, and replays the kept answer as a 200 when GitHub answers 304, with the 304's own headers, so the allowance left is the current one.
GitHub does not count a signed-in 304 against the hourly allowance, so a watch that finds nothing changed spends nothing, and how often anything is read does not change.
The key is the address, the `Accept` and API version headers, and a hash of the sign-in, so one sign-in never reads another's answer.
It keeps nothing for a write, a ranged or unsigned read, a redirect, or an answer that is not JSON, and forgets the oldest answer past its byte bound (`KEPT_ANSWERS_MAX_BYTES`).
The app builds a new client for each call, so the store lives in the home's forge wiring (`homeForges.ts`), one for the run.

## Failures are typed

A forge throws `ForgeError` with a `failure`: `transient` (any 5xx or the host unreachable - `ChangeMerge.merge` retries these quietly, and nothing else), `sign-in` (a 401), `permission` (a 403, never retried; a spent hourly allowance, a 403 or 429 with no calls left, is a `ForgeAllowanceSpent` carrying the reset time, which the timed reads wait for), `not-found`, `refused` (a stale head, a default branch that moved on, branch protection), `unsupported`.
The raw words stay on the error for the record and `plainProblem`; the kind is what code decides on.

## Who reads it

`ChangeChecks` (`src/core/orchestrator/changeChecks.ts`, read by the crewmate's `check_change` and the completion-card gate) asks the seam and records what it answers on the task's delivery facts: `changeLabel` from `label()`, `prNumber`/`prUrl` only where the host has them, `prBase` where the host names the branch the change targets, and each check reading stamped with the number of the pull request it was read of (`CheckSnapshot.prNumber`), which the change record binds it by (`docs/task-record.md`, "A task's change").
When the branch has no open change but the task names a pull request, the reading asks for it by its number with `pull`: merged outside the app, it records `ci: merged`, and the strip reads "merged outside the app" until the shared watcher can close a task whose crewmate declared that merge finishes its work.
A put-in made before that tick also answers the merge already made and closes the task without sending anything.
The settle card's fact strip (`SettleFacts.strip` in `settleCardFacts.ts`) and the record card read that label and link - never parse a number back out of a URL.
The record card still names where the change goes from the repository's `host` ("goes in on GitHub", "goes in on git.example.com").
Settings → Projects names no place on a closed row, which says only how a project differs from a new one; the open row's Where it lives shows the address, and stays empty on a project kept on this Mac: the captain's constraint is that a forge is never required.

The first mate reads the same facts (git integration PR 1.3).
Its context block's `lives` fact is the host's kind from the origin, and - only where the project's changes go there - the app's sign-in on it, from `ForgeSignIns.signInOn`: `github (signed in as octo)`, `github (not signed in)`, `github (GitHub no longer accepts the sign-in)`, `github (signed in as octo; not reachable just now)`; a plain host names its address (`git (git.example.com)`), and a project kept on this Mac is `none` or, when it has a host but its work goes straight in, the bare kind with no sign-in at all.
`crew_status` names where each task's proposed change goes as `goesIn` using `forgePlace`, and omits it wherever the work goes straight in.
Every other string the host writes about a change names the project's own host, never GitHub by default.

## The fence

Everything outside `src/core/forge/` imports `src/core/forge/index.ts`.
The provider files under `src/core/forge/providers/` are fenced by Biome `noRestrictedImports`: only `src/core/forge/` itself may import one, the seam and the home's forge wiring among it, the way Pi is reached only through `src/core/pi/`.

## Evidence

`src/core/forge/providers/*.test.ts` (the REST forge, the device flow and the open-changes read against a local HTTP stub, and a GitHub Enterprise host's API addresses and its pull request under `/api/v3`; the plain host against real repositories and a bare remote), `src/core/forge/signIns.test.ts` (the store's modes, the five health rules, the health log across a restart and a sign-out, a short-lived sign-in against a scripted GitHub - renewed at the next start after it ran out while closed, ahead of its end, on an early 401 and before a forge request, one renewal at a time, `needs_reauth` only on a refused renewal, `unavailable` when the renewal cannot be asked, never over a sign-out - every way a code ends, the git helper over the store's own file, and a key sign-in to a host on the person's own server - kept with its kind and git user name, refused, unreachable or not that kind of server with nothing kept, known from a project or by its `.ghe.com` name, its health and sign-out), `src/shared/forge.test.ts` (known hosts and typed addresses), `src/core/workspace/repoRegistry.test.ts` (stamping a known host's projects, never back), `src/core/workspace/forgeAuth.test.ts` (the refusal keyed by a known host), `src/core/hostEnv.gitSignIn.test.ts` (real git - the search path's and, on a Mac, the app's own - against a local HTTPS host: the helper answers with the app's sign-in and a helper in the person's own git config never does, and a host signed in since the helper was named answers with its own git user name), `src/core/workspace/git.test.ts` (the app's git resolved, run by the host and first in a crewmate's shell, the system git without it), `tests/e2e/app-git.spec.ts` (a crewmate's `git status` on a launch whose search path holds no git at all), `tests/e2e/run-work.spec.ts` ("a Mac with no git of its own": the work mode's join, clone, crewmate's shell and work brought home on a search path with no git), `src/core/orchestrator/changeChecks.test.ts` and `changePublication.test.ts` (the change delivery over a fake forge, `open_change` and `check_change` included, and the check watch's arming and read, a finished reading recorded once until its state changes), `src/core/orchestrator/checkWatch.test.ts` (the watch's minute-then-two-minute reads, its bound, a hiccup and a refusal, a change gone, a newer reading or a close while a read is out), `src/core/orchestrator/mainCheckWake.test.ts` (a standing baseline wait given changed default-branch observations without a host readiness judgment), `src/core/orchestrator/crewWatch.git.test.ts` ("the host's check watch": pending then green or red is one finish wake and no model turn between, a failed check while others run is one early wake, a new push re-arms for the new head, a host without checks is never watched, a restart mid-watch still wakes once, a task idle behind another task neither read nor recorded until that work closes), `tests/e2e/forge-seam.spec.ts` (a plain host), and `tests/e2e/forge-signin.spec.ts` (the sign-in in Settings -> Projects against a local GitHub stub - code shown, cancelled, refused, expired, approved; the first mate's listing; a crewmate's `open_change` and the captain's put-in; GitHub refusing the sign-in, the one card and signing in again; a project kept on this Mac naming no host; signing out, the health log's dated lines for all of it, a real quit and start bracketing the sign-in on file, and a short-lived sign-in renewing itself when GitHub ends it - one code exchanged once, no card, git's helper answering with the renewed sign-in; and a GitHub Enterprise host the app has never seen, signed in by keys alone with a key it first refuses, its projects then GitHub projects in the first mate's facts, listed through its `/api/v3`, git's helper answering it with the key, and a crewmate's pull request opened, read and merged there).
The stub hands a code's sign-in over once and spends a refresh token once, as GitHub does.
The direct-pr specs (`rigor-standard`, `rigor-reviewed`, `autonomy`, `settle-effects`, `honest-settles`) run on the same stub (`tests/e2e/githubStub.ts`).
A computer's own sign-in is `src/core/helper/signIns.test.ts` (GitHub's device flow on the computer against a stand-in GitHub, its store, its git's environment, its health and a sign-out from here, a stopped or expired code) and `tests/e2e/device-sign-ins.spec.ts` (Settings -> Projects against this stub, with the computer in the test's own process and git's helper answering with its sign-in).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The forge seam (git integration PRs 1.1-1.3; `docs/forge.md` is the one home): everything the app asks of where a project lives - a branch's open change, its checks, put it in, close it, what it is called - goes through `src/core/forge/index.ts`; the provider files under `src/core/forge/providers/` are Biome-fenced to `src/core/forge/`, the seam and its home wiring (`homeForges.ts`).
  A repo's `host` (`RepoView.host`, migration 40) is stamped from its `origin` by `forgeOf`.
  GitHub is the REST `GitHubForge` with the app's OWN GitHub sign-in (PR 1.2: OAuth device flow, `userData/forges/<host>/` 0700/0600 beside - never inside - the account vault, health on the supervisor's tick where GitHub's 401 is the proof, one `card-forge-<host>` card; the app's own code never runs `gh` or reads another program's sign-in; a crewmate the captain asks to run a program runs it), and GitLab the REST `GitLabForge` with the person's browser or key sign-in; every "Not signed in" answer is a refusal whose ways are the sign-in and keeping the project on this Mac, and crewmates open and check changes with `open_change`/`check_change`; a plain host (and Bitbucket until its file exists) has the working copy sent up as a branch, reads green with zero checks, and is put in by a never-forced fast-forward push; a project kept on this Mac has no host.
  Surfaces name a change by the recorded `changeLabel`, never by parsing a URL, and name a host only on a project whose changes go there - a forge is never required.
  The first mate reads the same (PR 1.3): the context's `lives` fact carries the app's sign-in only where a project's changes go to that host, and `crew_status` names it as `goesIn`.

### Names on changes and save points

The app checks new save-point subjects against the conventional form `type(scope): summary` or `type: summary` before opening and putting in a change.
The scope is optional and open-ended; supported types are `feat`, `fix`, `chore`, `test`, `refactor`, `docs`, and `perf`.
A breaking change uses `!` and the `BREAKING CHANGE` footer in its description.
An existing change's current title on GitHub or GitLab is checked again when it is put in; GitHub receives an explicit squash request with that title and description, and GitLab a squash whose commit message is the title, a blank line and the description.
The app does not rewrite older commits; incoming commits are checked relative to the common base.
For a change it opens or puts in, that base is measured from the fetched `origin/<default>` when it exists, so a local default branch this Mac has not pulled never makes merged commits look like the branch's own.
Merge commits are skipped: git names them, and they bring in no work of the branch's own.
Plain Git and local-only delivery validate incoming commits before fast-forwarding, including reviewer work.
The app cannot intercept a raw push from a terminal; this is not a hosted required check.

## Saved change stories

Every new branch-based change and its completion card read one immutable `ChangePresentation` revision (`src/shared/changePresentation.ts`), including GitHub Enterprise, self-hosted GitLab, plain Git and local-only delivery.
`prepare_change` validates the crewmate's publishable prose and selected inspected files without displaying a card, uploading bytes or opening a PR.
A hosted story is read by everyone who can see the project, and by anyone when the project is public, so the crewmate writes it for a stranger (INF-2142).
`PUBLIC_WRITING` (`src/core/prompts/publicWriting.ts`) is that rule's one home in the crewmate core, served once on Pi and on Claude, and covers everything sent where the project lives: stories, descriptions, commit messages, comments and releases.
It keeps out the captain's own setup by name, keys and what they reach, addresses, paths, clock times, time zones, other projects, task keys and the captain's words; a local-only project's story, shown only on its completion card, is exempt.
`publishable: true` is the author's declaration that it read the story once as that stranger, and the prepare answer names the destination's visibility it read (`storyAudience`, `src/core/orchestrator/changePublication.ts`).
The saved story is a soft hold (`story`): when the captain's recorded override passes it, a new pull request takes `body` instead.
The same override passes the story at the merge, ordinary or past the branch rules, at the version it covers (INF-1365): the merge goes without a current published story, while its checks, review, approval, version and the host's rules still hold.
It marks no story published, uploads, refreshes and rewrites nothing, and is read after the merge's last wait, so an override taken back before the send holds the merge.
A completion card that names a story revision still needs its destination's current readiness: a hosted description published and read back, a pushed plain branch confirmed, or local committed work checked.
New stories use version 2: the same conventional title on the card and pull request, up to two short Why sentences, five change bullets, one Before and After sentence, and six typed `checked` facts (`check`, `result`).
Aim for 150 open words on the card and 250 on the pull request.
The zod schema carries the captain’s selected item counts and refuses past them; the author owns sentence length and word targets, with no invented per-sentence character refusal.
The `story` parameter's own description (`PREPARE_CHANGE_STORY_DESCRIPTION`, `src/core/pi/forgeTools.ts`) says the item counts, that `base`, `head` and every `captureHead` are full commit ids, that a later revision keeps the first base, which version Before and After media name, when `layout` adjacent applies, and who reads the story and what `publishable` declares, because no served schema carries those relationships or counts: the served `story` leaves its lengths and item counts to the parse (`zodParameter`, `docs/orchestrator-contract.md`).
`verification` keeps commands, file names and counts behind How it was checked on both surfaces; nonempty unfinished work folds under Not done.
The card keeps its risk radar; the pull request gives one line naming dimensions above low and folds the seven-row assessment.
Empty required-action and unfinished sections, a frozen checks status and story/version stamps are absent.
Authors never put code versions, hashes or revision numbers in prose, captions, alt text, verification or project text, even folded; this is instruction only, with no prose refusal or redaction.
Capture versions and applicability remain retained data, never rendered on new stories.
Before media name the story's base and After media its head; a picture truly captured on another version keeps that version as its `captureHead` with an applicability declaration saying why it still shows that state, so an older Before picture keeps its true source while the base stays the original comparison, and nothing is relabelled (INF-2660).
Version-1 saved stories keep their rendering; already published descriptions are not rewritten automatically.
Changed views have Before and After media; new views have only After; an invisible change has no views and an explicit no-picture reason.
Under Before and after, each changed view pairs its Before pictures with its After pictures, with one caption per view.
On the card, each view's caption sits above its own boxed table: a changed view's header reads Before and After over its two columns, and each row holds the matching pictures, the first beside the first; no label sits under a picture.
A new view carries After evidence only; on the card its own table is headed by the New tag, two pictures to a row for an adjacent view and one otherwise, and in the pull request its heading reads New.
A recording sits in the card's table as its poster and Play button.
In the pull request a view containing a recording stacks, because GitHub's and GitLab's native players ignore the requested width and overflow a two-column table.
Version-1 stories retain the author's optional adjacent grouping within each state.
The author judges relevance, safe publication and continued applicability; the host checks the typed relationships and byte identity, never natural-language intent.
Meaningful drawn figures need inspected raster exports; arbitrary card HTML, interactive controls, host chrome and private threads are not exported.
Public project-template text and issue references are supplied as `projectText` outside the generated region on the first publication; after it, `around` changes those words (below).
A saved story's squash commit message is its plain `whatChanged` summary, followed by any conventional `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer and continuation lines in the current surrounding project text.
That text begins as `projectText`; the merge preserves a footer the person later adds outside the verified story region too.
Both ordinary and rules-skipping merges use that summary, never the rendered story's markers, escapes, tables, evidence URLs or risk chart; legacy descriptions keep their existing delivery.
A merge the override passes squashes under the description's own words around this task's story region instead, any footer included, since the story may describe an older version.

### No-mistakes' attestation

A passed independent review with live proof it accepted counts as no-mistakes (INF-1793, the captain: "it's my intended design to have infinitary's careful rigor be counted as no-mistakes in those PR enforcements"), whatever the care's name (INF-1876).
A github.com story whose records cover its version ends its own region with no-mistakes' signature line and v1 pipeline attestation (`src/core/forge/pipelineAttestation.ts`), the markers byte for byte as no-mistakes writes them, so its `require-no-mistakes` check passes the pull request.
The attestation names the story's version, which is the pull request's commit, and marks review, test and document completed, with a `producer` field the check ignores, then one line naming Infinitary's independent review and the live validation it accepted.
The host writes it only when the records cover that version, read when the region is written (`attestsAt`, `src/core/orchestrator/changeContext.ts`): a review that passed there gives review and document, since the reviewer's brief also judges the documents, and live validation a review there accepted gives test, including an earlier run that review confirmed its version's difference does not reach (INF-2672); Careful's guidance is what asks for both, and the host holds nothing on them.
A captain's override completes neither step, and a story with no such records, GitLab and older descriptions carry neither line.
A push moves the pull request past the attested version, so the check fails until the story is published again at the new version once a review of the update passed; the refresh before a kept merge of an accepted repair reads the records the same way.
Every live attestation prefix outside the region, in project text or a person's words, is made inert the way no-mistakes does, so the check reads only the app's.

`stageChangePresentation` reuses the card media reader and retains exact validated files in the task's card-media folder, outside its working copy and temporary folder.
A recording keeps its inspected local poster and must be a playable silent H.264 MP4 below 10,000,000 bytes; it is never silently replaced by a still or GIF.
The existing image, total-size, duration and resolution limits still apply, and no conversion happens silently.
`TaskService` owns the revisions, attachment states, branch/local completion binding and last complete hosted publication in `TaskDelivery.presentation`.
Only the newest revision and the last complete revision remain (or the unresolved opening revision while its outcome is unknown); replacing them removes their otherwise unreferenced copied media, while receipts remain reusable.
Each receipt is scoped to the host, numeric project identity, full project name, visibility, content digest and media type.
The paired computer transfers retained pictures and recordings through the existing picture and chunked-media routes before asking the home to prepare the story.
`CHANGE_PRESENTATIONS_SINCE` gates that tool on work computers; an older computer must be updated before opening a new github.com pull request or gitlab.com merge request, rather than bypassing the publication barrier.
A computer that restarts on a contract that speaks it is given the tool on the conversations the home reopens, without the home restarting.
The home opens the PR using its own sign-in; no sign-in moves to the work computer.
The work computer discards its staging copies after transfer; the home retains the newest and last published story copies.
A refused preparation discards unretained staging copies even before host or legacy-PR validation, or when another story operation is running; it never removes that active operation's files.
Completion cards receive independently named copies of the validated media in the task's `cards/` folder, so later story pruning leaves shown cards and their history intact.
A staging refusal removes every newly minted picture and recording, and a refused completion card removes its new copies unless the card was already persisted.

`open_change` takes the prepared `presentation` revision instead of `body` for a new pull request, merge request or plain branch; local-only work skips that call.
The native GitHub attachment capability checks destination identity, public/private/internal visibility and write/maintain/admin permission before each upload.
It sends raw bytes once to `https://uploads.github.com/user-attachments/assets`, with the short names `recording.mp4` or `picture.<format>` and the app's own sign-in; it refuses redirects, unsupported credentials and non-native returned URLs.
In unpackaged tests, the existing API-base override also routes attachment uploads to the local GitHub stand-in, which retains and serves the actual bytes; packaged builds keep the native upload origin.
GitHub shows an upload's name above its player, so the name is readable and never contains a source path or content hash.
The digest still owns receipt identity; changing the display name never resends a confirmed attachment, whose original hosted name stays unchanged.
Recordings always use bare attachment-URL paragraphs, not HTML video elements, so GitHub supplies its native player and rewrites private media to signed, temporary links.
An HTML `video src` would stay unsigned in a private project and require a signed-in viewer with access; the renderer does not emit that form.
Internal projects use the same sign-in-gated native media as private projects; the exact visibility remains in receipt identity so audience changes are refused.
Saved receipts keep canonical GitHub attachment URLs, never the temporary links GitHub renders.
On a native-media host, every selected file must have a confirmed receipt before the PR opens, including a draft, or an existing story is replaced.
Before uploading, the complete rendered description must fit the host's limit - GitHub's 65,536-character body, GitLab's 1,048,576-character description - including escaped prose, attachment links, project text and preserved human words.
Sizing uses an address of each native receipt's own length without treating it as a receipt or publishing it.
The publication barrier rereads the committed and pushed head, destination and retained hashes after uploading, and rechecks the final body size in case a person added text during the uploads.
Raw JSON gateway writes cannot create an own-project PR or replace this task's saved description around that barrier, including percent-encoded paths, trailing slashes and the issues alias.
No setting, repeated publication approval, evidence commit, public-storage fallback or Infinitary-hosted fallback exists.
An access or validation failure before sending is a failed upload, not an uncertain write.
An upload's 401 is a sign-in only when the host also refuses the key itself (GitHub's `GET /user`, GitLab's own 401 check); a key it still answers for makes the refusal a permission.
A refused or uncertain upload reaches the crewmate in its own words, never as a reminder to push the branch; a permission refusal keeps the write-access note and its blocker words.
A write whose response is lost stays uncertain across restart and is never automatically replayed.
A matching PR body can resolve a lost publication response even after a later push; that confirmation retains the earlier demonstrated version and cannot qualify the new version for completion.
GitHub offers no supported attachment lookup by digest for a lost receipt; the tool names the uncertain digest and discloses a possible orphan rather than inventing a URL or claiming absence proves failure.
The crewmate shows that disclosure on a card, and only after the captain chooses another attempt sends that digest in `recovery.retryUploads`; the receipt retains the possible-orphan fact.
An uncertain opening is read first, then an explicit `recovery.retryOpening` can resend when no open PR exists, relying on GitHub's one-open-PR-per-head-and-base constraint.
That deliberate retry also permits preparing a newer version while retaining the prior opening receipt, so a late first response or duplicate-opening refusal is reconciled rather than mistaken for a legacy PR.
If an uncertain replacement left the exact last published region in place, the host restores that confirmed state and a deliberate later `open_change` retries its idempotent replacement.
A closed PR stops publication without opening another; the captain may finish the task or deliberately reopen that same PR where the project lives.
A task whose pull request was opened before saved stories and has since closed forgets it: its next `prepare_change` and `open_change` start a saved story like any new task, and only a pull request still open for the branch is refused as predating them.
One that merged outside the app stops there like a merged published story: nothing more is opened for it.
Hosted files can outlive a failed or abandoned opening, and local cleanup never deletes them.

New stories print no publication-time checks status; the host's live checks strip remains authoritative.
If checked facts change after publication, the author updates them and verification in a new story revision and deliberately republishes it before offering completion.
A push alone is not such a change: when a pull request moves past its published story, the host republishes that story at the pushed version itself (INF-2509, the captain's answer 5 on INF-1868: "The host republishes the declared story at the new head itself and refuses nothing; the merge still carries the story you saw").
The republication is a new revision with the same words, the same confirmed attachments and the content hash the completion offer binds; it records the revision its author published as `refreshOf`, and After media without an applicability declaration gets one saying it was captured on an earlier version.
A completion card names the author's revision or the republished one; the card offers, and the merge click checks, the republished one (`ChangePresentations.atPushedVersion`).
The author vouches for the story at the code they committed, so the completion card first needs the committed code to be the pushed version; the refusal says to push and show the card again.
A merge reads the pushed branch alone and republishes a story a push left behind before it sends (`republishMoved`), except where a kept approval covers another version.
Only the newest story is republished: a newer revision its author prepared and never published is theirs to publish, and the completion card and the merge are refused until they do.
Those refusals, the refusal of an ordinary body on a saved-story task's completion card, the refusal of a completion card with neither body nor `presentation`, and the `presentation` rule itself each name the way out (INF-961).
The completion refusal names the revision and the versions from the ledger; the merge path's refusal reaches the captain, so it keeps its own words and names no tool.
A local-only story and a plain branch's story keep no description to republish, so a later commit there still needs a newly prepared revision.
Evidence: `changePublication.stories.test.ts` ("republishes the published story when a push follows its publication", "republishes a story a push left behind before a merge with no kept approval"), `changePresentations.test.ts` ("republishes the published story at a pushed version with its words unchanged"), `cardTool.test.ts` and `crewmateCards.completion.test.ts` (the two card refusals and the republished offer).
A replacement keeps the original Before base and evidence; After needs fresh captures or an explicit applicability declaration for the current committed version.
Confirmed receipts are reused after restart without another upload, while an open PR keeps its last complete story until the replacement is ready.
The generated region carries stable markers and a last-published hash; replacement normalizes CRLF to LF, preserves the surrounding words, and refuses edits inside it.
The refusal returns the edited region as data: the crewmate shows it beside the saved story on a card, then passes that exact region as `recovery.replaceRegion` only after a republish choice.
Missing or duplicated markers make the whole current description the review text, including an empty description.
After that exact-text-bound choice, the host removes only this story's marker comments, preserves all existing prose (including the old unmarked story) and appends one restored generated section.
A newer edit refuses the earlier choice; no ordinary raw body write through either `pulls/{number}` or `issues/{number}` bypasses this boundary.
Neither GitHub nor GitLab supplies an atomic conditional description write, so the adapter rereads before and after writing; a simultaneous human edit can still race those reads.
The read after a write compares only the generated region, the one text the app owns, so words a person adds around it, or template lines the host removes, do not make a confirmed write uncertain.
An ambiguous PR write is reconciled by branch, PR number when known, and exact generated region before any further write; a later push does not prevent confirming the earlier write.

A replacement keeps a version-2 story's conventional title as the change's title too, the one its squash merge uses (INF-717).
When the change still carries the title the app last left there, the story's new title goes in the same conditional write as the description, and on GitLab a draft keeps its `Draft: ` marker before it; the answer names the new title.
When a person renamed the change, nothing is sent, checked before any upload and again just before the write, and the answer quotes the change's title, the story's and the one the app last left.
The crewmate then prepares the story with that title, or asks the captain on a card before setting the title alone with `github_write` and publishing again.
A rename that races the write is answered once the story is confirmed, as the words around it are, and the next publication treats it as a person's.
Each publication records the title it leaves; one recorded before that counts only its own version-2 story's title as the app's, and answers any other as a title the app has no record of setting, as on a pull request whose earlier republication kept its opening title.
A version-1 story never renames its change.
Evidence: `tests/githubStub.test.ts` ("a saved story's title through the real GitHub forge and the stand-in"), `tests/gitlabStub.test.ts` (a draft renamed and squashed under the new title), `changePresentations.test.ts` ("the title of a republished story": the races and older records), both forges' tests (the write itself) and `changePublication.stories.test.ts` (its answers).

`open_change`'s `around` changes one passage of the words around a published story on its open pull or merge request, such as an outdated summary or a `BREAKING CHANGE:` footer the squash reads, while the story stays as published.
`from` is the passage exactly as the description shows it, found once above or below the story, and `to` replaces it in place; an empty `from` adds words only where nothing surrounds the story.
With the published revision, the host sends that published region, its content hash and its receipts byte for byte and uploads nothing; with a newer revision, the newer story is published in the same write.
A passage that is not there, because someone changed it since the crewmate read it, or that appears more than once sends nothing, and the answer quotes the words as they read now; an edit inside the story keeps the refusal above.
On GitLab, a line of the new words that starts with a quick action escapes its slash like the author's prose, because only the captain's click merges.
The read after the write confirms the story by its region as before; when the words around it differ from those sent, the answer says so rather than claiming them.
Before the first publication there is no description to change, so the words go in `projectText`, and a pull request without a saved story takes `body` instead.
A home before `STORY_AROUND_SINCE` (10.1.0) would drop `around` and answer as if nothing was asked, so a work computer refuses the call to it and sends nothing.
Evidence: `presentation.test.ts` and `changePresentations.test.ts` ("the words around a published story"), `changePublication.stories.test.ts` (open_change's answers) and `sessionHost.test.ts` (the older home).

Missing or mismatched evidence holds the completion offer and the final own-task merge boundary independently of checks and merge authority.
The completion call gives `emit_card presentation` and one merge action, or omits actions for a note when the task merges on its own, without a second body, risk declaration or required-action list.
The shared Pi and Claude tool forwards either shape; the supervisor checks the task's autonomy before accepting a note (INF-968).
CardService still owns cards, the risk chart, requirements and merge controls; checks, independent review, autonomy and the captain's merge click retain their existing owners.
A first-mate `settle merge` card on a task with a saved story carries that story once it is published at its newest revision (INF-2490): `CrewSupervisor.bindFirstmateOffer` records the card's offer with the published revision and content hash, so its click passes the same story gate as a crewmate's completion card and the merge reads the same story.
Before that publication CardService refuses the card before creating or revising it, and the refusal points the first mate to steer the crewmate to publish its story or emit its own completion card.
Every merge offer, the crewmate's or the first mate's, names the change it was shown for (`shownFor`); once another change is current its click refuses, so an offer shown for one pull request never merges another.
The first mate's offer names no head, so its click approves nothing kept and is one attempt.
Only a crewmate-authored completion card counts as a replacement for a kept merge approval, including at the final merge boundary; a first-mate card restored from an older run does not end that approval.

### Description hosts, plain branches and local work

`Forge.storyDestination` reads description identity independently of `Forge.attachments`; destination comparison preserves older public-host records without the optional explicit format.
GitHub Enterprise and self-hosted GitLab publish the same prose, risk assessment, checks and view descriptions, using their own description dialect and size limit.
Pictures and recordings remain on the completion card; the hosted text says so and includes their captions and alt text, never local file paths or invented remote media URLs.
Native-media support is still only github.com and gitlab.com: a missing capability, failed upload or uncertain upload on either host never becomes a text-only fallback.
Text publication uses the same serial writer, committed and pushed heads, audience checks, owned-region protection, human-edit recovery, read-back and squash summary as native publication.
Raw description writes cannot bypass it on Enterprise or self-hosted GitLab either.

A plain branch records its origin as its destination and confirms the pushed head through `open_change`, without opening a request or inventing a number, description, upload or receipt.
If the branch is not yet on the host, the existing plain forge sends it from the home computer after the story, retained files and publication permission pass; an already-pushed branch needs no write.
Local-only routing reads the task's delivery policy even when the project has an origin; `prepare_change` verifies the committed head and retained files without locating a forge or requiring its sign-in.
Both keep a completion binding of revision, head and content hash, separate from a hosted publication.
Their cards use the same story renderer, radar, facts, required actions and merge line; self-merging notes use the same story and stay off the stack until their merge, then show once saying it merged (`docs/card-authoring.md`).
A newer revision or moved head invalidates the prior completion.
The offer and final merge boundary bind that exact story, and the local land checks its retained files and committed head before dispatch.
A branch or local attempt waiting for its turn keeps the binding on its existing pending-settle record, so a restart never recaptures a newer story as approved.
A plain branch still fast-forwards the remote default branch without force; local-only still merges locally, without a remote push.
Neither acquires a hosted request number or the kept-approval repair lineage that requires one.
Evidence: `changePresentations.test.ts` and `tests/e2e/story-destinations.spec.ts` drive the four destinations through preparation, publication or local readiness, cards and their existing merge owners.

### On gitlab.com

A gitlab.com project's forge offers the story through GitLab's own project uploads (`providers/gitlab/attachments.ts`); a self-hosted server has no native-upload capability and publishes the text as described above.
Its destination is read from `GET /projects/<encoded group/subgroup/name>`: the numeric `id`, `path_with_namespace` (nested groups kept whole), `visibility`, and the key's role where GitLab lists it.
A role GitLab lists below Developer is refused before sending; an inherited role it does not list leaves the decision to GitLab's own answer.
Each upload rereads that project and sends the exact retained bytes once as multipart `file` to `POST /projects/<numeric id>/uploads`, the number the read confirmed, with the names `recording.mp4` or `picture.<format>`, the app's own sign-in and redirects refused.
A private or internal project's upload is refused, with nothing sent, unless that read says `enforce_auth_checks_on_uploads` is exactly `true` ("Require authentication to view media files"); absent, null or false never passes, because GitLab otherwise serves the file to anyone with its link.
The app never changes that setting; the refusal names it for a maintainer to turn on, and a story with no media publishes whatever the setting reads.
A confirmed receipt is GitLab's project-relative `url`, `/uploads/<32 hex>/<name>`, checked against the name sent; its `full_path` must name the same file in the same project, as `/-/project/<id>/uploads/...` or the project's own path, or the answer is uncertain.
Returned `markdown` is never used, and receipts keep only that reference, which GitLab resolves inside the merge request's project.
Pictures are Markdown images and adjacent pictures use the same table as GitHub; a recording is an image link to its MP4, which GitLab renders in its own player with its alt text, never a bare reference.
The merge request's description is replaced with `PUT /merge_requests/<N>` only after a fresh read still shows it open at the story's head with the words the publication read, and with the title it read when the story renames it in the same request; `GET /repository/branches/<branch>` confirms the pushed version.
Opening and replacing tell a refusal GitLab answered (a 4xx) from a lost connection, a redirect, a 5xx or an unreadable success, which stay uncertain and are read back, never replayed.
An uncertain opening relies on GitLab permitting only one open merge request for a source and target branch.
GitLab offers no lookup of an upload by digest either, so a lost upload receipt is disclosed as a possible orphan exactly as on GitHub.
Raw gateway writes cannot open the task's own merge request (`POST .../merge_requests`) or replace its saved description (`PUT .../merge_requests/<N>` with `description` in the body or the query string, which GitLab also reads), however the path is encoded; its other fields and other merge requests stay writable.
GitLab runs a description line that starts with a quick action (`/merge`, `/close`) when it saves the text, so every line of the author's prose and captions escapes its leading slash (`\/` reads as `/` on both hosts).
A project template's own quick actions in `projectText` are the project's choice and run; GitLab removes their lines, which the region-only read-back allows.
The squash is `<title>`, a blank line and the story's plain summary with any breaking-change footer, never the rendered description ("GitLab merge requests" above).

Evidence: `providers/gitlab/attachments.test.ts` (the multipart upload, media protection, identity, role and returned-reference rules), `providers/gitlab/gitlabForge.test.ts` ("saved-story writes"), `presentation.test.ts` ("the layout GitLab can actually display"), `providers/gitlab/gateway.test.ts` (the raw-write refusals), `tests/gitlabStub.test.ts` ("a saved story through the real GitLab forge and the stand-in": a refused private upload, uploads before the opening read back byte for byte, a lost upload answer, a restart with a person's words and the squash), and `tests/e2e/gitlab-delivery.spec.ts`, whose public and self-hosted journeys open the story and squash its summary.

Existing PRs are not rewritten into this format.
An open pull or merge request that predates saved stories takes `body` again on a later `open_change` (INF-291), on every host, and `prepare_change` points there.
The forge rereads it, replaces the whole description only while it is still open at the version and words just read, and `ChangePublication` reads it back, so the answer says what the host now shows rather than only that the change exists.
An identical body sends nothing, no body leaves the description unchanged, and the title is never renamed; each answer says which.
A refused or uncertain write, or a read-back with different words, is answered as that, and nothing is sent again on its own.
A plain Git host keeps no description for a pushed branch, and its answer says the body was not published.
Answer cards, in-place personal work and release-note hero pictures keep their existing delivery.

Preparation and ordinary publication reject tracked uncommitted changes, not untracked downloads such as `.infinitary-artifacts` archives.
The completion card reads its committed version and retained files; a hosted merge compares the remote request head with the published head, not a work computer's dirty copy or availability.
A local-only merge checks its committed branch and retained story again, without a forge read.
An accepted repair, one its crewmate declared to leave the approved work as it was, republishes the unchanged story automatically at the repaired version after checks pass, without another upload or completion card.
The completion offer binds a content hash; only the host's exact clone at a later version, for an accepted repair or any other push, inherits that hash, so a separately edited story requires a new completion offer rather than borrowing the kept approval.
The story's saved title, risk and required actions win on `emit_card presentation`; its title field is supplied, and body, body_file, risk and required_actions are omitted.

### Declared validation writes

A Careful builder names `github_write.validationEffect` when the write is a shared validation effect, rather than ordinary delivery.
The effect request's `forgeWrite` binds the host, method, path and SHA-256 digest of the exact JSON body bytes (absent only for a bodyless call).
A validation effect cannot accompany a release `file`: JSON-bound permission does not authorize those file bytes, so the gateway refuses without sending or consuming it.
The write gateway checks those facts at execution, also when sending a kept write, and marks its result unknown before sending so it cannot be repeated after a lost answer.
A changed call needs fresh review and consent; a refused validation check sends nothing and returns its reason.
A new request identity cannot repeat the same host, method, path and body while an earlier declared write on that task is started or unknown; the builder reconciles that outcome first.
Code clearance and the captain's action-specific approval must both be current; ordinary forge permissions remain separate.
An approved prerequisite publication names the task's own project and branch and uses a draft pull request or merge request where supported.
On a saved-story host it uses the existing publisher and attachment barrier, carrying the draft flag through the same opening rather than bypassing the story.
The publisher rechecks and consumes that authority after its preflight and before any upload; a failed preflight leaves the permission unused.
Ordinary Careful publication likewise rechecks the current proof and code clearance after that asynchronous preflight.
Once current proof and independent review pass, the host-owned `markReady` operation uses GitHub GraphQL or removes GitLab's `Draft: ` prefix; the agent-facing REST-only gateway never gains GraphQL access.
The host persists an unknown readiness outcome before sending and reconciles a later ready reading without another write.
A later still-draft reading settles that readiness attempt as not applied and permits another idempotent request, never concurrently with an outstanding attempt.
Readiness failures remain on the task record and in tool feedback without preventing check readings.
Once readiness is recorded as applied for a change number and head, a later return to draft is a person's hold: check, watch and open readings never mark that same version ready again.
Later commits on the published branch require fresh proof and review, not another prerequisite-publication permission.
These permissions do not satisfy final live proof or grant a merge (`docs/delivery-rigor.md`, "Careful live validation").
