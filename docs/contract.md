# The published contract

What a client of the home is written against: `docs/contract.json`, every core request and push of `src/shared/ipc.ts` and the connection's envelope around them (`src/shared/connection.ts`) as JSON Schema, with the contract's version and the version rule.
A paired view, the helper and a native app read the same file.
How the connection carries it is `docs/connection.md`; how a device pairs is `docs/devices.md`.

## The file

`docs/contract.json` is generated, never edited by hand: `pnpm generate:contract` writes it from `src/shared/publishedContract.ts`, which reads `src/shared/ipc.ts`, `src/shared/work.ts` and `src/shared/connection.ts`.
`src/shared/publishedContract.test.ts` renders it again and fails when the committed file differs, so a change to a core shape, a channel, the envelope or the version comes with the regenerated file in the same pull request, and its diff shows a reviewer what clients see.

| Part | What it holds |
| --- | --- |
| `protocolVersion` | `PROTOCOL_VERSION`, the version of everything below |
| `versionRule` | The rule below, in words, with `majorsBehind` as a number a client can use |
| `capabilities` | `HOME_CAPABILITIES`, the names a home serves beyond its channels |
| `connection` | The port and path, the largest frame, the close codes, the client's and the home's frames, pairing's path, body limit, request, grant, refusal and statuses, and where a command, or a computer being updated, gets Infinitary (`fetchApp`: its path, request, refusal and statuses) |
| `requests` | Every core channel by name: its `effect` (`read` or `change`), its `reach` (`views`, `home` or `work`), and the JSON Schema of its `request` (the argument list) and its `response` |
| `pushes` | Every core push by name, with the JSON Schema of its `payload` |
| `orders` | What a home asks a computer that runs work (`src/shared/work.ts`), from the version `since` names, and the seed order and a prepare that names a seed from `seedSince`: each order's `effect`, and the JSON Schema of its `request`, which the home sends and so is published open, and of the computer's answer |
| `signInOrders` | What a home asks a computer that runs work about its own sign-ins (`src/shared/signIns.ts`, `docs/helper.md` "Its own sign-ins"), from the version `since` names, published the same way; its sign-in where projects live (`inf:sign-ins:forge`, `inf:sign-ins:forge-out`) and Claude's pasted code from the version `forgesSince` names |
| `browserOrders` | What a home asks a computer that runs work about its tasks' own browsers there (`src/shared/work.ts`, `docs/task-browser.md` "On another computer"), from the version `since` names, published the same way |
| `resourceOrders` | Read-only CPU and memory observations from the version `since` names, independent of conversations and sign-ins (`src/shared/resources.ts`) |
| `updateOrders` | The one order a home asks a computer that runs work whatever its version (`src/shared/work.ts`, `docs/devices.md` "Updating over the connection"), from the version `since` names, published the same way; its name and shape never change across majors |

Channels the desktop shell answers itself (`surface: "host"`) are not published: no other client can ask them.

The dialect is JSON Schema 2020-12, named once at `jsonSchemaDialect`.
Each shape is a schema on its own: compile the shape, not the file, and a `$ref` inside one resolves within it.
`format` is an annotation, as the dialect says.
A standard validator reads every shape: the test compiles each with Ajv in strict mode.

How the shapes are written:

- **What a client sends** - a request's arguments, the client frame, the pair request - is published as the home admits it.
  An argument list says how many arguments it takes, at least and at most, and an object the home reads strictly says so.
- **What the home sends** - a response, a push, the home frame, the pair grant and refusal - is published open: a field the file does not list is allowed, because a later minor may add one and a client ignores what it does not know.
- **Every core shape must be expressible.**
  A custom check (`z.custom`, `z.instanceof`) or a transform on a core channel stops generation with the shape named.
  Say the shape with ordinary schema parts and keep the narrower type with a cast, as `sqlViewNameSchema` does.
  A host channel may use anything.
- **The home checks more than a schema can say**, such as sizes in bytes and rules across fields.
  Its refusal comes back as the result's error.

## The version rule

`PROTOCOL_VERSION` is `major.minor.patch` (`src/shared/ipc.ts`), and only a major change moves it.
Every change to the contract adds one Markdown file to `src/shared/contract-changes/`, named for the change and never for a number; that folder's README says how to write one.

- **Minor**: additive - a new request, a new push, a new optional field, a new capability, a new order.
  Nothing a client already sends or reads changes meaning.
  A minor change adds its file and moves no number, so two changes open at once each add a file of their own and merge cleanly.
- **Major**: anything a client written against an older version could not survive - a request, push or field removed or renamed, a field made required, a new member of a closed set, a meaning changed.
  A major change replaces the folder's one major file, `major-<N>.md`, with `major-<N+1>.md`, removes every minor file, and sets `PROTOCOL_VERSION` to `<N+1>.0.0`.

The minor stays where it is until the next major: major 10 keeps 10.1, the last minor typed before changes had names, and every later major stays at its first minor, 0.
`src/core/connection/contractChanges.test.ts` holds `PROTOCOL_VERSION` to the version the folder allows, so two majors open at once both add the same file and conflict on purpose, and the one that merges second takes the next number.
The published file and the phone's generated file carry the version, so they change it only with a major too.

A home answers every request only on its own major (`PROTOCOL_MAJORS_BEHIND`, 0).
A client on any other major, older or newer, is answered its reads (`effect: "read"`) and sent every push, and each change (`effect: "change"`) is refused, as the result's error, until the client is updated.
A client on an answered major keeps everything it knows whatever its minor, because a minor only adds.

The home applies the rule at the connection (`contractAccess`, `src/core/connection/connection.ts`): the client's `hello` names the version it speaks, and the `welcome` answers the home's own version and `access`, `full` or `read`, so a client hides what it may not do instead of computing the rule itself.
A client also hides what its home lacks by the `capabilities` it lists, not by reasoning about versions.

Both sides read the envelope leniently: a frame field this version does not know is ignored, so adding one is a minor change, never a closed connection.
A request's arguments are read as published.

A major may retire earlier shapes under their existing channel names; paired views must update before changing anything.
A computer that runs work on another major takes no work until it is updated (`takesWork`, `docs/helper.md`), while the update and download orders it is asked stay the same on every major.
`src/shared/ipc.test.ts` exercises the rule with explicit versions and derives the current boundary from the version owner.

## Changes by name

A home and a computer that runs work on the same major may still be built from different changes, so a feature that needs the other side to have a change waits for that change's name, never for a number.
Each side lists its changes in its hello and its welcome (`changes`, `docs/connection.md`, "The handshake and the numbering"): one name per minor file in `src/shared/contract-changes/`, the file's name without `.md`.
A packaged app's build lists the folder once and bakes the list in (`electron.vite.config.ts`); tests read the folder (`src/core/connection/contractChanges.ts`).
The home keeps what a computer listed beside that computer's version (`WorkDeviceVersion.changes`), and a computer keeps what its home listed (`HomeLinkState.homeChanges`).
A feature names its change once with `contractChange`, which refuses a name no file has when its module loads, and asks `listsChange` of the other side's list.
A side that listed nothing, such as one built before changes had names, has no change, so it gets no feature that waits for one.
The published file does not list the names, since no client written against it needs them.

## Features that wait for a number

A feature written before changes had names waits for the first version that had it, as a typed `*_SINCE` number beside its check, and a version that does not read as `major.minor.patch` has none of them.
A feature asked across majors keeps a typed number for good, because a major removes every name.

These cross majors:

| Number | What waits for it |
| --- | --- |
| `WORK_UPDATE_SINCE` (1.76) | The home asks a computer the update order, `fm:firstmate:update`, on any major (`takesUpdate`); Settings -> Devices updates an older one by a new command run there (`docs/devices.md`, "Updating over the connection"). |
| `WORK_DOWNLOAD_SINCE` (8.15) | The home has a Mac elsewhere download the home's published version itself, with the download orders, on any major (`takesDownload`); an older one is updated with the update order alone (`docs/devices.md`, "Downloading over the connection"). |
| `FETCH_APP_SYSTEM_SINCE` (5.1) | A computer names its `system` and `chip` where it gets Infinitary (`fetchApp`'s request) only to a home on this version or later, which answers the copy published for them (`readsFetchAppSystem`; `docs/devices.md`, "Infinitary for another system"); an older home reads the request strictly and refuses them. |

These wait within a major, and every one but the last is older than major 10, so every computer that takes work from a home on 10 has it:

| Number | What waits for it |
| --- | --- |
| `PLACED_WORK_SINCE` (1.64) | A computer takes work at all (`takesWork`), and the published `orders` start here. |
| `CUSTOM_API_SIGN_INS_SINCE` (2.6) | The home asks a computer the custom API sign-in orders (`speaksCustomApi`), and refuses with "Update Infinitary on" that computer "first." otherwise. |
| `PLACED_SEED_SINCE` (3.1) | A computer takes a task with no project (`speaksSeed`). |
| `KNOWLEDGE_THERE_SINCE` (5.5) | The home names the knowledge pair among a task's tools and writes its knowledge lines into the brief (`speaksKnowledge`; `docs/knowledge.md`, "The tools"). |
| `RESOURCE_OBSERVATIONS_SINCE` (6.3) | The home asks a computer its CPU and memory (`speaksResources`); an older one's reading is unknown, `unsupported`. |
| `TEMP_CLEANUP_SINCE` (7.1) | The home asks a computer to remove a closed task's temporary folder (`speaksTempCleanup`), and otherwise says that computer needs an update first (`docs/task-retention.md`, "A task's temporary folder"). |
| `PLACEMENT_FACTS_SINCE` (8.0) | The home asks a computer its placement facts (`inf:computer:placement`, `src/core/placed/automaticPlacement.ts`). |
| `INFINITARY_NAMES_SINCE` (8.4) | The home names the Infinitary rename's git refs and artifacts folder to a computer (`speaksInfinitaryNames`), and Firstmate 3000's to an older one (`docs/helper.md`, "Starting from a source task"). |
| `CARD_TYPEFACES_SINCE` (8.9) | A computer sends a card that names a project font only to a home that keeps one (`keepsCardTypefaces`), and refuses it in words otherwise (`docs/card-authoring.md`, "Fonts by reference"). |
| `CHANGE_PRESENTATIONS_SINCE` (8.13) | The home and a computer use saved change stories (`speaksChangePresentations`; `docs/forge.md`, "Saved change stories"). |
| `SESSION_RECORD_REFRESH_SINCE` (8.15) | The home asks `inf:session:copy` with `refresh` (`speaksRecordRefresh`; `docs/helper.md`, "The record's copy"). |
| `CLIENT_JOB_ENDS_SINCE` (9.2) | A computer says a background job ended with its Claude client (`interrupted: "client"` on `inf:work:job-exit`) only to a home that hears it (`hearsClientJobEnds`), and says the end without why otherwise. |
| `STORY_AROUND_SINCE` (10.1) | A computer sends `open_change`'s `around` only to a home that changes the words around a published story (`changesStoryAround`), and refuses it and sends nothing otherwise (`docs/forge.md`, "Saved change stories"). |

## What the contract carries

What a side of the contract may rely on beyond its shapes in `docs/contract.json`, by what it serves.
Where a feature waits for the other side, its number is in the tables above.

### Cards and saved stories

Cards, captured offers and placed card requests carry an optional `holdsPlace`, which declares forward arrival and leaves unmarked cards unchanged.
A card action's effect may be `request_write`: a crewmate's ask to send a write it kept where its project lives, which only the captain's click sends (`docs/forge.md`, "A write that asks").
The setup card's Add project and Not now carry the host ops `add-project` and `decline-project` (`docs/fleet.md`, "Asking the first mate to add a project"), and the project-change card's Apply change and Not now carry `apply-project-change` and `decline-project-change`.

Host operations include confirming and deferring a required action, and task operations include `show-card` (`docs/required-actions.md`).
Cards, captured offers and placed requests may carry required-action declarations, and task rows may carry durable action state.
The host owns confirmation effects and observers, and old cards remain unchanged historical records.

A card's live attachment has a second kind, `page`, a page from its task's project (`docs/task-browser.md`, "A page from the project").
It is opened with the home-only `inf:cards:open-page` request, declared by a placed card's optional `browserPage`, and marked on the open browser fact by the optional `own`.

A card may carry `reviewTaskId`, and the home refuses the card unless that names an independent review of the card's task, before Review finding is drawn.
First mate cards about a task carry the task's title in their meta line.

Cards and record card rows may carry `minimized`, and task rows the desktop presentation-only `minimizedCardId`.
A view's `inf:cards:minimize` changes saved stack visibility without resolving a card, and its `inf:cards:show` restores an open card or shows a closed card read-only.
`inf:cards:show-past` answers a closed card.

The optional fourth boolean argument of `inf:cards:reply`, an older view's send-time decision that an ordinary card leaves the stack, is read no more (INF-770).
Every replied-under card stays, and the home keeps the hold in the existing awaiting and reply-stamp fields; waiting stamped cards keep their place until answered.

A preview's project fonts (`docs/card-authoring.md`, "Fonts by reference") travel by the `inf:cards:typeface` view read, which answers the home's own copy of a font by its minted name, and by the `inf:work:typeface` work request, which carries a kept font home before the card that names it.

A saved story's `version` is 1 or 2: version 2 carries up to six typed `checked` facts beside folded `verification`, and a version-1 story stays readable and keeps its rendering (`docs/forge.md`, "Saved change stories").
`inf:work:prepare-change` stages a saved change story, and change publication and completion cards may carry its revision.
`open_change`'s input (`inf:work:open-change`) takes an optional `around`: one exact passage of the words around a published story and what replaces it.
A home before `STORY_AROUND_SINCE` would strip `around` and answer as if nothing was asked, so a computer that runs work refuses such a call to it and sends nothing.

### Tasks, projects and routing

Task delivery facts carry an optional `reviewCapOwner`: `firstmate` delegates a qualifying review cap, while `captain` or absence keeps the captain hold (`docs/delivery-rigor.md`).
The home alone sets it and enforces the gate it chooses.

A plan item's `label` and `short` in `inf:tasks:detail` carry no length limit: a plan keeps its crewmate's words, and each surface cuts what it cannot show (`docs/task-record.md`).

`teach` and `retrieval` are work and usage kinds; `teach` is also a model reason's `kind`, and `R10` one of its rules.

Crew speed has a per-model write (`inf:models:speed:set`), the placed speed read (`inf:work:speed`), and optional speed fields on model rows (`speed`, `speeds`), task shapes (`override_speed`) and the placed spec (`speed`).
Speed capability stays on the executing computer; only the requested setting is read from the home.

A project's setup (`inf:repos:setup`) takes an optional `key`, the task key its tasks are numbered with, which the home refuses in words when another project has it (`docs/fleet.md`, "Choosing a task key").
Only the home's own window asks it.
Project configuration takes an optional `name`, `path` and `origin` beside its policy fields (`placementRequirements`, `delivery`, `autonomy`, `rigor`).

The first-run record (`inf:app:first-run`) carries the optional `thirdCrewmateDoneAt`, the moment the create-your-own-panel slot waits for (`docs/first-launch.md`).
The home still writes `firstTaskDoneAt`, which nothing in this version reads, for a view on an older version.

### Knowledge

The home-only `inf:knowledge:directions` read lists standing directions, the first page across every scope when it is given no arguments, `inf:knowledge:direction` reads one, and each knowledge collection carries an optional `directions` count.
The home-only `inf:knowledge:direction:set` change adds, revises or retires one, as the app action catalog's `direction` line (`docs/orchestrator-contract.md`, "App action catalog").
`knowledge.directions` is a member of the closed read-name enum panel manifests carry (`PANEL_READ_NAMES`).
A crewmate on a computer that runs work reads and writes the home's knowledge through the `inf:work:knowledge` and `inf:work:record-knowledge` work requests (`docs/knowledge.md`, "The tools").
The placed write request carries the `direction` kind and an optional `lane`, which separates captain-stated personal context from saved references without granting different access; the home defaults a crewmate's omitted lane to reference.
Carrying a direction write does not let a crewmate make one: the work request refuses it, and only the first mate, on its own judgment of what the captain wants, changes a direction (`docs/knowledge.md`, "Directions are the first mate's to keep").
Every crewmate has equal factual access, including a task with no project, and saved task shapes read the legacy `knowledge_access` as inert metadata.
Knowledge runs in every build, and a profile carried to Knowledge refuses an older notes-writing build (`docs/saved-data-compatibility.md`).

### Devices and the connection

The hello and the welcome carry the optional `spellings`, the channel-name spellings each side reads (`docs/connection.md`, "Two spellings").
A side that lists none reads only `fm` and is written Firstmate 3000's names, and the update, download and progress orders keep one name in every spelling (`FROZEN_CHANNELS`).
The published file names channels in `inf:`, except those frozen orders, and a client written against it says it reads `inf`, as `scripts/contract-client.ts` does.

The pair request (`POST /pair`, `docs/devices.md`, "Joining") takes an optional `system`, and a phone that says `ios` joins as a view whichever link it used.
A phone always sends it, since a first join can read no version: the welcome comes after pairing and `/pair` exposes none.
A phone reads a `malformed` answer to its pair request as a Mac that needs updating, and says so.

A pairing link may carry optional `also` addresses, and a device its optional `reachedOn`.
Where devices find this computer (`inf:devices:addresses`) may carry its optional network `name` and an optional `firewall`, a Linux home's firewall that may keep its devices out (`docs/devices.md`, "A Linux home's firewall").

`inf:devices:update` takes an optional password and may answer the same password question Add returns.
It and `inf:devices:change-address` answer a Remote Login refusal as typed data, `{ refused, lines }`.
A device on the list may carry `connectedAt`, when the connection the row calls connected began, and Settings -> Devices clears a "could not reach" line once that time is newer than the line.
`inf:devices:shown` answers only `shown`, and only this Mac's own window asks it.
A Remote Login copy in its `preparing` state may carry a `download` observation: bytes received and, only when the release states it, a total.

Task places, computer sign-ins and placement explanations carry the core's one reach value (`computerReachSchema`), which reads `connecting` for a computer out of reach only because its connection is being made.
A placement candidate not in reach keeps the `out-of-reach` rejection.

A computer may name its `system` and `chip` where it gets Infinitary (`fetchApp`'s request), and the home answers the copy published for them (`docs/devices.md`, "Infinitary for another system").
A home asks a Mac that runs work two download orders (`downloadOrders`, `docs/devices.md`, "Downloading over the connection").
`fm:firstmate:update-download` downloads the home's published version there and keeps it, answers a fallback, or answers `updating` while an update already runs there.
`fm:firstmate:update-progress` answers how far that download has got and what is under way, by which the home follows it, including after its connection dropped.
Like the update order, their names and shapes never change across majors.
A `device_update` event may carry `copy` and `run`, a computer's `otherVersion` may carry `downloads`, and what a command sends `/firstmate` may carry `check`, which only that home's own command sends.

### Computers that run work

A task's browser on a computer that runs work (`docs/task-browser.md`, "On another computer") uses the `browserOrders`, the `inf:work:browser`, `inf:work:browser-frame` and `inf:work:browser-event` requests, the roster's `browsers`, the placed spec's `browser`, and a placed card's `browserButton` and `browserHandoff`.
The home gives a task there a browser only when that computer's roster says `browsers`.

A crewmate there runs the integrations command (`docs/integrations.md`, "On a computer that runs work") over the `inf:work:integrations` read, its list and show, and the `inf:work:use-integration` change, its call, and the placed spec's `integrations`.
The home sends `integrations` only to a computer whose roster says `browsers`, since the command rides the same task channel, and that lists the `integrations-there` change.

A placed card carries the optional `riskDeclaration`, `asking`, `designOnly` and `request_write` effects, and a placed `check_change` the optional `pull`, `absentChecks` and `skipRules` declarations of a merge review.
`PlacedToolFieldCoverage` (`src/core/session/tools.ts`) fails the build when a crewmate-declared top-level field of a card, `check_change`, knowledge read or knowledge record has no place in its work request; host-resolved card fields (`attachment`, `risk`) and the first mate's `taskId` and `reviewTaskId` are left out.
A placed crewmate's `inf:work:read-workflow` may leave out `jobId` for the run's short read, which saves the home's run watch (`docs/forge.md`, "The run watch").

The read-only `inf:working-copy:revision` order reads a task's committed revision.
`inf:working-copy:prepare` takes an optional exact `base`, whose `headSha` its answer must acknowledge, so a computer that ignores the base never starts a review at another commit.
It may answer the closed variants `preparation-failed` and `preparation-unknown`.

The `inf:session:source-file` and `inf:working-copy:source-ref` orders carry verified source cards, media and starting work to the destination computer (`docs/helper.md`, "Starting from a source task"), and the home names destination paths and refs only after that computer acknowledges them.
`inf:working-copy:source-ref` fetches into `refs/infinitary/sources/` from a kept ref under `refs/infinitary/kept/`, and accepts Firstmate 3000's `refs/fm3000/` names too, which the home names to a computer older than `INFINITARY_NAMES_SINCE`.
A computer that runs work gives its crewmates the browser command as `infinitary-browser-axi`, and placed instructions keep the home's words unchanged.
It recovers saved conversations once, before any opens (`docs/helper.md`, "After the one-time move").

`inf:session:clean-files` removes only a closed placed task's leftover files, after the home checks its retention age and live dependencies, and answers the removed names (`removedFiles`) and byte count (`bytes`).
`inf:session:clean-temp` removes only a closed task's provisioned temporary folder (`docs/task-retention.md`, "A task's temporary folder"); a pending answer is not final and is asked again.

`inf:session:copy` may carry `refresh`, which has the computer refresh its app-owned session record from the live client's transcript before answering the first piece of a copy (`docs/helper.md`, "The record's copy").
A placed `continuation_ended` may carry `interrupted` when shutdown or recovery ended the computer's work, and the home then uses its own interruption wording with that computer's name; an ordinary client failure keeps its own `error` and `cutOff`.
A background job's end (`inf:work:job-exit`) may carry `interrupted` (`docs/helper.md`, "Holding a conversation").
It is `quit` or `crash` at a computer's next start, for a job its last run's end cut off, so the home tells the crewmate the job never exited.
It is `client` at once for each background task a Claude client still ran when the client ended while the computer ran on: the home let go of it, a moved contract reopened the conversation, or the client stopped by itself.
A home before `CLIENT_JOB_ENDS_SINCE` hears a client end without `interrupted`, and words it as an exit by signal.

The read-only `inf:computer:placement` order carries actual served models and project, tool and physical-computer facts, and projects and tasks may declare placement requirements and keep placement explanations.
Each account a computer's sign-ins serve may carry `accountList`, the ids a Codex or Grok account's own model list named there, beside Pi's catalog for it, which the home narrows behind its own rail (`docs/helper.md`, "Its own sign-ins").

### Resources

The read-only `inf:computer:resources` order in `resourceOrders` answers bounded, numbered CPU and memory observations or an explicit unknown (`docs/helper.md`, "Resource observations").
A Mac's memory reading may carry inactive memory, speculative memory and macOS pressure, and a reading without them counts free, purgeable and file-backed bytes as free (`docs/routing.md`).
A fresh reading may carry `memoryUsedBytes`, installed memory the home counts as used, by the one figure in `docs/routing.md`.
The `computers.resources` panel read, the `inf:computers:resources` request and its push share these live observations (`docs/helper.md`, "Shared live readings").
The request is read-only and open to paired views but not work connections, and a panel must declare the read to subscribe.
The published reading keeps every raw count, and a panel is handed installed memory, the memory-used figure and Mac pressure, never the raw counts.

## The scripted client

`scripts/contract-client.ts` is a client written against the file alone.
It runs under plain Node, imports only Node, `ws` and Ajv, and reads every channel name, shape, path, limit and version from `docs/contract.json` at start; plain Node could not load the app's own modules if it tried.

```
node scripts/contract-client.ts --grant grant.json [--contract docs/contract.json]
  [--speak 1.56.0] [--cursor <epoch>:<seq>]
```

- `--grant` is a device's saved grant (`docs/devices.md`, "Joining").
  Pairing makes it; the client only dials with it, pinned to the home's key.
- `--speak` is the version its hello names, the file's own by default, so it can stand in an older or newer client.
- It reads one request per line on stdin, `{ "id", "channel", "args" }`, and writes one line per event on stdout: `welcome`, each `result` and `push`, `refused` for a request it would not send (no such channel in the file, or arguments that do not fit), `invalid` for anything from the home that does not fit the file, and `closed`.
  It exits 1 if anything was invalid.
- It hides nothing the version rule would, so it shows what the home answers.

## Tests

- `src/shared/publishedContract.test.ts`: the committed file is what the contract renders; every core request and push is published with the version and the rule, and no host channel; every shape compiles in a standard validator; argument lists are admitted exactly as the home admits them; what the home sends is open to a later field.
- `src/shared/ipc.test.ts`, "the version rule": the window, read by majors alone, and a version that cannot be read gets reads only.
- `src/core/connection/contractChanges.test.ts`: `PROTOCOL_VERSION` is the version the folder allows, a minor file moves no version, the next major's file makes it `<N+1>.0.0`, a folder with no major file or two is refused, a wait for a name no file has is refused, and a side that listed nothing has no change.
- `src/core/devices/homeLink.test.ts`, "a home and a computer that list their contract changes": each side lists this build's changes, keeps the other's, and keeps none from a side that listed nothing.
- `src/core/connection/connection.test.ts`: a home two majors on answers its own major in full, and an older or a newer client only its reads, with every push; a frame's unknown fields are ignored.
- `src/core/core.test.ts`, "a client that knows only the published contract": the scripted client, as its own process against the real core, answers a stall card and reads the feed; a client one major behind reads the feed but cannot answer a card; an older and a newer one read the cards and the feed and have their answer refused, and the card stays.
