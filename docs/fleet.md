# Fleet management

How repositories are set up, configured and unregistered, and how delivery and autonomy are derived and enforced.

## Asking the first mate to add a project

The first mate may propose a project at any time: on the captain's message, after a crewmate's report, or on its own judgment (the captain's direction A on FI3-1531, built in FI3-1532).
Its `app_change project-setup` never adds one; the line is tier `hands` with `proposes`, so `app_change` hands the value to `ProjectSetups.propose` (`src/core/workspace/projectSetups.ts`) at any wake, and the dispatcher refuses a first mate actor on `inf:repos:setup`.
The value is the setup spec (`clone` with `origin`, `init` with `name`, `adopt` with `path`, each with an optional `key`, below) plus what the first mate suggests: `delivery`, `autonomy`, `rigor`, `runsOn` (`automatic`, a computer that runs work, or null), and `work`, the waiting work it starts once the project is added (`projectSetupProposalSchema`, `src/shared/projectSetup.ts`).
`RepoRegistry.check` reads what the setup would do without writing anything: the name it would get, where the project lives, whether a plain folder would get git, and the task key it was asked to take.
A project already on the list - the same folder, or another project with the same origin - gets no card, and the first mate is told its name and id; a request setup would refuse is refused in the same words now.
Otherwise the host puts up one card it writes itself (design skill `components/projects/SetupCard`), under an id made from the project, so asking again for the same project revises that card.
It names the project, where it comes from and how it lands on this computer, and the task key when the first mate named one, then the rows of its Settings entry: Runs on (when it has a remote), Where changes go, Ask before merging and Care, with the first mate's suggestions selected and today's defaults otherwise.
Runs on defaults to Automatic for a project with a remote; an explicit This computer selection stays explicit.
A folder with a remote is linked where it is by default, and the card offers a fresh clone into the projects folder instead.
Add project and Not now carry host ops (`add-project`, `decline-project`) whose argument is the card's own offer; an effect is never declared to the body's frame, so only the captain's click on the card's own button adds a project.
Add project runs, as the captain, the same dispatcher Settings uses: the setup, then the settings the captain chose that differ from the new row, then Runs on; each writes its own feed line and operation, and all are saved before the first mate hears.
The first mate then hears once, as an `[fm-op]` `project-setup` wake: added with its settings and the work the card named, which it starts; already on the list; not now, from the explicit Not now button; or failed with the reason, carrying a clone's typed sign-in refusal (`docs/forge.md`).
Putting the setup card aside leaves its offer and operation row pending and sends no setup outcome.
That wake skips the inbox's coalescing window, so the first mate answers the click at once (`docs/inbox.md`).
Settings' own Add project adds at once and shows no card.

## Choosing a task key

A project's key prefixes every task key it mints, such as `INF` in `INF-12`, and it is chosen once, when the project is added (FI3-1787, step 4 of the Infinitary rename).
Settings' Add project row has an optional Task key field that the next folder, repository or new project added there takes; `project-setup`'s `key` does the same through the setup card, whose Add project and fresh-clone choice both keep it.
With no key, the app derives one from the name (`deriveProjectKey`, `src/core/tasks/projectKey.ts`), as it always has.
A chosen key is normalized to capitals and refused in words when it is not 2-4 letters or digits, or when any project has it, Scratch and a removed project included, because a closed task's key still names one project (`freeProjectKey`, `src/core/storage/projectStore.ts`).
The refusal comes before anything is cloned, created or linked, and for a clone it is never turned into a sign-in refusal.
A project already on the list is answered as it is, with the key it has.

## Changing a project

Settings and the first mate use the same action catalog and dispatcher for every project change.
`project-settings` changes scope, delivery, autonomy, rigor, display name, folder and approved hosting address; `project-runs-on` changes where its next task runs.
The global `projects-folder` setting still changes where new projects go on typed captain words.
The first mate applies an exact change the captain named in the captain's words, quoting them as evidence, wherever they reach it: the captain's message, one the captain sends while a turn runs, the captain's reply a crewmate relays, or a schedule the captain set (INF-751).
The first mate declares that judgment with `on_words: true`; an omitted declaration proposes instead.
The exact-words judgment belongs to its tool guidance, not a host parser.
Every other proposal, including an ordinary agent-card choice, reaches `ProjectChanges` (`src/core/workspace/projectChanges.ts`) and gets an app-written card showing the old and proposed values.
Only that card's Apply change button applies the stored patch once; Not now declines the proposal without a change.
The minus keeps the proposal pending without applying or declining it.
The host refuses a card if the saved project changed since the offer, and revalidates the folder, address and devices on applying.
The first mate hears the outcome once through `project-change` and reads current values before starting work that needs it.
Removal still needs the captain's typed words, and adding still uses the setup card above.
The personal workspace remains locked and takes no scope.

Scope is optional free text describing what work belongs in the project.
Settings saves it with Save details, and talking uses the same exact-words or Before/After proposal path; null clears it.
The first mate sees every project scope on attachment, after successful compaction, and after any project or scope change, never on an unchanged next turn.
Only the first mate judges scope fit; an explicit project wins and follow-ups stay with their work.

Name changes keep the project's id, key, sequence and task history, and update its fleet index without moving its files.
Folder changes point at an already moved, existing git folder, are refused while tasks are planned or working, and never move files.
The app refuses a folder belonging to another managed project, or a new folder while the old one still exists.
Where it lives is the approved address, not whatever git currently says.
The app notices a changed origin at startup and before starting a task, and proposes the exact address on the same card; no detection writes the registry or moves its API write fence.
The address must still match git when the captain approves it, and a read failure never clears an address.
Detection and registration read the configured origin address before git's transport rewrites, so a local mirror does not become the approved hosting address.
Removing the origin also chooses Local merge and returns Runs on to this computer.
A project with no approved address cannot choose Pull requests in Settings or through the first mate.
The expanded Settings row offers Name, Scope, Folder and Where it lives with Save details, using the same dispatcher; its hosting field accepts the address the folder already points at rather than editing git configuration.
How a project joined, its key and its workspace kind are provenance, not editable settings.

## Notes

Moved verbatim from `AGENTS.md` on 2026-09-24; `AGENTS.md` keeps a one-line pointer to each.

- Adding and configuring projects are shared by Settings and the first mate through `app_change project-setup` and `app_change project-settings` (`src/shared/actions.ts`); the first mate's `project-setup` puts up the setup card above, and only the captain's click there adds; removal is the own-words `project-remove` line (`inf:repos:remove`, guarded by `inf:repos:removal`), and `unregister_repo` is retired.
  The app-owned fleet root is `userData/fleet` (`paths.fleetDir`), the index of every managed repo: clone/init create real directories in the projects folder, which is the fleet root unless the person chose another folder in Settings → Projects (the projects folder's line under Add project, `RepoRegistry.setProjectsFolder` over the `projects-folder` settings row, picked with the shell's `inf:app:choose-folder`); a project created or cloned in a chosen folder gets a fleet-root symlink exactly like an adopted one; adopt links an existing folder in place via a fleet-root symlink (captain's call - adopted data never moves), so `RepoView.path` is always the real working directory.
  Changing the projects folder never moves a project already set up.
  A chosen folder is refused, with the reason beside the row, when it is not there, sits inside the app's own data or inside a managed project, or cannot be written to; one that has gone missing since (a drive not plugged in) refuses the next clone/init rather than being created anew.
  The person changes it in Settings or asks the first mate to change it on their own words through the action catalog's `projects-folder` line.
  Each repo carries a workspace KIND (`repoKindSchema`: `project` | `personal`, migration 37 - the personal workspace is a kind, never a posture), a delivery posture (`direct-pr` | `local-only`, defaulted by remote presence - new postures extend `repoDeliverySchema` in `src/shared/repos.ts`, the seam a future validation pipeline plugs into) and an autonomy flag (on = the agent may land green work itself).
  Autonomy has delivery's and rigor's shape since contract v3.9 (captain ruling F7 A, 2026-09-20): the repository column is the default, `spawn_crewmate autonomy_ask` carries the captain's own words for one task, and `autonomyFor`/`autonomyForRecord` in `src/shared/repos.ts` is the one derivation - the ask (read by PRESENCE, so `false` is an ask), then the repo; a repo-less task, a personal-workspace task and an answer task are not held at all - no standing answer to enforce, and no merge to hold (v3.8's deliverable refusal speaks first on the last).
  The HOST enforces it, not just the prompt: `settleTaskOnce` refuses a first-mate-actor `merge-pr`/`land` on an autonomy-off task with the structured `autonomy-off` `SettleRefusal`, whose one way out is the open merge card's own merge action (a `SettleWay` carrying a `card`, not a `tool`); a captain click (`actor: "captain"`) is never refused.
  The mint stamps `WorkShape.autonomy` as provenance the quiet way rigor is stamped, while every decision derives the effective value live; `SettleFacts.strip`, `crew_status` and the context crew lines carry it per task.
  Removal refuses while tasks are on the repo (naming them by key) and never deletes repo data.
  Setup and removal are shared with Settings; Settings → Projects can set delivery, autonomy, and standing rigor on the same row `app_change project-settings` writes (`inf:repos:configure`) and still follows `repo_setup`/`repo_configured`/`repo_unregistered`.
  The autonomy row reads "Ask before merging" (`AUTONOMY_SWITCH_NAME`); its right-anchored switch is on and says "Asks first" when autonomy is false, and off and says "Merges on its own" when autonomy is true (`AUTONOMY_WORDS` in `src/shared/vocabulary.ts`).
  Its click writes the inverse flag; the locked personal workspace reads "Merges on its own" without a switch.
  A closed row says "merges on its own" when the stored flag is on and nothing when it asks first, the default (`projectRowWords` in `src/renderer/src/settings/projectsWords.ts`), and the feed uses the same words in lowercase mid-sentence.
  Settings may add and remove projects through `app_change`'s dispatcher.
