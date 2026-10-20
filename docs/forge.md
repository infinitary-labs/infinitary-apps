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
| `pull(number)` | the pull request by its number, open or not, merged or not, with its readiness (`mergeable_state`: clean, conflict, behind, blocked by the branch's rules, computing, draft) | the merge request by its number, with its readiness from `detailed_merge_status` | absent | absent |
| `putIn(change, headSha)` | merge, only at the checked head, taken only when GitHub answers `merged` | squash merge, only at the checked head (`sha`), taken only when GitLab reads it merged | fast-forward the default branch onto the checked head and send it up, never forced | not through the seam: the local land (`WorkspaceService.landTaskWork`) through the local-only posture |
| `close(change)` | close without merging | close without merging | take the sent-up branch back | nothing to close |
| `openChange` | open a pull request onto the default branch | open a merge request onto the default branch | send the branch up | refused as `unsupported` |
| `label(change)` / `url(change)` | `#N` and its page | `!N` and its page | the branch, no page | the branch, no page |
| `listProjects()` | the person's repositories, newest first, every page up to 1,000 (`listProjectsPaged` also says whether that was all; `findProject` reads one exact owner/name) | the person's projects, newest first, up to 1,000 (`findProject` reads one exact nested path) | none | none |
| `hasChecks` | yes: the app watches them (below) | yes | no: nothing is watched, and the crewmate is told so | no |
| `workflows` | read-only Actions runs, jobs, logs and artifact downloads | read-only pipelines, jobs, logs and artifacts archives | unsupported | unsupported |
| `api` | the gateway's raw REST call under GitHub's policy | the gateway's raw REST call under GitLab's policy | unsupported | unsupported |

A `Forge` is per repository.
`createForgeResolver` in `src/core/forge/index.ts` picks it from the repository's `host`, which the registry stamps from its `origin` through `forgeOf` (`src/shared/forge.ts`) at insert and migration 40 backfilled for older rows (logged in `forge_backfill`).
The composition root binds an implementation per kind (`ForgeBindings`); a kind with none is a plain host.
GitHub and GitLab are bound; they are the kinds with change requests (`hasChangeRequests`, `src/shared/forge.ts`), which the merge path, the kept merge approval and the settle words read instead of naming GitHub.
Bitbucket is recognised by name and behaves as a plain host.

## The kinds

- `github`: `providers/github/githubForge.ts`, GitHub's REST API with the app's own GitHub sign-in as a bearer token (git integration PR 1.2; below), on github.com and on each GitHub Enterprise host at that host's own API (`githubApiBaseFor`).
  `INFINITARY_GITHUB_API_URL` (github.com) and `INFINITARY_GITHUB_ENTERPRISE_API_URL` (every enterprise host) are honoured only in an unpackaged app.
  The composition root (`src/core/services.ts`) binds every GitHub project to it; no other program's GitHub sign-in is ever read, and the app no longer runs any GitHub tool of the Mac's.
- `gitlab`: `providers/gitlab/gitlabForge.ts`, GitLab's REST API (`/api/v4`) with the app’s own sign-in, on gitlab.com and on each self-hosted server ("GitLab merge requests" below).
- `git` (and `bitbucket`): `providers/plainGit.ts`, git against the repository's own `origin` with prompts off.
- `none`: `providers/noHost.ts`.
  There is nowhere to send a change.

## The app's own sign-in (PR 1.2)

The owner's verdicts: an OAuth App with the device flow; ignore any GitHub sign-in already on the Mac; GitHub only for now; the sign-in lives in Settings -> Projects; and nothing ever makes a host look required.

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
  The app once kept only the access token, so the owner's sign-in died eight hours in, while the app was closed, with no revoke in his security log.
  Now `pollForToken` keeps all three, and `ForgeSignIns` renews with `refreshSignIn` (`POST /login/oauth/access_token`, `grant_type=refresh_token` and the client id; a device-flow sign-in needs no secret): ahead of the end by `RENEW_LEAD_MS` (10 minutes) on the tick and before handing a forge request its sign-in, at the first read after a start when it ran out while the app was closed, and once when GitHub answers 401.
  A refresh token works once and retires the access token it came with, so renewals run one at a time per host, and a renewal never writes over a sign-out or a new sign-in made while GitHub answered.
  A refused refresh token is dropped from the file.
  A renewal fires `onRenewed`, which takes down a card a git refusal raised and dispatches the work held behind `forge-sign-in:<host>`.
  The health log dates each renewal (`sign-in renewed, short-lived until <ISO>`) and each refusal.
  A sign-in GitHub issues without a refresh token behaves as before.
- **The one host card**: `card-forge-<host>`, "Sign in to GitHub again", raised only on `needs_reauth`, naming how many proposed changes wait on it; its one action is `open projects` with `signIn`, which lands on Settings -> Projects with the code already on screen.
  It takes itself down when GitHub answers again.
  An unreachable GitHub is one feed line ("Could not reach GitHub - trying again."); a 403 on opening a change is one feed line asking for write access.
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
  The worktree is not created and the task returns to the queue behind `forge-sign-in:<host>`; a host card opens Projects with that host's sign-in started.
  When the host's existing sign-in reports `ok`, the gate is cleared and the task is dispatched again, re-fetching its base.
  DNS, connection, SSH, other-host and unstructured text failures continue through the ordinary stale-ref fallback; they never trigger GitHub sign-in.
- **The crewmate's pair** (`src/core/pi/forgeTools.ts`, entries of the crewmate tool spec both runtimes generate from, `docs/claude-client.md`): `open_change({ title, body })` offers the task's branch as a proposed change (on GitHub the crewmate sends the branch up first; on a plain host the forge sends it) and records `pr_opened`; `check_change({ diagnosis?, repair?, rerun?, conflictRepair?, captainGuidance? })` records explicit evidenced failure classifications, stable own repair ids/results, the one flake reservation, a repair of a change the captain's kept merge approval covers, or what his newer words do to that change (`docs/delivery-rigor.md`) - a baseline-blocked diagnosis is answered with where its dependency stands: not started, underway or queued, or done (FI3-671) - and reads the same checks the completion card's gate does, recorded through the same service so the fact strip and the repair ledger see it.
  Handed to every crewmate whose task ships a change, never on the personal workspace or an answer task.
- **The personal panels' read**: `forge.changes` (`inf:forges:changes`) - the captain's open pull requests on every GitHub and GitLab host he signed in to, newest first across them, each with its checks and the host's own name for it (`label`: `#12`, `!4`).
  GitHub's come from one GraphQL request per host with each one's check rollup (`providers/github/changes.ts`); GitLab's from `GET /merge_requests?scope=created_by_me&state=opened`, 20 at most, then each merge request's own read for its head pipeline, five at a time (`providers/gitlab/changes.ts`): a passed or skipped pipeline is passed, a failed or cancelled one failed, any other pending, and none is none.
  A host that cannot be read makes the read unreachable this time, never a guessed row; a GitLab 401 counts as a sign-in only once GitLab no longer answers for the key.
  The `github-prs` authoring skill teaches it; no panel shells out for it.
  `tests/gitlabStub.test.ts` reads GitLab's rows on both kinds of host, and `tests/e2e/ui-kit-panel.spec.ts` shows a GitLab merge request as `!1` beside GitHub's pull requests in the panel that skill teaches.
- **Where it shows**: Settings -> Projects, section "Where your projects live" (`src/renderer/src/settings/ForgeSection.tsx`; design skill `components/projects/ForgeRow`).
  With nothing signed in it is one quiet line and a chip.
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
- **Settings** (`ForgeSection.tsx`, design skill `components/projects/ForgeRow`): "+ GitHub Enterprise" opens the key form; a known host's chip, its row's "Sign in again" and a card's sign-in open it filled in for that host.
  The row reads "github.example.com" over "GitHub Enterprise · as mona · 2 projects here".
- **How GitLab fits**: a self-hosted GitLab is one more `ForgeServer` (kind `gitlab`, git user `oauth2`, its own `whoAmI`), one more binding for `gitlab`, and its kind in `forgeAuthRequired`'s list; the known hosts, the stamping, the key form, the store's `kind`/`gitUser`, the helper and the host-keyed waits are already its.
- **Not yet**: a computer that runs work signs in to github.com alone (`docs/helper.md`), so a GitHub Enterprise project set to run there is tried with that computer's own git setup; a host whose certificate comes from a company's own authority is not trusted by the app's requests; a workflow artifact a server keeps on storage other than its own host or GitHub's is refused as an unsafe download; and only the captain's own words sign the first mate out of github.com, not another host.

## GitLab sign-in and projects

GitLab offers browser sign-in and a key alternative on gitlab.com and on the person's own server.
The GitLab chip opens browser setup with gitlab.com; changing Address selects a self-hosted server.
The browser flow uses GitLab's device authorization grant (generally available in GitLab 17.9), reusing the same code, Copy code, Open and Cancel aside as GitHub.
Older servers keep key sign-in.

### Registering the application

An application belongs to one GitLab host, never every server.
The project carries no shared gitlab.com application, so the app guides a personal registration there as well as on self-hosted servers.
Settings opens `https://<host>/-/user_settings/applications` and explains the host's fields: name Infinitary, Confidential off, scopes `api` and `write_repository`, and Redirect URI `https://<host>/oauth/device` (required by registration, unused by the device grant).
The person supplies the Application ID, never the Secret; if server policy prevents registration, its administrator can supply an ID or the person can use a key.
The Application ID survives a successful sign-in in the same host's file and prefills a later browser setup; signing out forgets it with the sign-in.

### Browser sign-in and renewal

`inf:forges:sign-in-browser` hands the host, kind and public Application ID to `ForgeSignIns.signInWithBrowser`.
`providers/gitlab/oauth.ts` sends `POST /oauth/authorize_device` with `client_id` and `scope=api write_repository`, then polls `POST /oauth/token` at the server's interval with the device grant, device code and client ID.
Pending waits, slow-down adds five seconds, expiry offers a fresh code, denial closes quietly, and Cancel or a replacement ends the attempt, including a delayed start or identity read.
Only the user code and same-origin verification page reach the view; the device code, access token and refresh token never do.
Both endpoints refuse redirects and bound their answers to 16 KiB and each request to 30 seconds; errors never repeat server response text.
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
`GitLabClient` sends `Authorization: Bearer` (accepted by GitLab for both keys and browser sign-ins) only to that API, refuses redirects, bounds each response to 256 KiB and each request to 30 seconds, and asks the existing health service to check a 401.
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
  On gitlab.com a new merge request's description is its saved story, opened only after every selected upload is confirmed ("Saved change stories", "On gitlab.com" below); a self-hosted server's keeps the crewmate's body.
  It is named `!N` with GitLab's page, and recorded on the task as `changeLabel`, `prNumber` and `prUrl` like a pull request; surfaces keep the app's word, pull request.
  Its head is the merge request's `sha`.
- **Its checks** are read for the head and nothing older (`checks()`):
  - every pipeline on the head counts - a branch pipeline, a merge request pipeline (`refs/merge-requests/<N>/head`) - and so does a merged-results or merge-train pipeline (`.../merge`, `.../train`), whose own commit is a merge of the head into the target branch: the app reads that commit's parents and counts it only when the head is one of them;
  - a later pipeline on the same ref for the same head stands for that ref, the way a rerun does on GitHub; pipelines on different refs all count;
  - each counted pipeline is one check and each of its jobs another (latest attempts, 100 a page, five pages, more is a pending item);
  - a running, created, pending, scheduled or waiting job or pipeline is `pending`; a failed one is `failure`, a cancelled one `cancelled`, a skipped one `skipped`;
  - a manual job a person must start, and a pipeline GitLab marks `manual`, is `neutral`: it holds green without being red, and arms no watch, since nothing finishes on its own;
  - a failed job the project allows to fail and a manual job it marks optional read `skipped`, their names saying so, because GitLab's own pipeline passes without them;
  - with no pipeline for the head, the list is pending ("has not started yet") when the merge request ran pipelines for an earlier head, or the project runs pipelines for merge requests or for branches other than the default; a project that runs none reads green with zero checks, as on GitHub;
  - a merge request whose merge request pipelines ran for an earlier head and have none for this one reads pending even beside a branch pipeline that passed, so a merged-results pipeline that has not started never leaves a false green.
    A read GitLab refuses or answers unreadably fails the reading; it is never taken as no checks.
- **Its readiness** (`pull`) reads `detailed_merge_status`: `mergeable` is clean; `conflict` (or `has_conflicts`) is a conflict; `need_rebase` is behind; a draft is a draft; an approval, a discussion, a required pipeline or another rule is blocked; GitLab still checking, or a status the app does not know, is computing.
  A server older than `detailed_merge_status` answers `merge_status`.
- **Its merge** (`putIn`) checks the merge request's title is conventional, then asks `PUT /merge_requests/<N>/merge` with `sha` (GitLab refuses 409 when the merge request moved on), `squash: true` and the squash commit message `<title>`, a blank line and the description.
  A saved story on gitlab.com ("Saved change stories" below) gives its plain summary and breaking-change footer in the description's place.
  A 200 is not a merge on its own: an answer that does not read merged is read back once; a merge request GitLab has locked while it merges is a transient answer the merge path reads back again, and anything else but merged is refused with GitLab's `merge_error`.
  A locked merge request reads open and computing, never closed.
  GitLab's 405, 409 and 422 are `refused`; the kept approval reads the merge request's own readiness for the cause, and the feed recognises 422 "Branch cannot be merged" as a conflict.
- **A 401 is not always a sign-in.**
  GitLab answers 401 when a working key may not accept a merge request; the client then asks `GET /user` with the same key, and a key GitLab still answers for makes the refusal `permission`, while only a key it refuses there is `sign-in` and asks the health service to look again.
- **Its words** name the host: "Merged !4 on GitLab.", "gitlab.example.com holds it for a required review or another rule on the main branch", "the app's GitLab sign-in is needed" - `forgePlace` and the forge's label, never GitHub by default.

Evidence: `tests/gitlabStub.test.ts` drives the real forge against the e2e stand-in on both host kinds (open, find, close, every check rule above, the stale-head, conflict and closed refusals, the squash and its message), `providers/gitlab/gitlabForge.test.ts` holds every readiness status, the merge read back and the 401 rule, `prCi.test.ts` ("a merge request on GitLab") and `crewSupervisor.test.ts` (a kept GitLab merge approval waiting on GitLab's rules, then merging) hold the delivery path, and `tests/e2e/gitlab-delivery.spec.ts` runs the journey on gitlab.com and a self-hosted server: a crewmate's merge request, its pipeline as the card's checks and the captain's squash merge at the pushed version, and a moved head, a conflict, a failed pipeline, a running job, a manual job nobody started and a failed merged-results pipeline each merging nothing.

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
  "Where your projects live" lists a row per computer and host under this Mac's own (`settings/DeviceForgeRows.tsx`): "GitHub · octo" over "Mac mini · clones and pushes its own work", or the computer's name over "not signed in to GitHub" with a secondary Sign in, whose code to read shows in the aside under the row.
  This Mac's row then reads "GitHub · octo" over "this computer · opens, checks and merges pull requests".
  A computer older than `FORGE_SIGN_INS_SINCE` says no hosts, so it gets no row.
- **The card, and the typed refusal** (the captain's picks on FI3-1350).
  A project that lives on GitHub set to run on a computer that offers a GitHub sign-in from here and holds none raises the host's own card for that computer, "Sign in to GitHub on Mac mini" (`CardService.addDeviceForgeSignInCard`, its words `src/shared/deviceSetup.ts`): "website runs on Mac mini now.
  Mac mini needs its own GitHub sign-in to clone it and push." and "Its next task waits for it.
  This computer's GitHub sign-in is not sent there.", with one button that opens Settings -> Projects with that computer's sign-in started under its row (`forgeSignInOn`); the feed says "website's next task waits for Mac mini's own GitHub sign-in." once per project and computer.
  It is raised when Runs on names such a computer (`DeviceSetup.runsOnChanged`), when a task is about to start there (`CrewSupervisor.placedWaitFor`, before anything is tried), and when that computer's clone is refused: the computer answers `inf:working-copy:prepare` with `{ refused: "forge-sign-in", host, name }` rather than a failure's words (`SessionHost`, from `forgeAuthRequired`), the home reads it as `ForgeAuthRequiredError` (`PlacedCopies.prepare`), and the task waits behind `forge-sign-in:github.com@<device>`, never this Mac's own GitHub card.
  While that computer's setup card is on the stack (`docs/devices.md`, "Finishing its setup"), its own GitHub row asks instead and no second card goes up.
  The moment the computer reports its GitHub sign-in, the card comes down and every task held for it starts (`CrewSupervisor.resumeDeviceForgeSignInTasks`).
  A computer too old to offer the sign-in from here is tried, and a refusal there holds the task the same way.

## Workflow logs and artifacts

Crewmates collect CI diagnosis and measurement evidence through the app's own sign-in.
A program the captain asks a crewmate to run still runs; these tools do not read another program's sign-in.
`read_workflow` and `download_artifact` are entries of the same runtime-neutral tool spec as `open_change`; both Pi and Claude receive them, including project answer tasks, never personal-workspace tasks.
The supervisor binds the task id, `WorkflowEvidenceService` resolves its registered project and working copy, and the optional `Forge.workflows` capability reads only that project's GitHub Actions API, or its GitLab pipelines, using the existing app-owned sign-in.
Reads do not record a CI reading, classify a failure, reserve a rerun, spend a repair, or modify a workflow.

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
`tests/e2e/forge-signin.spec.ts` commissions a crewmate in the hermetic app with the app's sign-in, lists the version's run, jobs and artifacts with `github_read`, reads a failed measurement job, downloads and reads the ZIP's JSON, and separately proves missing sign-in reports a blocker without an Actions request.
`crewmateTaskTools.test.ts` holds the Pi and Claude tools to the same callbacks, descriptions and schemas.
`src/core/forge/providers/gitlab/workflows.test.ts` drives the same tool entries over a GitLab stand-in - the version's pipelines and jobs with `github_read`, a log paged without colour codes, the archive saved from signed storage the key never reaches - and every refusal: another pipeline's job, a missing, expired or oversized archive, a 401 by whether GitLab still answers for the key, an unknown redirect, and the bounds; `tests/gitlabStub.test.ts` reads the e2e stand-in's log and archive on both kinds of host, and `tests/e2e/gitlab-delivery.spec.ts` has a crewmate on gitlab.com and on a self-hosted server list a failed pipeline, read its job's log, save and read its archive, and be refused a write to another project.

## The gateway (`github_read`, `github_write`)

The captain's plan (FI3-70, locked 25 Sep): crewmates reach the rest of a project's GitHub REST API through the app's own sign-in.
Use this connection for the crewmate's own GitHub work.
When the captain's own words ask a crewmate to run a program, that rule is in the crewmate prompt.
Two entries of the runtime-neutral tool spec, both Pi and Claude, served by `GithubGatewayService` (`src/core/orchestrator/githubGateway.ts`) over the optional `Forge.api` (`src/core/forge/api.ts`): each host's raw call, its own policy (`route`) and its next page (`nextPath`).
On a GitLab project the same two tools reach GitLab's API (below); they keep their names, because GitLab's paths are not GitHub's and a crewmate names the one where its project lives either way, and a renamed tool would break every crewmate session that already holds them.
`github_read` (GET/HEAD) and `github_write` (POST/PATCH/PUT/DELETE) go to any non-personal task; every write of a task that only answers asks the captain (below).

- **Reads reach what the sign-in may read; writes go at once only to the task's project.**
  `path` is a relative path checked by `parseApiRequest`; the caller never names a host, token or header.
  A read that passes the shape checks is sent, and the host's own status and answer come back (FI3-1571 piece 3): there is no read list.
  That reaches the person's account, organizations, notifications and members as well as every repository the sign-in can see; the sign-in's own permissions decide.
  A write to `/repos/{owner}/{repo}/...` of the task's registered project, from a task that ships a change, is sent at once; the policy routes it as `own`.
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
  A JSON request body is 256 KiB, one answer 256 KiB (refused, never cut), a JSON call times out at 30 s, and a task may make 200 calls per app run.
  A release file has its own 2 GB cap and a 30-minute send ("Release files", below).
  Redirects are never followed.
  The answer carries the status, request id, rate limit or retry-after, and `nextPath` whenever GitHub's next page stays on the API origin and under its own path - including a repository listing's `/repositories/{id}/...` pages (FI3-1546).
  An absolute link in the answer's body loses a `token` or `access_token` query parameter before the crewmate or any saved file sees it; the file's content stays, and the answer says the download tokens were removed.
  Tokens already saved are left where they are.
  A GitHub refusal (422, 404, 403) is a status in the answer; a 401 asks the health service to look again.
  Nothing is retried for the crewmate.
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
  A `/pulls` page carries two repository objects and the whole description of each pull request, so on this project even 15 to a page passes the 256 KiB cap and is refused.
  `/repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc` lists pull requests too, each with `pull_request.merged_at`, and 30 to a page fits here; a refused page asks for a smaller `per_page`.
  GitHub names a repository listing's next page by repository id (`/repositories/{id}/...`); that answer's `nextPath` reads it, so the crewmate pages on without adding `page=N` itself (FI3-1546).
  File-level work belongs in git, not the API: `git fetch origin '+refs/pull/<n>/head:refs/remotes/pr/<n>'` brings a pull request's head into the working copy through the app's own sign-in.
  `refs/pull/*/head` brings them all, into refs that every working copy of the clone shares.
  `git merge-tree --write-tree --merge-base=<base> <head> <other>` then replays a conflict between two of them with no API call, and a squash merge on the default branch carries its pull request's checked title as its subject.
- **Verification workflow requests reuse the gateway.**
  A crewmate calls `github_write` with `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` and GitHub's normal JSON body, such as `{"ref":"<branch-or-tag>","inputs":{"profile":"alpha"}}`.
  The caller chooses the workflow, ref and optional inputs its task needs; the host adds no task-branch or input restrictions.
  Starting, cancelling, enabling, disabling and rerunning workflows are project operations, not account administration.
  A successful response means GitHub accepted the request, not that checks passed; find its run with `github_read`, confirm `head_sha`, then take a short `read_workflow({ runId })` read to watch that run and end the turn.
  Use `check_change` separately for a pull request's checks.
  Dispatch itself changes no check or repair facts.
  A write whose outcome is uncertain is never retried automatically; read the project's state before deciding what happened.
- **Accepted reruns refresh the checks.**
  `POST .../actions/runs/{id}/rerun`, `.../rerun-failed-jobs` and `.../actions/jobs/{id}/rerun` are available without a gateway reservation veto, like other project operations.
  On acceptance, the gateway dates an existing unspent current-head rerun reservation when there is one; it neither invents repair history nor rewrites a previous receipt.
  It then takes the crewmate's check reading up to three times, two seconds apart, until the rerun reads as running, arming the ordinary check watch.
  The crewmate still follows its CI diagnosis and evidenced-flake rerun instructions; those govern its work, not which GitHub endpoints exist.
- **Not built yet:** automatic retry of safe reads.

### A write that asks

FI3-1571 piece 4, the captain's answers: the crewmate asks, and the app adds the exact call and the button; a task that only answers asks for every write it makes; GitLab follows the same rule.
`github_write` keeps, instead of sending, a write outside the task's own project, any write of a task that only answers, and any write through the github.com sign-in.
The merge guard runs first: a merge or default-branch move on the task's own project is refused with its pointer to the merge card, asked or not, and so is deleting a GitLab project or a GraphQL call.
The kept write is a `WriteAsk` on the task's delivery facts - its host, whose sign-in sends it (`project` or `account`), the method, the policy's path, the JSON body, and for a release file the path of that file in the working copy - kept through `TaskService` (`keepWriteAsk`), newest first, at most 8 (`WRITE_ASK_CAP`).
A release file's bytes are read when the click sends it, not when the ask is kept.
The answer names the ask's id and tells the crewmate to put it on a card.
`emit_card` takes an action whose effect is `{ kind: "request_write", ask }`, beside the crewmate's own Not now and its words on why.
The emit refuses an ask that is not the task's or was already taken, two asks on one card, and an ask beside a merge or discard; only a crewmate's card on its own task may carry one.
The host names the button "Send it to GitHub", after the host's own name ("Send it to GitLab", or a server's address), and draws the exact call at the end of the body (`.inf-call`, `writeAskStrip`): the method and path, the JSON body as kept, and whether it goes through the github.com sign-in.
A card that asks is never a task's answer: the captain's click on it leaves an answer task open.
Only the captain's click from the card's own controls sends it (`GithubGatewayService.sendAsk`); a script on the card, a reply, the who-merges setting and the first mate never do.
`TaskService.takeWriteAsk` marks the ask taken in one transaction before anything is sent, so a second click, a restart or a revised card naming it sends nothing again, and the emit refuses it.
The click sends exactly what was kept, through the same sign-in, after the same policy and merge guard; a host that changed since the ask sends nothing.
It spends one of the task's 200 calls only when it is sent.
The outcome is recorded on the ask: the host's status, nothing sent (a refusal or a missing sign-in), or unknown - a call that may have reached the host without an answer - which is never sent again.
The crewmate hears it once (`write-answered`), with the host's answer within the gateway's caps, and the task's timeline keeps one line.
A task's close drops its asks that were never sent.
A crewmate on another computer asks the same way: its write and its card reach the home, which keeps the ask and sends it (protocol 5.0, `docs/contract.md`).
Evidence: `tests/e2e/forge-signin.spec.ts` - a write to another repository, a project kept on this computer creating its GitHub repository through the github.com sign-in, and a task that only answers writing to its own project - each shows the exact call on the card, nothing sent before the captain's key, one request after it, the crewmate hearing the answer, and the same ask on a revised card refused; `tests/e2e/gitlab-delivery.spec.ts` keeps a write to another GitLab project unsent.

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
  On gitlab.com, the task's own merge request is opened, and its saved description replaced, only through `open_change` ("Saved change stories", "On gitlab.com").
- **Reruns**: `POST .../jobs/{id}/retry`, `.../jobs/{id}/play` and `.../pipelines/{id}/retry` are reruns: an accepted one records an existing reservation and arms the check watch as on GitHub.
- **Its answers** carry GitLab's `x-request-id`, its `RateLimit-Remaining` and `RateLimit-Reset`, `Retry-After`, and `nextPath` whenever the next page stays under the server's own `/api/v4`.
  A redirect is refused, and a 401 asks GitLab who the key is before it asks the health service to look again.
  An absolute link in the answer's body loses the same `token` and `access_token` query parameters as a GitHub answer, before it is saved.
  Refusals and the call budget name the host: "Cannot call GitLab", "Cannot call gitlab.example.com".

Evidence: `src/core/forge/api.test.ts` (the policy) and `src/core/forge/providers/github/gateway.test.ts` (the tool entries over a real HTTP stand-in, including caller-selected refs/inputs, project operations, reads of other repositories, search and the account, a task with no project, GraphQL and account-write refusals, the rerun arming the watch, and a private file read that keeps the file and drops GitHub's download token), and the journeys in `tests/e2e/forge-signin.spec.ts`: the verification requests (an existing disposable ref with workflow inputs, app-owned sign-in, queued run and cancellation, account-scope refusal and missing sign-in), and a project kept on this computer reading the person's notifications and a repository listing's `/repositories/{id}` next page through the github.com sign-in, with GraphQL never sent.
GitLab's are `src/core/forge/providers/gitlab/api.test.ts` (its policy: encoded paths, reads anywhere, account writes kept out, own-project writes, the project's deletion, reruns and next pages) and `src/core/forge/providers/gitlab/gateway.test.ts` (the tool entries over a GitLab stand-in: reads by encoded path with GitLab's ids, allowance and next page, other projects' reads, refused writes, a 401 by whether GitLab still answers for the key, a job retry arming the watch, redirects, oversize, a missing sign-in and the budget).

## The app's own git (phase 2)

The owner's verdict: git is bundled with the app, the GitHub Desktop model, because most people who use Infinitary have never installed developer tools, and a Mac without them has no git a Dock-launched app can run.

- **What ships**: dugite-native's macOS git, pinned by the `dugite` dependency's own manifest (`script/embedded-git.json`, its archive and checksum per platform).
  `scripts/ensure-bundled-git.ts` (postinstall, macOS only) fetches BOTH architectures, verifies each against that checksum, caches the archive under `~/Library/Caches/infinitary/bundled-git/`, unpacks it once into `trees/` beside it, and clones that tree into `vendor/git/darwin-<arch>/` (gitignored); dugite's own postinstall is off (`pnpm-workspace.yaml`), since it fetches only the machine's architecture.
  The clone (`scripts/clone-or-copy.ts`, macOS's `cp -c`, since Node cannot clone there) lets every working copy on APFS share the tree's blocks; a disk that cannot clone gets a plain copy.
  Git Credential Manager and its .NET runtime are left out - another sign-in that could answer or prompt for a host, which the owner ruled out - and so is git-lfs, which nothing under the app configures.
  `electron-builder.yml` ships the two trees outside the archive (`extraResources` to `Contents/Resources/git/`), names them in `mac.x64ArchFiles`, and ships `resources/git-bin/` beside them; `scripts/check-bundled-git.sh` (run by `scripts/verify-app.sh` at every release gate and by `verify.yml`'s package smoke) fails a bundle without either tree or with the wrong architecture in one, and runs the one for its own architecture through `git-bin` with an empty environment.
- **Who runs it** (`src/core/workspace/bundledGit.ts`, taken once by each composition with `adoptBundledGit`: the app's own and the work mode's, `docs/helper.md` "Running"): every host git (`git.ts`) runs the tree for `process.arch` by path, with the environment dugite's `setupEnvironment` gives it (`GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_CONFIG_SYSTEM`, which includes the Mac's `/etc/gitconfig`); the person's own `~/.gitconfig` still applies.
  `hostEnv` puts `resources/git-bin/` - holding only a `git` that runs the tree named by `INFINITARY_GIT_DIR` with the same three variables - first on every child's search path, so a crewmate's shell, and the shells Claude's client runs, find the app's git first.
  The git sign-in environment above rides every one of those runs unchanged.
- **Without it**: an unpackaged checkout that has not vendored the trees (any platform but macOS) runs the git on its search path, as before; `INFINITARY_SYSTEM_GIT=1` asks for that on purpose in dev and e2e, and a packaged app ignores it.
- **A limit**: Apple's git reads its own system config, which names the Mac keychain's credential helper; the app's git does not, and that helper is not part of it.
  A plain host reached over `https://` whose sign-in only that helper held now answers nothing under the app (git fails at once, never prompts).
  GitHub (the app's sign-in), SSH origins (the person's agent) and helpers named in the person's own `~/.gitconfig` with a path are unaffected.

## The green rule

One home: `overallOfChecks` in `src/core/forge/forge.ts`; GitLab's pipelines and jobs reach it as checks ("GitLab merge requests" above).
Green when every check completed successfully or was skipped; terminal failures are red; anything else - queued, running, neutral - blocks green without being red; zero checks reads green, so a project with no checks can still put work in.
On GitHub an empty list is not always "no checks": when GitHub holds a workflow run for the version, or has run workflows for the project's pull requests before, `checks()` returns one pending item ("checks have not started yet", or - when the change conflicts with the default branch, where GitHub starts no pull-request workflows - the need to bring it up to date), which arms the check watch and keeps the completion card's last check and the merge click from reading green in the seconds before checks start.
On GitHub both check runs and commit statuses count.
Every unfinished workflow run on the version also counts as pending, even when every listed check passed: GitHub may not yet have created a job waiting on another job.
This keeps a re-run of a prerequisite from briefly reading green before its dependent check appears.

On GitHub a cancelled check run can be superseded (FI3-585).
GitHub lists every workflow run's checks on a commit; its default `filter=latest` drops only earlier attempts inside one workflow run.
When one version gets two runs of one workflow - PR #632's `e5cacebe` got two `ci` runs from one push, and `ci.yml`'s `cancel-in-progress` concurrency cancelled the older before its Linux check took a step - the older run's cancelled check stays on the list beside the newer run's pass, and counting both reads red forever.
`checks()` sets a cancelled check run aside only when its workflow run has a later run (higher `run_number`) of the same workflow, started by the same event, on the same version.
That later run's check of the same name decides; while the later run has not created it yet, the check reads pending.
Nothing else is set aside: an earlier failure, time-out or unfinished check counts beside a later pass; another workflow or event with the same check name is a different check; and a check the app cannot place in a workflow run counts as it reads.
The version's workflow runs (`GET /actions/runs?head_sha=`) are read once per check reading, shared by unfinished-run guarding, cancellation handling and the empty-list read.
More runs than the list holds add a pending item rather than claiming the reading is complete.
An unreadable run list leaves the existing check reading; a refused sign-in still fails the reading, as does a hiccup when cancellation handling needs the list.

## A requested merge

`request_merge` is the agent-facing request to merge one reviewed pull request (FI3-1543).
`check_change` with `pull` stores a review of that number in the task's project and returns its id.
Preparing the review grants no approval and merges nothing.
The card effect `request_merge` names that id.
With autonomy off, only the captain's button authorizes the merge.
The host derives whether the pull request is the task's own or one it adopted, such as a release tool's, from the records, not from the card.
An owned merge uses the ordinary guarded path and finishes the task.
A referenced merge is GitHub only, including Enterprise, same repository, into the default branch, and keeps the task and its working copy.
A changed head, a failed or unreadable check, or a draft or protected branch sends no merge.
Only a pull request GitHub reads as clean at the reviewed head is sent, so a sign-in that could bypass the branch's rules never does.
GitHub answers `mergeable: null` while a check it has just started works out a test merge, often just after the default branch moved, and asks to be read again shortly (INF-457).
At the captain's click, that answer is read again after 1, 2, 3, 5, 8 and 11 seconds (`UNDECIDED_REREAD_MS` in `src/core/orchestrator/prCi.ts`), and every read is checked as the first one was.
The merge goes as soon as GitHub reads clean at the reviewed head; a moved head or a closed pull request still sends nothing, and GitHub still undecided after half a minute refuses the click, saying how long it asked.
The card's own read before it goes up asks once.
Evidence: `tests/e2e/request-merge.spec.ts` ("... waits while GitHub works out whether it can merge ...") merges an adopted pull request after two undecided answers, and `prCi.test.ts` (INF-457) holds the refusal after the wait and a version that moves during it.
An absence declaration is stored only when it names that exact head, with evidence and a local gate.
It waives only the host's own "checks have not started yet" marker, never a failed, pending or unreadable check.
A confirmed referenced merge wakes the crew once.
Dropping the task does not close that pull request, because the task's own change is still what discard closes.

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
An owned review finishes the task and a referenced one continues it, as above.
Not established: whether GitHub honours `bypass_rules` for the app's sign-in, an OAuth App, or on GitHub Enterprise Server.
No real merge past the rules has been attempted; the check is the captain's, on a throwaway repository.
Evidence: `tests/e2e/request-merge.spec.ts` ("a merge that skips the branch rules ...") has a scripted crewmate prepare an adopted release pull request held by a review rule and a failed check, reads the rules and the check off the card, finds nothing sent before the captain's key and one asynchronous merge with `bypass_rules` after it, and refuses the same review on a revised card.

## The check watch

The host reads a change's checks for the crewmate while they run, with plain forge calls and no model turn (`src/core/orchestrator/checkWatch.ts`).
It wakes the crewmate once when the first check fails and others are still running, and once more when the checks finish.
Before it, a crewmate re-read `check_change` until its checks settled - up to 40 full-context model turns on one task.
The design follows the firstmate repo's PR poll: a watcher that is not a model, bound to the change and its head, never doubled.

- **Armed** by a reading that finds a check still queued or running (`PrCiService.record`), on a forge whose `hasChecks` is true: the crewmate's `check_change` or the completion card's CI gate.
  A reading that is only held back by a neutral check arms nothing: nothing is left to finish.
  A plain Git host or a project kept on this Mac has no checks, so nothing is watched and `check_change` says no wake will come; a new forge kind with checks implements `checks()`, sets `hasChecks`, and is watched with no change here.
- **Durable**: the watch is a delivery fact on the task, `ciWatch { head, since, nextAt, tries, failureSeen }`, so it outlives a restart and ends with the task.
  A reading at the head already watched keeps its start.
  `failureSeen` means the early wake for that head already went, or the crewmate already read a red check, so that wake is not sent again.
- **Read** on the shared 60 s tick (`CrewSupervisor.pollCheckWatches`, through `PrCiService.readWatched`): every minute for 10 minutes, then every 2, up to the two-hour bound.
  Every successful reading updates the saved reading time, even when running checks keep the same status and head, so the reading time shown on rest stays current.
  Running readings record a `ci` event when the status or head changes; settled readings record a `ci` event, raw failure history and, only for an unsuccessful declared own repair, an attempt and its cap.
- **Quiet refresh** continues every five minutes (`CHECK_REFRESH_MS`) for live tasks with a recorded open pull request, even after a watch ends, using the same reading and delivery facts.
  It runs on the shared tick after a restart too, backs off unreadable checks and stops on task close or a reading that finds the pull request gone or merged.
  A settled result or same-head rerun updates displays without a diagnosis wake; a new head whose checks are running arms the ordinary bounded watch.
- **Bound to the head**: a new head where the project lives re-arms the watch for it, and only the head it last saw is woken about.
  A reading the crewmate takes itself that finds the checks finished ends the watch (it already knows); the completion card gate's does not, so the crewmate still hears.
- **Two wakes at most** for one head, each a `checks-settled` steer on the crewmate's own lane, the supervisor's, through the ordinary steer path (it resumes an idle task).
  The first is `first-failure`, naming each red check, while others are still running.
  A read that first sees a failure and also sees the checks finished sends only the end wake.
  The end wake is whatever ends the watch: `passed`; `failed`, naming the red checks, or telling it to stop and report a blocker at the CI cap; `not-green` (a neutral check); `timed-out`, still running after `CHECK_WATCH_BOUND_MS` (two hours); `gone` (no open change for the branch); `unreadable` (a sign-in, permission or other refusal; a transient failure reads again inside the bound).
  Each wake is named by the watch and the event (`check-watch:<head>:<since>:failure` or `:end`), and the inbox records the name with the row it queues (`InboxStore.enqueueSteerOnce`), so a restart between the wake and the clear never sends it again.
  A wake recorded before the early wake existed, named `check-watch:<head>:<since>`, still counts as the end wake.
  A red check is a state the green rule already calls red; pull request checks carry no allowed-to-fail flag, so the watch does not guess one from a name.
  The early wake spends no repair round and does not change how a pull request goes green.
- **The idle ladder** reads a standing watch as the task moving (`Witnesses.checksWatched`, `docs/report-sort.md`): the crewmate that ends its turn to wait is neither nudged nor reported stuck, and its report wakes nobody until the checks finish.
  The early wake does not clear the watch, so the task still reads Waiting for checks.

## The checks cell's time

Wherever the app shows a task's checks - the fact strip on the crew summary and the task record, and the merge card's Checks cell - it says how long they have been running, or how long they took, counted by the host's own times (INF-587).
`checks()` keeps each check's start and finish where the host gives them (`ForgeCheck.startedAt`, `finishedAt`): a GitHub check run's `started_at` and `completed_at`, a commit status's `created_at` and, once settled, its `updated_at`, a workflow run not yet listed as a check by its `run_started_at`, and a GitLab job's `started_at` and `finished_at`.
Every reading writes `ciStartedAt` and `ciFinishedAt` on the task's delivery facts (`checksSpan` in `src/core/orchestrator/prCi.ts`): the first check's start; once green the last check's finish; once red the first failure's finish.
A reading with no start clears both, so a new version starts the count again, and a rerun that the host lists as the newer check counts from its own start.
The cell reads `running for 15m`, `passed in 14m · 5m ago` or `failed after 9m · 5m ago`, in whole minutes redrawn each minute (`src/shared/checksSpan.ts`); on rest it shows when the first check started and when the app last read them.
Checks that have not started, not read yet or merged outside the app show no time.
The first mate's own facts keep the reading's age (`ciFact.ts`), because it judges a reading's freshness by it; Activity and the Now line keep each reading's own time.

A task with no change yet shows the run it started by hand instead, when the app watches one (INF-594, "The run watch" below).
The run reader keeps the host's times (`WorkflowRun.startedAt`, `finishedAt`): a GitHub run's `run_started_at`, the latest attempt's start, and once completed its `updated_at`, because a run has no `completed_at`; a GitLab pipeline's `started_at` and `finished_at`.
Every reading of a watched run - the crewmate's short read and the minute reader's - writes `runChecks` on the delivery facts (`recordRunChecks` in `src/core/orchestrator/runWatch.ts`): the run, its state (running, passed, failed or cancelled), its times and the reading's time.
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
A typed transient host failure reads again within the bound; a sign-in or permission refusal ends the watch immediately.
An incomplete jobs list is named on a failure wake rather than claiming every failed job was seen.

Wakes use `run-watch:<runId>:<since>:failure|end`, recorded by the durable inbox's ordinary once mechanism.
A restart preserves each watch and each sent name, so neither wake goes twice.
A closed task receives no wake; an overlapping crewmate read or close supersedes an outstanding poll.
A crewmate's own short read of failures suppresses the early wake it already knows, and its short read of an ended run clears the watch without a wake.
Starting and ending a watch each writes one task timeline line.
While a watch stands, `checksWatched` keeps the idle ladder from nudging or reporting the task stuck, and its existing posture reads Waiting for checks.
Each reading also keeps the run's state and host times for the checks cell ("The checks cell's time").

The run watch never writes pull request check readings, diagnoses, repair counts or merge permission.
`check_change` remains the pull request green gate; `github_read`, job log reads and downloads keep their existing contracts.
An accepted own-project `github_write` dispatch with `workflow_run_id` arms the run watch immediately and says so.
The crewmate sends `"return_run_details": true` itself; the app never adds it, because older GitHub Enterprise servers may refuse it.
A dispatch with no run number says to find the run through `github_read` and take the short `read_workflow` read; never repeat an accepted write to obtain its number.
Accepted GitHub run reruns use the route's run number, and job reruns read the job's `run_id` through the gateway (one budgeted call).
GitLab pipeline starts use the returned pipeline `id`, pipeline retries use the route's number, and job retries or plays use the returned `pipeline.id`.
The watch is armed before reading the run, so a rerun still being queued cannot clear it through a stale ended-run reading.
An existing watch keeps its original bound and sent wakes; a rerun after that watch ended starts a new watch.
A write kept for the captain arms no watch until his click sends it successfully, and writes outside the task's project never arm one.
The five-run limit still applies; a full watch list or an unavailable run number explicitly says to take a short read later.
Reruns of a task's pull request still record its existing rerun reservation and read its checks separately; a non-PR rerun makes no pull request reading.

## Failures are typed

A forge throws `ForgeError` with a `failure`: `transient` (a 502/503/504 or the host unreachable - `PrCiService.merge` retries these quietly, and nothing else), `sign-in` (a 401), `permission` (a 403, never retried; a spent hourly allowance says so), `not-found`, `refused` (a stale head, a default branch that moved on, branch protection), `unsupported`.
The raw words stay on the error for the record and `plainProblem`; the kind is what code decides on.

## Who reads it

`PrCiService` (`src/core/orchestrator/prCi.ts`, the crewmate's `check_change` and the completion-card gate) asks the seam and records what it answers on the task's delivery facts: `changeLabel` from `label()`, and `prNumber`/`prUrl` only where the host has them.
When the branch has no open change but the task names a pull request, the reading asks for it by its number with `pull`: merged outside the app, it records `ci: merged`, the strip reads "merged outside the app", and a put-in answers the merge already made and closes the task as merged without sending anything.
The settle card's fact strip (`CrewSupervisor.settleFacts`) and the record card read that label and link - never parse a number back out of a URL.
The record card still names where the change goes from the repository's `host` ("goes in on GitHub", "goes in on git.example.com").
Settings → Projects shows the same place on a project whose changes go there, and nothing at all on a project kept on this Mac or one whose changes go straight in: the captain's constraint is that a forge is never required.

The first mate reads the same facts (git integration PR 1.3).
Its context block's `lives` fact is the host's kind from the origin, and - only where the project's changes go there - the app's sign-in on it, from `ForgeSignIns.signInOn`: `github (signed in as octo)`, `github (not signed in)`, `github (GitHub no longer accepts the sign-in)`, `github (signed in as octo; not reachable just now)`; a plain host names its address (`git (git.example.com)`), and a project kept on this Mac is `none` or, when it has a host but its work goes straight in, the bare kind with no sign-in at all.
`crew_status` names where each task's proposed change goes as `goesIn` using `forgePlace`, and omits it wherever the work goes straight in.
Every other string the host writes about a change names the project's own host, never GitHub by default.

## The fence

Everything outside `src/core/forge/` imports `src/core/forge/index.ts`.
The provider files under `src/core/forge/providers/` are fenced by Biome `noRestrictedImports`: only the seam and the composition root may import one, the way Pi is reached only through `src/core/pi/`.

## Evidence

`src/core/forge/providers/*.test.ts` (the REST forge, the device flow and the open-changes read against a local HTTP stub, and a GitHub Enterprise host's API addresses and its pull request under `/api/v3`; the plain host against real repositories and a bare remote), `src/core/forge/signIns.test.ts` (the store's modes, the five health rules, the health log across a restart and a sign-out, a short-lived sign-in against a scripted GitHub - renewed at the next start after it ran out while closed, ahead of its end, on an early 401 and before a forge request, one renewal at a time, `needs_reauth` only on a refused renewal, `unavailable` when the renewal cannot be asked, never over a sign-out - every way a code ends, the git helper over the store's own file, and a key sign-in to a host on the person's own server - kept with its kind and git user name, refused, unreachable or not that kind of server with nothing kept, known from a project or by its `.ghe.com` name, its health and sign-out), `src/shared/forge.test.ts` (known hosts and typed addresses), `src/core/workspace/repoRegistry.test.ts` (stamping a known host's projects, never back), `src/core/workspace/forgeAuth.test.ts` (the refusal keyed by a known host), `src/core/hostEnv.gitSignIn.test.ts` (real git - the search path's and, on a Mac, the app's own - against a local HTTPS host: the helper answers with the app's sign-in and a helper in the person's own git config never does, and a host signed in since the helper was named answers with its own git user name), `src/core/workspace/git.test.ts` (the app's git resolved, run by the host and first in a crewmate's shell, the system git without it), `tests/e2e/app-git.spec.ts` (a crewmate's `git status` on a launch whose search path holds no git at all), `tests/e2e/run-work.spec.ts` ("a Mac with no git of its own": the work mode's join, clone, crewmate's shell and work brought home on a search path with no git), `src/core/orchestrator/prCi.test.ts` (the service over a fake forge, `open_change` and `check_change` included, and the check watch's arming and read), `src/core/orchestrator/checkWatch.test.ts` (the watch's minute-then-two-minute reads, its bound, a hiccup and a refusal, a change gone, a newer reading or a close while a read is out), `src/core/orchestrator/crewSupervisor.test.ts` ("the host's check watch": pending then green or red is one finish wake and no model turn between, a failed check while others run is one early wake, a new push re-arms for the new head, a host without checks is never watched, a restart mid-watch still wakes once), `tests/e2e/forge-seam.spec.ts` (a plain host), and `tests/e2e/forge-signin.spec.ts` (the sign-in in Settings -> Projects against a local GitHub stub - code shown, cancelled, refused, expired, approved; the first mate's listing; a crewmate's `open_change` and the captain's put-in; GitHub refusing the sign-in, the one card and signing in again; a project kept on this Mac naming no host; signing out, the health log's dated lines for all of it, a real quit and start bracketing the sign-in on file, and a short-lived sign-in renewing itself when GitHub ends it - one code exchanged once, no card, git's helper answering with the renewed sign-in; and a GitHub Enterprise host the app has never seen, signed in by keys alone with a key it first refuses, its projects then GitHub projects in the first mate's facts, listed through its `/api/v3`, git's helper answering it with the key, and a crewmate's pull request opened, read and merged there).
The stub hands a code's sign-in over once and spends a refresh token once, as GitHub does.
The direct-pr specs (`rigor-standard`, `rigor-reviewed`, `autonomy`, `settle-effects`, `honest-settles`) run on the same stub (`tests/e2e/githubStub.ts`).
A computer's own sign-in is `src/core/helper/signIns.test.ts` (GitHub's device flow on the computer against a stand-in GitHub, its store, its git's environment, its health and a sign-out from here, a stopped or expired code) and `tests/e2e/device-sign-ins.spec.ts` (Settings -> Projects against this stub, with the computer in the test's own process and git's helper answering with its sign-in).

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- The forge seam (git integration PRs 1.1-1.3; `docs/forge.md` is the one home): everything the app asks of where a project lives - a branch's open change, its checks, put it in, close it, what it is called - goes through `src/core/forge/index.ts`; the provider files under `src/core/forge/providers/` are Biome-fenced to the seam and `services.ts`.
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

A future github.com pull request or gitlab.com merge request and its completion card read one immutable `ChangePresentation` revision (`src/shared/changePresentation.ts`).
`prepare_change` validates the crewmate's publishable prose and selected inspected files without displaying a card, uploading bytes or opening a PR.
New stories use version 2: the same conventional title on the card and pull request, up to two short Why sentences, five change bullets, one Before and After sentence, and six typed `checked` facts (`check`, `result`).
Aim for 150 open words on the card and 250 on the pull request.
The schema carries the captain’s selected item counts; the author owns sentence length and word targets, with no invented per-sentence character refusal.
`verification` keeps commands, file names and counts behind How it was checked on both surfaces; nonempty unfinished work folds under Not done.
The card keeps its risk radar; the pull request gives one line naming dimensions above low and folds the seven-row assessment.
Empty required-action and unfinished sections, a frozen checks status and story/version stamps are absent.
Authors never put code versions, hashes or revision numbers in prose, captions, alt text, verification or project text, even folded; this is instruction only, with no prose refusal or redaction.
Capture versions and applicability remain retained data, never rendered on new stories.
Version-1 saved stories keep their rendering; already published descriptions are not rewritten automatically.
Changed views have Before and After media; new views have only After; an invisible change has no views and an explicit no-picture reason.
Under Before and after, each changed view pairs its Before pictures with its After pictures, with one caption per view and labels for each state.
A new view carries the New tag and After evidence only.
A view containing a recording stacks in both outputs because GitHub's and GitLab's native players ignore the requested width and overflow a two-column table.
Version-1 stories retain the author's optional adjacent grouping within each state.
The author judges relevance, safe publication and continued applicability; the host checks the typed relationships and byte identity, never natural-language intent.
Meaningful drawn figures need inspected raster exports; arbitrary card HTML, interactive controls, host chrome and private threads are not exported.
Public project-template text and issue references are supplied as `projectText` outside the generated region on the first publication; after it, `around` changes those words (below).
A saved story's squash commit message is its plain `whatChanged` summary, followed by any conventional `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer and continuation lines in the current surrounding project text.
That text begins as `projectText`; the merge preserves a footer the person later adds outside the verified story region too.
Both ordinary and rules-skipping merges use that summary, never the rendered story's markers, escapes, tables, evidence URLs or risk chart; legacy descriptions keep their existing delivery.

`stageChangePresentation` reuses the card media reader and retains exact validated files in the task's card-media folder, outside its working copy and temporary folder.
A recording keeps its inspected local poster and must be a playable silent H.264 MP4 below 10,000,000 bytes; it is never silently replaced by a still or GIF.
The existing image, total-size, duration and resolution limits still apply, and no conversion happens silently.
`TaskService` owns the revisions, attachment states and last complete publication in `TaskDelivery.presentation`.
Only the newest revision and the last published revision remain (or the unresolved opening revision while its outcome is unknown); replacing them removes their otherwise unreferenced copied media, while receipts remain reusable.
Each receipt is scoped to the host, numeric project identity, full project name, visibility, content digest and media type.
The paired computer transfers retained pictures and recordings through the existing picture and chunked-media routes before asking the home to prepare the story.
`CHANGE_PRESENTATIONS_SINCE` gates that tool on work computers; an older computer must be updated before opening a new github.com pull request or gitlab.com merge request, rather than bypassing the publication barrier.
A computer that restarts on a contract that speaks it is given the tool on the conversations the home reopens, without the home restarting.
The home opens the PR using its own sign-in; no sign-in moves to the work computer.
The work computer discards its staging copies after transfer; the home retains the newest and last published story copies.
A refused preparation discards unretained staging copies even before host or legacy-PR validation, or when another story operation is running; it never removes that active operation's files.
Completion cards receive independently named copies of the validated media in the task's `cards/` folder, so later story pruning leaves shown cards and their history intact.
A staging refusal removes every newly minted picture and recording, and a refused completion card removes its new copies unless the card was already persisted.

`open_change` takes the prepared `presentation` revision instead of `body` for a new github.com pull request or gitlab.com merge request.
The native GitHub attachment capability checks destination identity, public/private/internal visibility and write/maintain/admin permission before each upload.
It sends raw bytes once to `https://uploads.github.com/user-attachments/assets`, with the short names `recording.mp4` or `picture.<format>` and the app's own sign-in; it refuses redirects, unsupported credentials and non-native returned URLs.
In unpackaged tests, the existing API-base override also routes attachment uploads to the local GitHub stand-in, which retains and serves the actual bytes; packaged builds keep the native upload origin.
GitHub shows an upload's name above its player, so the name is readable and never contains a source path or content hash.
The digest still owns receipt identity; changing the display name never resends a confirmed attachment, whose original hosted name stays unchanged.
Recordings always use bare attachment-URL paragraphs, not HTML video elements, so GitHub supplies its native player and rewrites private media to signed, temporary links.
An HTML `video src` would stay unsigned in a private project and require a signed-in viewer with access; the renderer does not emit that form.
Internal projects use the same sign-in-gated native media as private projects; the exact visibility remains in receipt identity so audience changes are refused.
Saved receipts keep canonical GitHub attachment URLs, never the temporary links GitHub renders.
Every selected file must have a confirmed receipt before the PR opens, including a draft, or an existing story is replaced.
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

`open_change`'s `around` changes one passage of the words around a published story on its open pull or merge request, such as an outdated summary or a `BREAKING CHANGE:` footer the squash reads, while the story stays as published.
`from` is the passage exactly as the description shows it, found once above or below the story, and `to` replaces it in place; an empty `from` adds words only where nothing surrounds the story.
With the published revision, the host sends that published region, its content hash and its receipts byte for byte and uploads nothing; with a newer revision, the newer story is published in the same write.
A passage that is not there, because someone changed it since the crewmate read it, or that appears more than once sends nothing, and the answer quotes the words as they read now; an edit inside the story keeps the refusal above.
On GitLab, a line of the new words that starts with a quick action escapes its slash like the author's prose, because only the captain's click merges.
The read after the write confirms the story by its region as before; when the words around it differ from those sent, the answer says so rather than claiming them.
Before the first publication there is no description to change, so the words go in `projectText`, and a pull request without a saved story takes `body` instead.
A home before `STORY_AROUND_SINCE` (10.1.0) would drop `around` and answer as if nothing was asked, so a work computer refuses the call to it and sends nothing.
Evidence: `presentation.test.ts` and `changePresentations.test.ts` ("the words around a published story"), `prCi.test.ts` (open_change's answers) and `sessionHost.test.ts` (the older home).

Missing or mismatched evidence holds the completion offer and the final own-task merge boundary independently of checks and merge authority.
The completion call gives `emit_card presentation` and one merge action, without a second body, risk declaration or required-action list.
CardService still owns cards, the risk chart, requirements and merge controls; checks, independent review, autonomy and the captain's merge click retain their existing owners.

### On gitlab.com

A gitlab.com project's forge offers the same story through GitLab's own project uploads (`providers/gitlab/attachments.ts`); a self-hosted server's forge offers none and keeps its delivery.
Its destination is read from `GET /projects/<encoded group/subgroup/name>`: the numeric `id`, `path_with_namespace` (nested groups kept whole), `visibility`, and the key's role where GitLab lists it.
A role GitLab lists below Developer is refused before sending; an inherited role it does not list leaves the decision to GitLab's own answer.
Each upload rereads that project and sends the exact retained bytes once as multipart `file` to `POST /projects/<numeric id>/uploads`, the number the read confirmed, with the names `recording.mp4` or `picture.<format>`, the app's own sign-in and redirects refused.
A private or internal project's upload is refused, with nothing sent, unless that read says `enforce_auth_checks_on_uploads` is exactly `true` ("Require authentication to view media files"); absent, null or false never passes, because GitLab otherwise serves the file to anyone with its link.
The app never changes that setting; the refusal names it for a maintainer to turn on, and a story with no media publishes whatever the setting reads.
A confirmed receipt is GitLab's project-relative `url`, `/uploads/<32 hex>/<name>`, checked against the name sent; its `full_path` must name the same file in the same project, as `/-/project/<id>/uploads/...` or the project's own path, or the answer is uncertain.
Returned `markdown` is never used, and receipts keep only that reference, which GitLab resolves inside the merge request's project.
Pictures are Markdown images and adjacent pictures use the same table as GitHub; a recording is an image link to its MP4, which GitLab renders in its own player with its alt text, never a bare reference.
The merge request's description is replaced with `PUT /merge_requests/<N>` only after a fresh read still shows it open at the story's head with the words the publication read; `GET /repository/branches/<branch>` confirms the pushed version.
Opening and replacing tell a refusal GitLab answered (a 4xx) from a lost connection, a redirect, a 5xx or an unreadable success, which stay uncertain and are read back, never replayed.
An uncertain opening relies on GitLab permitting only one open merge request for a source and target branch.
GitLab offers no lookup of an upload by digest either, so a lost upload receipt is disclosed as a possible orphan exactly as on GitHub.
Raw gateway writes cannot open the task's own merge request (`POST .../merge_requests`) or replace its saved description (`PUT .../merge_requests/<N>` with `description` in the body or the query string, which GitLab also reads), however the path is encoded; its other fields and other merge requests stay writable.
GitLab runs a description line that starts with a quick action (`/merge`, `/close`) when it saves the text, so every line of the author's prose and captions escapes its leading slash (`\/` reads as `/` on both hosts).
A project template's own quick actions in `projectText` are the project's choice and run; GitLab removes their lines, which the region-only read-back allows.
The squash is `<title>`, a blank line and the story's plain summary with any breaking-change footer, never the rendered description ("GitLab merge requests" above).

Evidence: `providers/gitlab/attachments.test.ts` (the multipart upload, media protection, identity, role and returned-reference rules), `providers/gitlab/gitlabForge.test.ts` ("saved-story writes"), `presentation.test.ts` ("the layout GitLab can actually display"), `providers/gitlab/gateway.test.ts` (the raw-write refusals), `tests/gitlabStub.test.ts` ("a saved story through the real GitLab forge and the stand-in": a refused private upload, uploads before the opening read back byte for byte, a lost upload answer, a restart with a person's words and the squash), and `tests/e2e/gitlab-delivery.spec.ts`, whose gitlab.com journey opens the story and squashes its summary while the self-hosted one keeps its body.

Existing PRs are not rewritten into this format.
An open pull or merge request whose description is not a saved story - on GitHub Enterprise Server or self-hosted GitLab, or on github.com and gitlab.com when it predates saved stories - takes `body` again on a later `open_change` (INF-291), and `prepare_change` on one that predates saved stories points there.
The forge rereads it, replaces the whole description only while it is still open at the version and words just read, and `PrCiService` reads it back, so the answer says what the host now shows rather than only that the change exists.
An identical body sends nothing, no body leaves the description unchanged, and the title is never renamed; each answer says which.
A refused or uncertain write, or a read-back with different words, is answered as that, and nothing is sent again on its own.
A plain Git host keeps no description for a pushed branch, and its answer says the body was not published.
GitHub Enterprise Server, self-hosted GitLab, plain Git, local-only delivery, answer cards and release-note hero pictures are unchanged.

Preparation and ordinary publication reject tracked uncommitted changes, not untracked downloads such as `.infinitary-artifacts` archives.
The completion card reads its local committed version and retained files once; merge checks compare the remote PR head with the published head, not a work computer's dirty copy or availability.
An accepted conflict-only repair republishes the unchanged story automatically at the repaired version after checks pass, without another upload or completion card.
The completion offer binds a content hash; only the host's exact conflict-only clone inherits that hash, so a separately edited story requires a new completion offer rather than borrowing the kept approval.
The story's saved title, risk and required actions win on `emit_card presentation`; its title field is supplied, and body, body_file, risk and required_actions are omitted.
