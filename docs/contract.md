# The published contract

What a client of the home is written against: `docs/contract.json`, every core request and push of `src/shared/ipc.ts` and the connection's envelope around them (`src/shared/connection.ts`) as JSON Schema, with the contract's version and the version rule.
A paired view, the helper and a native app read the same file.
How the connection carries it is `docs/connection.md`; how a device pairs is `docs/devices.md`.

Protocol 5.0 adds the project-change card’s apply and decline host ops, and optional name, path and origin fields to project configuration.
The closed host-op enum requires a major change; project configuration retains its policy fields.
Protocol 5.0 also adds `request_write` to a card action's effect: a crewmate's ask to send a write it kept where its project lives, which only the captain's click sends (`docs/forge.md`, "A write that asks").
It is a new member of a closed union, so the version rule requires a major change; a work computer's placed card carries it, and its placed `check_change` carries the optional `skipRules` of a merge past the branch rules.
A computer one major behind is still answered in full; it never sends the new effect.
Protocol 5.0 also adds a card's page from its task's project (`docs/task-browser.md`, "A page from the project"): a second kind, `page`, in a card's live attachment, again a new member of a closed set, with the home-only `inf:cards:open-page` request, a placed card's optional `browserPage` and an open browser fact's optional `own`.

Protocol 5.1 adds the optional `system` and `chip` to what a computer sends where it gets Infinitary (`fetchApp`'s request): a home on 5.1 or later answers the copy of Infinitary published for them (`docs/devices.md`, "Infinitary for another system").
A computer names them only to a home whose welcome says 5.1 or later, since an older home reads the request strictly and refuses them.

Protocol 4.0 adds the setup card's host ops, `add-project` and `decline-project`, to a card action's effect (`docs/fleet.md` "Asking the first mate to add a project"), new members of a closed enum like those below.
Protocol 3.0 adds `teach` to emitted work and usage kinds and to the model reason's kind, again new members of closed enums.
Protocol 2.0 adds `retrieval` to emitted work/usage kinds and `R10` to model reasons.
Those are new members of closed enums, not optional fields, so the version rule requires a major change; an older contract cannot validate a task carrying them.
The generated file retains the same version window.
Protocol 2.16 adds optional `holdsPlace` to cards, captured offers and placed card requests; it declares reply continuity and forward arrival, without changing unmarked cards.

Protocol 4.2 adds the optional `firewall` to where devices find a home (`inf:devices:addresses`): a Linux home's firewall that may keep its devices out (`docs/devices.md`, "A Linux home's firewall").
A client on an older minor ignores it.

Protocol 4.1 adds a task's browser on a computer that runs work (`docs/task-browser.md`, "On another computer"): the `browserOrders`, the `inf:work:browser`, `inf:work:browser-frame` and `inf:work:browser-event` requests, and optional fields - the roster's `browsers`, the placed spec's `browser`, and a placed card's `browserButton` and `browserHandoff`.
A computer on an older minor answers no browser order and its roster says nothing of browsers, so the home gives its tasks none.

Protocol 4.2 adds the `inf:session:clean-files` order, which removes only a closed placed task's leftover files after the home checks its retention age and live dependencies.
Its answer carries the removed names and byte count; a computer on an older minor refuses the new order, so the home retries after it is updated.

Protocol 4.2 carries a placed card's optional `riskDeclaration`, `asking` and `designOnly`, and `check_change`'s optional `pull` and `absentChecks` merge-review declarations.
The work computer already sends these declarations; the home needs this version to preserve them instead of dropping them during request parsing.
Cards already stored without risk are unchanged.
`PlacedToolFieldCoverage` in `src/core/session/tools.ts` checks that every crewmate-declared top-level card and check-reading field exists in its work request; host-resolved card fields and the first mate's target task are excluded.

Protocol 3.2 adds the read-only `inf:working-copy:revision` order and optional exact-base preparation fields to `inf:working-copy:prepare`.
The home requires a matching `headSha` acknowledgement for exact-base preparation, so an older computer that ignores the field never starts a review at another commit.

Protocol 4.2 adds `inf:session:source-file` and `inf:working-copy:source-ref` orders for verified source cards, media and starting work on the destination computer (`docs/helper.md`, "Starting from a source task").
The home names destination paths and refs only after that computer acknowledges them.

Protocol 5.0 adds the home-only `inf:knowledge:directions` and `inf:knowledge:note` reads, and optional direction and older-note collection counts.
The new names also extend the closed read-name enum carried by panel manifests, so the version rule requires a major change.
These are the read-only preparation for notes retirement in protocol 5; protocol 6 replaces those retired reads as described below.

Protocol 5.2 adds per-model crew speed writes, the placed speed-policy read, and optional speed fields on model rows, task shapes and the placed spec.
Speed capability stays on the executing computer; only the requested setting is read from the home.

Protocol 5.3 adds an optional password to `inf:devices:update`, and lets that answer be the same password question Add it already returns.
A client that only reads a device still gets one, except when an Ubuntu package update asks for the password, which older clients never did.

Protocol 5.4 adds the optional `thirdCrewmateDoneAt` to the first-run record (`inf:app:first-run`), the moment the create-your-own-panel slot waits for (`docs/first-launch.md`).
The home still writes `firstTaskDoneAt`, so a view on an older minor keeps showing the slot from it.

Protocol 5.5 adds the `inf:work:knowledge` and `inf:work:record-knowledge` work requests: a crewmate on a computer that runs work reads and writes the home's knowledge through them (`docs/knowledge.md`, "The tools").
The home names the knowledge pair among a task's tools, and writes its knowledge lines into the brief, only for a computer on 5.5 or later (`KNOWLEDGE_THERE_SINCE`), so a computer on an older minor gives its tasks no knowledge.

Protocol 6.1 adds the optional `also` addresses of a pairing link, the optional network `name` where devices find this computer, and the optional `reachedOn` of a device.
A client on an older minor ignores each of them.

Protocol 6.0 replaces the retired `inf:knowledge:note` and `inf:knowledge:older` reads with `inf:knowledge:direction`, removes older-note counts and the legacy search source, and carries the current direction kind through the placed Knowledge write request.
The closed panel read-name enum and removed shapes require a major change; the home still enforces the same crewmate authority, so carrying a direction write does not allow a crewmate to make one.
Knowledge runs in every build, and a profile carried to Knowledge refuses an older notes-writing build (`docs/saved-data-compatibility.md`).

Protocol 6.2 adds an optional fourth boolean argument to `inf:cards:reply`: the view's send-time decision that an ordinary card leaves the stack until the answer.
A lone or `holds_place` card stays; the home persists the decision through the existing awaiting and reply-stamp fields.
A view that omits it retains the earlier stamped behavior, and already waiting stamped cards keep their place until answered.

Protocol 6.3 adds the read-only `inf:computer:resources` order in `resourceOrders`, with bounded, numbered CPU/memory observations and explicit unknown answers (`docs/helper.md`, "Resource observations").
The home only asks a work computer that speaks this version or later; an older computer remains on the existing placement path.

Protocol 7.1 adds `inf:session:clean-temp`, which removes only a closed task's provisioned temporary folder on a computer that runs work (`docs/task-retention.md`, "A task's temporary folder").
It is a new order, so an older computer refuses it; the home does not report that computer as cleaned and retries after it is updated.
A pending answer is not final and is asked again.

Protocol 7.0 adds the `computers.resources` panel read and the `inf:computers:resources` request and push for shared live CPU/memory observations (`docs/helper.md`, "Shared live readings").
The new member of the closed panel read-name enum requires a major version; work computers must match this major before taking work, under the existing rule.
The request is read-only and available to paired views, not work connections; panel subscriptions still require a declared read.
The resource order remains compatible from 6.3; this addition neither changes manual placement nor enables automatic starts.

Protocol 8.2 adds the optional `spellings` to the hello and the welcome: the spellings of channel names each side reads, for the Infinitary rename (`docs/connection.md`, "Two spellings").
A side that says none reads only `fm`, so a client on an older minor is written Firstmate 3000's names, and the update order keeps its one name in every spelling.
The published file names every channel in this build's spelling, `inf:` since protocol 8.4; a client written against it says it reads `inf`, as `scripts/contract-client.ts` does.

Protocol 8.3 adds the optional `key` to a project's setup (`inf:repos:setup`): the task key a new project's tasks are numbered with, which the home refuses in words when another project has it (`docs/fleet.md`, "Choosing a task key").
The request is the home's own, so no client on an older minor sends it.

Protocol 8.4 lets `inf:working-copy:source-ref` name the Infinitary rename's git refs: a task's starting work fetched into `refs/infinitary/sources/`, from a kept ref under `refs/infinitary/kept/`, beside Firstmate 3000's `refs/fm3000/` names (`docs/helper.md`, "Starting from a source task").
A computer on 8.4 also gives its crewmates the browser command as `infinitary-browser-axi`.
A computer on an older minor knows only the older names, so the home names those to it, in the refs and in a placed crewmate's instructions (`INFINITARY_NAMES_SINCE`).

Protocol 8.5 lets a placed crewmate's `inf:work:read-workflow` leave out `jobId`: the run's short read, which saves the home's run watch (`docs/forge.md`, "The run watch").
A home on an older minor refuses that read as a malformed request; a read that names a job is the same on both.

Protocol 8.0 adds the read-only `inf:computer:placement` compatibility order, optional project/task declarations and task placement explanations.
It adds the closed `preparation-failed` and `preparation-unknown` preparation response variants, so the version rule requires a major change and work computers need a matching version.
The order carries actual served models and project/tool/physical-computer facts; CPU and memory still use the shared resource source.

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

`PROTOCOL_VERSION` is `major.minor.patch` (`src/shared/ipc.ts`).

- **Minor**: additive - a new request, a new push, a new optional field, a new capability.
  Nothing a client already sends or reads changes meaning.
- **Major**: anything a client written against an older version could not survive - a request, push or field removed or renamed, a field made required, a meaning changed.

A bump is `PROTOCOL_VERSION` and the regenerated file alone: no test pins the number and no ledger lists the bumps, so two changes that both take the next minor write the same line and merge cleanly.

A home answers every request of a client whose major is its own or the one before it (`PROTOCOL_MAJORS_BEHIND`, 1).
A client on any other major, older or newer, is answered its reads (`effect: "read"`) and sent every push, and each change (`effect: "change"`) is refused, as the result's error, until the client is updated.
A client on an answered major keeps everything it knows whatever its minor, because a minor only adds.

The home applies the rule at the connection (`contractAccess`, `src/core/connection/connection.ts`): the client's `hello` names the version it speaks, and the `welcome` answers the home's own version and `access`, `full` or `read`, so a client hides what it may not do instead of computing the rule itself.
A client also hides what its home lacks by the `capabilities` it lists, not by reasoning about versions.

Both sides read the envelope leniently: a frame field this version does not know is ignored, so adding one is a minor change, never a closed connection.
A request's arguments are read as published.

Because the previous major is answered in full, a major change keeps what that major asks working: a request or push whose shape has to break ships under a new name beside the old one, which the home keeps answering until the next major.
`src/shared/ipc.test.ts` pins the version, so the number moves only on purpose.

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
- `src/core/connection/connection.test.ts`: a home two majors on answers its own major and the one before in full, and an older or a newer client only its reads, with every push; a frame's unknown fields are ignored.
- `src/core/core.test.ts`, "a client that knows only the published contract": the scripted client, as its own process against the real core, answers a stall card and reads the feed; a client one major behind does the same; an older and a newer one read the cards and the feed and have their answer refused, and the card stays.

## Protocol 6.0: required captain actions

Protocol 6.0 adds confirmation and deferral host operations and the `show-card` task operation, new members of closed enums.
Cards, captured offers and placed requests carry optional required-action declarations; task rows carry optional durable action state.
The host owns confirmation effects and observers (`docs/required-actions.md`); old cards remain unchanged historical records.

Protocol 6.2 adds optional `lane` to the placed Knowledge write request, distinguishing captain-stated personal context from saved references without granting different access.
Every crewmate has equal factual access, including no-project tasks; saved task shapes still read legacy `knowledge_access` as inert metadata.
A work computer on an older supported minor can still save references through the same tools; the home defaults its omitted lane to reference.
