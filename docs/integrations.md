# Integrations

An integration is a connection to something outside the person's projects, signed in as the person, that the first mate and every crewmate can reach.
GitHub is the first kind, an MCP server the second, and Google, for Gmail and Calendar, the third.
The captain's design is INF-775: one core primitive, a Settings tab, the same reach for the person and the first mate, and every agent reaching what is added.

## The record

`IntegrationsService` (`src/core/integrations/service.ts`) is the one writer and the one door for every caller.
A row is one connection a kind's binding has now (`IntegrationBinding`, `src/core/integrations/binding.ts`): its id, who it is signed in as, its health, its actions, and the events it can tell.
Each action declares what it does to the world, `reads`, `changes` or `sends`, in its binding, never read off its name, and an input schema.
A kind connects once, as GitHub does, or many times, as MCP servers do; a kind added from a form (`add`) answers the new row's id.
The row's own settings - a name of the person's choosing, paused, and which actions are off - live in `userData/integrations/settings.json`, 0600 in a 0700 folder, written whole (`IntegrationSettingsStore`).
An automatic name repair keeps its previous name and the connection whose name it conflicted with (`renamed`) in the same store's `name-repairs.json`, until the person chooses a name themselves.
The explanation matches the resulting name; an older build still reads `settings.json` unchanged, and a name it changes cannot inherit stale words.
No sign-in is kept there: a kind's sign-in stays with its own owner, and a key it signs in with is kept apart ("Keys").
Which connection each id stands for is the same store's `connections.json` ("Which connection").
The wire shape Settings draws and the first mate reads is `src/shared/integrations.ts`.

## Which connection

An id names a slot, not a connection: an MCP server's id comes from its name, and Google's and GitHub's are fixed, so a connection added after another was removed can have the same id.
The service gives each connection a reference the first time it sees it (`c-` and a random id) and keeps it in `userData/integrations/connections.json` beside the account the connection first answered for (INF-947, piece 1 of the INF-946 plan).
A rename, a renewal, a restart or signing in again as the same account keeps the reference.
Removing the connection through the service forgets it, so whatever comes next under that id gets a new one, and so does a connection that answers for another account than the one it was first signed in as.
An unreadable file reads as none, so every connection gets a new reference and nothing kept before is sent.
A kept ask carries the reference as `connection` (`IntegrationAsk`), and the captain's click runs it only while its id still stands for that connection: otherwise it is refused as removed or replaced, and an ask kept before references existed is refused as kept before the app could tell connections apart.
An Automation rule keeps it the same way (`docs/automation.md`, "Events").
Discovery gives each row's reference as `connection` (the roster, `show`), and a caller may pass it in place of a name to reach exactly that connection ("Names").

## Names

A name is how the person, the first mate and the crew reach a connection, so the service is the one owner of every name and id (INF-946, piece 2; the captain's approval extends INF-882's rule to every kind).
Names compare ignoring case and surrounding spaces, and one compared form belongs to one holder: a row's name, a row's id, a name or id an addition or sign-in is waiting on, or a reserved identity's names while it is signed out.
A kind with one connection declares its identity (`IntegrationBinding.identity`): GitHub and Google do, so their id, default name and saved custom name stay theirs even while signed out.
Adding, signing in, renaming and restoring a default name all run the same check, and a new name that another holds is refused in words; so is a name shaped like a reference.
An addition holds its name, and every id its binding tries (`add`'s `claim`), before it waits on the place, and a sign-in holds the name its row will take while the browser is open; each lets go when it is published, fails or is cancelled (INF-948), so two overlapping additions never publish the same name or id.
A name that clashes anyway - saved by an older version, or a sign-in that arrived outside the service, such as GitHub's - is repaired before any view, roster or lookup escapes, the captain's automatic distinct name with an explanation.
An identity's names stay with it; otherwise a name stays with the row whose id sorts first and an id with its row, never with whichever row a binding lists first.
The renamed row takes its kind's name after the old one when the holder is another kind (Google MCP server), or its own id in brackets when the holder is the same kind (Notes (mcp-notes-2)), with a number if that is taken too, within the published name size.
Only the name changes: ids, references, paused state, disabled actions, keys, event rules and kept requests stay attached to the same connection.
A lookup by reference reaches only that connection, and a reference whose connection was removed or replaced is refused, never looked up again as a name.
Anything else is a name or an id, and reaches a row only when exactly one row answers to it; otherwise it is refused with the candidates and their references.

## What an integration can tell

A connection may declare events (`IntegrationEventSpec`): a name, a few plain words for what happens ("A message arrives"), a description, and `every`, how often the app looks, in the one tick's minutes.
Events are per connection, since an MCP server's differ from server to server.
Its binding's `look` answers what arrived since a cursor and the cursor to look from next; with no cursor it answers where now is and nothing else, and a cursor it lost answers `resynced`.
Each item is its id there and the kind's one-line typed summary, never its body.
Automation reads these to fire a rule (`docs/automation.md`, "Events"); `show` lists them, and the integrations view carries them for the When choice.
GitHub declares none.
An event may declare closed string filter fields (`filters`), with a name, label and optional default value; discovery lists them, the shared Automation editor draws them, and the saved rule passes only declared fields back to the binding.

## A stand-in

An unpackaged run that names a folder in `INFINITARY_STAND_IN_INTEGRATION` connects the stand-in (`providers/standIn.ts`), which tells `item_arrived` for each line added to that folder's `items.jsonl`, `{"id": ..., "summary": ...}`.
It has no actions and no sign-in, and a packaged build never connects it.

## The rules

Every action of every new or existing connection starts at Asks you (`ask`), including reads (the captain's accepted INF-950 plan).
Always allowed (`allow`) runs it without a card; Off (`never`) refuses it.
Agents see every action and its state, including Off actions.
A call at Asks you must carry a reason; without one the service refuses it and asks for the reason.
The service keeps its exact checked input as an `IntegrationAsk` on the crewmate's task and raises its own card from typed facts: caller, action, description, effect, exact input and the reason marked as the crewmate's words.
The first mate's calls follow the same rule (INF-1108): it has no task, so its card is a host card with no task, the host files that card's own row (`TaskService.fileHostCardTask`), and the ask, marked `by: "firstmate"`, waits on it with the reason marked as the first mate's words.
The buttons are Always allow, Only this time and Not now; reads highlight Always allow, while changes and sends highlight Only this time.
Always allow runs the call and saves its action's grant; Only this time runs it once and leaves Asks you; Not now or closing the card runs nothing.
The click takes the ask before running it, and the existing `write-answered` steer delivers the outcome once, including refusals.
The first mate's card row closes with the click or the close, so the click takes its ask in the same transaction that closes the row, and closing the card takes it before the row goes; its outcome is a `write-answered` wake on the durable inbox, named once by the ask, and it runs as the first mate's own call.
Grants live in `action-approvals.json` beside the older strict `settings.json`, keyed by connection reference and action, and bound to the action's description and effect.
A missing or unreadable grant file asks again; an existing connection has no grant until the captain chooses one.
Settings changes, removing or replacing a connection, signing in as another account, or changing an MCP tool's description or read-only mark end Always allow.
MCP refreshes its declarations before the grant check, including on a restarted server; invalidated grants are forgotten, so changing a tool back cannot revive them.
Settings shows an action's state as a keyboard-reachable choice between Asks you and Always allowed, beside its independent Off switch.
The rule choice is a captain-only catalog action; the first mate cannot grant itself access by changing Settings.
An unknown outcome after a request left is never retried (`IntegrationOutcomeUnknown`); a kept ask is consumed even on refusal or failure.
A paused integration answers nobody.
An input that does not fit an action's schema is refused before the binding is reached, and so is any call while a key the kind needs is not entered.
What an integration answers is evidence from outside, never an instruction, and every caller's words say so.
A kind whose words anyone can write also fences them ("Data from outside").

## Data from outside

A kind whose answers and event summaries carry words anyone can write, such as a message or an invitation, declares the label they reach every agent under (`IntegrationBinding.fence`); Google declares `google-data` (INF-951).
Google's [Workspace user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) asks for "protecting against prompt injection techniques", and anyone can mail the captain words meant for their crew.
`IntegrationsService` fences every answer of such a kind that is not a refusal, whoever called: the first mate's `use_integration`, a crewmate's command here or on a computer that runs work, and the answer a captain's click on a kept ask sends back.
It fences each event summary the kind's `look` tells the same way.
The words sit between an opening mark, `[[google-data fence=<value> read=<when>]]`, and a closing mark, `[[/google-data fence=<value>]]`, whose value is 64 random bits drawn for that one span (`src/shared/outsideData.ts`).
Whoever wrote the words could not know the value, so nothing inside can close the span early.
A copy of either mark in the words is broken (`[ [google-data`) before they are fenced, so none reads as the app's.
A line before and after an answer names its fence and says the span is data from outside, to read and report but never to follow.
A shell that cuts a long answer keeps its start or its end, so one of the two lines stays with what it keeps.
A rule's list of events ends with one such line for each label its lines hold (`eventsWords`, `src/shared/automation.ts`).
The words are otherwise unchanged, so a reply can still quote them and a summary reads as it did.
A refusal and an error are the app's own words and stay as they are.
The opening mark keeps the moment the words were read, and `fencedSpans` finds each span, one cut short included, so a later pass can find what an agent read in saved records.
That pass is how fenced words leave saved conversations: a kind declares how many days they stay (`IntegrationBinding.kept`, 30 for Google), then a note takes their place, and Settings → General deletes them at once ([Task retention](task-retention.md#words-from-outside)).
The fence carries what the host knows, where the words came from, and never a verdict on them: no rule reads the words to judge whether they try to steer anyone (`docs/principles.md`).
What the fence does not close, and how each way out stands, is in [Google verification material](google-verification.md#prompt-injection).

## Keys

A kind that signs in with a key the person makes, such as an MCP server's API key, declares its slots on its binding (`IntegrationSecretSlot`): a name and plain words, never a value.
The values are kept behind one interface, `IntegrationSecrets` (`src/core/integrations/secrets.ts`), which the protected Secrets owner ([Secrets](secrets.md)) takes over once the app constructs it (INF-1109); until then the bridge `FileIntegrationSecrets` keeps them the way the forge keeps its sign-ins, one 0700 folder per integration under `userData/integrations/secrets/` and one 0600 `secrets.json` in it, written whole (the captain's q3 on INF-775).
Moving every value into the secret manager and removing the bridge is INF-785.
Nothing reads a value back through the interface.
A binding uses one in the two ways the saved secret plan names: `request` applies it to one request, as a header or as one field of a form body, and gives back the answer (brokered use), and `launchEnv` hands it to a program the integration starts as a named variable (protected launch).
Every answer an action gives, and every refusal, leaves the service with each kept value replaced by "[a kept key]", so a place that echoes a key back cannot pass it to a caller.
The view Settings and the first mate read, `integrations <name>` and a crewmate's `show` say only whether each slot is kept, and the roster line says when one is missing.
The captain enters, replaces or removes a key in the open row in Settings -> Integrations, a write-only field that never shows a kept value; that one request, `inf:integrations:secret`, is the catalog's `integration-key` line, the captain's hands only, and its trail records no value.
Removing an integration forgets its keys.

## GitHub

GitHub's row is the app's own github.com sign-in, made and kept by the forge (`ForgeSignIns`, `docs/forge.md`), seen through the binding in `src/core/integrations/providers/github.ts`.
The row exists exactly while that sign-in does, and removing the row signs it out.
The binding declares its permanent identity, so its id, GitHub and any saved custom name remain reserved even while signed out ("Names").
An older connection already using a reserved name gets a distinct name automatically, as the captain chose on INF-882: for example GitHub MCP server.
Settings explains the change directly below the renamed row, even while collapsed, and the crew's discovery and the first mate's roster carry the same explanation.
GitHub sign-in, clones and pull requests never wait on an integration rename.
Its two actions are the gateway's two calls through that sign-in, whatever the caller's project is: `read` (GET or HEAD one REST path) and `write` (POST, PATCH, PUT or DELETE) follow the same per-action approval rule.
The integration service owns approval for both calls, while the gateway still enforces its API limits and refuses merges and default-branch changes.
The first mate's calls go through the same sign-in as its seat's own (`GithubGatewayService.readAsSeat` and `writeAsSeat`), count against its seat's allowance, and its write keeps the same merge and default-branch refusals.
Pull requests, checks and merges stay the forge's and the project's.

## MCP servers

An MCP server is added by its name and what it runs (`src/core/integrations/providers/mcp/`, INF-781): a program and its arguments, or the server's https address.
The binding speaks MCP through the SDK's second version (`@modelcontextprotocol/client`), which reaches a server in either protocol era, the 2025 one or 2026-07-28's; the first version stays for the in-process Claude tool server.
What it runs is read by no shell (`runs.ts`): quotes group words, leading `NAME=value` words set the program's environment, and a pipe, a redirect, a `$` or a backtick is refused in words.
A program starts as a child on this computer with `hostEnv()` below the window (`atUtilityQos`), in the person's home folder, on the first call or when a rule listens to it, and stops after five minutes with no call and no look from a rule; every program stops when the app does.
An address is reached the way a custom API is (`guardedFetch.ts`): its network class - this computer, a private network or the public internet - is read when it is added and held on every request, which resolves the name again, connects only to checked addresses with the normal certificate roots, and refuses a redirect or another origin; plain http is only for a server on this computer.
Adding connects at once and keeps the server's own list (the captain's q7, "trust the server's list and show it after"): each tool is an action under the name it had when first seen, in snake case, with the server's own JSON Schema as its input, and a server that cannot connect is refused with why and leaves no row.
A tool the server marks read-only (`readOnlyHint`) reads; every other tool changes.
A server with resources gains one more read, `read_resource`, which reads one by its address.
Its reads and changes follow the same per-action rule ("The rules").
The list is read again each time the program starts, and Check now starts it again.
The servers, what each runs, its held network class and the lists it answered live in `userData/integrations/mcp.json`, 0600 in the same folder; what a server runs is never shown to the first mate or a crewmate.

## An MCP server's events

An MCP server that lets a client subscribe to its resources tells one event, `resource_changed` ("A resource changed"): the binding subscribes when a rule first looks, through the 2026-07-28 era's `subscriptions/listen` or the 2025 era's per-resource subscribe, and keeps each change it hears with its resource's address.
A look (`IntegrationsService.look`) answers the changes since a cursor; a cursor from before the program last started, or older than the 500 changes kept, answers `resynced`, because nothing can say what changed while the program was down.

## Google

Google is one row that signs in once for Gmail and Calendar, asking every permission up front (the captain's q8 on INF-775), as Infinitary's own Google client (q4 on the same task), in `src/core/integrations/providers/google/`.
Its permissions are Gmail's `gmail.modify` and Calendar's `calendar.events`, `calendar.calendarlist.readonly` and `calendar.events.freebusy` (`GOOGLE_SCOPES`, `client.ts`): an installed app cannot add a permission later, and the same sign-in reaches both APIs.
The calendar list and availability take the narrowest scope Google accepts for `calendarList.list` and `freeBusy.query`; a sign-in an earlier version made with `calendar.readonly` keeps working, since Google accepts that for both calls and the app never rechecks a kept sign-in's permissions.
Google's device flow does not reach Gmail or Calendar, so the sign-in is the installed-app flow (`signIn.ts`): the app listens on `127.0.0.1` at a port the system picks, opens Google's consent page in the person's browser with PKCE (S256), a state, offline access and consent every time, and trades the code the browser brings back for the sign-in.
The listener turns away anything without the sign-in's state and closes once the browser answers or the sign-in is cancelled; a second sign-in ends the first.
The binding declares its identity, so Google and a saved custom name stay its own while signed out ("Names"): a server an older version let take the name Google is renamed Google MCP server with the explanation, and Google signs in beside it.
A sign-in in which the person unchecked any Gmail or Calendar permission is handed back to Google and kept nowhere.
The access key and the lasting key are kept in the integration's key store ("Keys") under `access_token` and `refresh_token` and used only through it: the access key as each Gmail or Calendar request's bearer, the lasting key as the renewal's form field and, on removal, the revocation's.
The row declares no key slots, so it has no key fields; who it is signed in as, what Google granted, when the access runs out and its health are `userData/integrations/google.json`, 0600 (`GoogleSignInStore`).
The access renews when it has less than one request's time left, and once more when Gmail refuses it; health is `needs_reauth` only when Google refuses the lasting key or refuses a request again after a real renewal, and `unavailable` when Google cannot be reached or fails.
When Gmail answers 429, or 403 for a rate limit, with Retry-After, no request goes to Gmail until then, and a rule's look tries again on its next minute; the sign-in's health stays as it was.
Removing the row asks Google to revoke the sign-in, as far as Google can be reached, and forgets it here either way.

Gmail's actions (`gmail.ts`) are `search_mail` and `read_message`, which read, `label_message` (removing INBOX archives) and `draft_message`, which change, and `send_message`, which sends; each action follows the per-action rule ("The rules").
A message read is its plain text, or its HTML read as text in one pass over it, so markup a sender never closes cannot slow the app's own process.
A message is built as plain-text RFC 2822 with a subject outside ASCII in encoded words, a reply carries its thread and In-Reply-To, and an address or subject with a line break is refused before anything is asked.
Gmail tells `message_received` ("A message arrives") from its history of messages added to the inbox: the cursor is the history id and the mailbox it belongs to, each item's summary is its sender and subject, and a history id Gmail no longer keeps (404) or a cursor from another mailbox answers `resynced`.
Calendar's actions (`calendar.ts`, INF-786) are `list_calendars`, `list_events`, `read_event` and `free_busy`, which read, and `create_event` and `update_event`, which change; all follow the per-action rule.
Calendar ids come from `list_calendars`; actions use the primary calendar when none is named, and paged lists return `next_page`.
Times are RFC 3339 instants with explicit offsets, or dates for all-day events whose end is exclusive; a start and end have the same shape, and the end follows the start.
An update patches only the fields named, replacing the attendees list if supplied; changing times supplies both start and end.
`send_updates` declares guest notifications (`none`, the default, `all` or `externalOnly`), and that choice stays in the exact input the captain approves.
`free_busy` reads by POST but changes nothing, and preserves per-calendar errors alongside busy intervals.
No action deletes an event.
Calendar tells `event_changed` ("A calendar event changes") every minute, filtered by `calendar` (an id from `list_calendars`, primary by default).
Its first full sync reads every page and fires nothing; subsequent looks keep the same calendar and use Google's sync token with no incompatible time range or query.
Each changed event carries an id derived from its calendar, event id and revision, so two edits of the same event can both fire while a replay of one revision deduplicates.
The summary carries title, event id, calendar and times, or cancellation, never its description or guests.
A lost sync token (410), another account or another calendar discards the old cursor and re-baselines without firing; a failed or incomplete sync never advances the cursor.
Both APIs share one renewal and backoff boundary; a Calendar rate limit holds Gmail too, and a read-only free/busy failure never claims an outward change happened.

`GOOGLE_OAUTH_CLIENT` holds Infinitary's registered public Desktop app client, including the installed-app client secret that Google does not treat as confidential.
`googleSetup` offers Google in development and packaged builds on both stable and alpha channels, for the captain's private experimental rollout.
Stable is the private testers' distribution and alpha is the captain's development channel; neither channel label establishes Google's verification or a public launch.
Packaged builds always use Infinitary's registered client and Google's HTTPS endpoints, ignoring development client and endpoint overrides.
An unpackaged run uses those defaults, or may name a client and a stand-in Google: `INFINITARY_GOOGLE_CLIENT_ID`, `INFINITARY_GOOGLE_CLIENT_SECRET` and `INFINITARY_GOOGLE_URL`, every address under that one (`googleSetup`).
Google Cloud's External / In production audience permits unverified access without an individual tester list, normally with a 100-user lifetime project cap and an unverified-app warning.
Google or an account's administrator may still refuse access; offering the chip is not proof of verification, assessment or policy compliance.
[Google verification material](google-verification.md) owns the draft privacy copy, permission justifications, real-consent demonstration script and CASA answer bank.
It distinguishes registration from submission readiness, including downstream AI processing, storage and deletion obligations; a stand-in demonstration is not evidence of Google's approval.

## Google's notice

Before Google's sign-in starts, the app shows Google's notice and waits for the person's accept (INF-949).
Google's [Workspace user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) asks for an in-app disclosure of the data used and where it goes, never only in a privacy policy, that immediately precedes the consent request, and for no collection before an affirmative consent.
The notice's words are `INTEGRATION_NOTICES` in `src/shared/integrations.ts`: what Infinitary uses from Gmail and Calendar, and where it goes, which is the person's AI provider, another computer that runs the work, and the saved task records.
For the saved task records it says how long what the agents read stays, 30 days, how to delete it sooner on this computer from Settings → General, and what stays until the task is deleted: what the agents wrote themselves.
Only the person's agreement and settings with their provider decide whether that provider trains on what it receives, while Google does not allow its data to train AI models, so the notice says both and asks the person to check their provider before connecting.
The core holds the accept as a fact of the sign-in: `IntegrationsService.signIn` refuses a kind with a notice unless the request carries `{ noticeAccepted: true }`, before any browser opens, before a waiting sign-in ends and before anything is asked of Google.
The accept covers one sign-in and is never saved, so every way into Google's sign-in shows the notice again: the chip, a row's Sign in again, and a card that opens Google's sign-in.
Its last group says what the app does against a message written to mislead an agent, and the way out it cannot close: a crewmate's own reach to the internet (INF-951, [Google verification material](google-verification.md#prompt-injection)).
Open the page again, while that sign-in waits, reuses the accept it followed.
Cancel, closing Settings or leaving the tab asks nothing of Google.

## GitLab and GitHub Enterprise

Each signed-in GitLab host (`gitlab`) and GitHub Enterprise host (`github-enterprise`) is its own integration (`providers/forgeHosts.ts`), over `ForgeSignIns` and its existing locked per-host files, health and renewal.
The public GitLab row is named GitLab; self-hosted rows use their address, with the existing server-name fallback for an address too long for a row.
Both kinds are always addable and reserve no signed-out identity; the ordinary integration name repair keeps their names distinct from other connections.
Ids are derived from the host with a hash so addresses that differ only in punctuation, or exceed the id shape, remain distinct.
Each row has `read` and `write`, action switches, Check now, Pause or Resume, and Sign out and remove, using the same gateway and captain approval as GitHub.
A task reaches the named host through the gateway's account route with no project, so even a write to its own project asks; a kept ask records that host and is sent through it rather than the task's current project.
The first mate reads and writes as its seat, under the same rules; the existing integration relay gives crewmates on other computers the same rows without transferring a sign-in.
GitLab paths are relative to `/api/v4`; Enterprise paths are relative to its REST API.
The GitLab chip opens the existing browser registration guide or key alternative; GitHub Enterprise opens its existing key form.
A signed-in host's form opens below its row, while a new host's form opens below the chips.
Older host sign-in cards still name the host in `signIn`; a new `integration-add` handoff can name a kind and host before the forge knows that server, carried as a typed `gitlab:<host>` or `github-enterprise:<host>` arrival.
Add project's signed-out host selector offers Sign in to that host, opening Integrations with its form ready; signed-in hosts keep their project listing in Projects.
Project cloning, change requests, checks and merges continue through the project forge, unchanged.
These kinds declare no Automation events and do not move keys into the integration secret store.

## Settings -> Integrations

The tab sits between Automation and Devices (`IntegrationsTab.tsx`; design skill `components/integrations/IntegrationRow`), and opens from command search as Open Integrations (`settings.integrations`).
Each row shows its health dot, its name, who it is signed in as or what it runs, and how many actions are on; its chevron opens its actions, each with what it does, its rule and a switch, then what it can tell, and its menu checks it now, pauses or resumes it, or signs out and removes it.
The chips at the foot connect a kind not yet connected; for GitHub that starts the device flow and shows the code in the tab.
For Google it shows Google's notice in the same place ("Google's notice"), and its accept opens Google's page in the browser (`inf:integrations:sign-in`); an aside then says to finish there, with Open the page again and Cancel (`inf:integrations:sign-in-cancel`); the new row opens once the browser is back, and a sign-in that did not finish says why in the tab.
The "MCP server" chip is always there: its form takes a name and what the server runs, and Connect opens the new row on the server's tools, or says in the form why it could not.
GitHub, GitLab and GitHub Enterprise sign-ins live here; Projects keeps a pointer line and other computers' own GitHub sign-ins.
A card's `open` effect that names `projects` with a forge host in `signIn` lands on this tab (`openedSection`), so older cards and the host's "Sign in to GitHub again" card still arrive where the sign-in lives; one with `signIn: "google"` lands here and opens Google's notice, whose accept opens Google's page.
Like Projects, the tab does not show on a paired view.

## How the first mate reaches them

The first mate's context block carries one `integrations` line naming each connected integration and who it is signed in as, so an integration nobody uses costs one name.
`integrations` lists them, or one's actions with their effect, rule and input schema; `use_integration` runs one action (`src/core/pi/integrationTools.ts`).
An action at Asks you needs its `reason`; the app keeps the call and raises its own card, and the first mate emits no card of its own and hears the outcome once as `write-answered` ("The rules").
That card, or a change or send that ran, counts as what its turn did for answer delivery (`docs/task-capture.md`, "Answer delivery").
Their words never change with what is connected, so a seat never starts over when an integration comes or goes.
It changes them through `app_change` in the area `integrations`, the same channels the tab writes: `integration-add` hands the captain to the tab for GitHub, GitLab, GitHub Enterprise or Google, with an optional host for either server kind (a sign-in is the captain's to make), refusing a kind this build cannot sign in to, `integration-add-mcp` adds an MCP server the captain named, `integration-remove` needs the captain's own words, and `integration-settings`, `integration-check` and `integration-add-mcp` are asked actions.

## How a crewmate reaches them

A crewmate runs `infinitary-integrations-axi` on its task channel (`docs/axi-commands.md`, "The integrations command"): discover, then call.
Its instructions carry one line for it (`CREWMATE_INTEGRATIONS_LINE`, `src/core/integrations/commandWords.ts`).
A task on this Mac is granted the command whenever the host has a command process.

## On a computer that runs work

A crewmate on a computer that runs work (`docs/helper.md`) runs the same command in its shell there, and reaches this Mac's integrations: the integrations and their sign-ins stay here, and nothing of a sign-in goes to that computer.
That computer's task channel carries the command (`ComputerBrowsers`, `src/core/helper/browsers.ts`), and each list, show and call is asked of this Mac (`inf:work:integrations` for list and show, `inf:work:use-integration` for a call; `SessionHost`, `src/core/helper/sessionHost.ts`).
This Mac answers it through `IntegrationsService.forTask` under the same rules as for a task here, so each call follows this Mac's saved approval rule, and an action at Asks you is kept and presented here.
A call is a change in the conversation's ledger (`docs/helper.md`, "Holding a conversation"): one asked again after a drop is answered from what this Mac kept, and one this Mac began without a kept answer is never run again.
A command waiting on this Mac answers before its command process is stopped, and a call not yet sent when it stops is never sent later.

The home grants the command, and its one line in the crewmate's instructions, only to a computer that has a task channel (its roster's `browsers`) and lists the `integrations-there` contract change (`PlacedSessions.takesIntegrations`; `docs/contract.md`, "Changes by name").
A computer without the change, or without a task channel, gives its crewmates neither the command nor the line.
What a crewmate there read stays in its conversation on that computer: neither the 30 days nor the delete in Settings reaches it yet ([Task retention](task-retention.md#words-from-outside)).

## Tests

`src/core/integrations/service.test.ts` holds the view drawn from the github.com sign-in, settings that hold across a restart, a paused integration refusing, removal signing out, reserved names while signed out, automatic repairs and their explanations, custom names, case-insensitive conflicts and name-size boundaries.
Its INF-950 cases exercise missing reasons, all three choices, grants across restart, existing-connection defaults, Off, account and tool changes, and honest unknown outcomes without a card.
Transport tests explicitly choose Always allowed for their read fixtures; they do not assume reads bypass approval.
Its INF-946 cases hold a name and id while an addition or a sign-in waits and let them go when it ends, check a reset to a default name like a rename, repair a shared name or another's id the same way whatever order the rows come in, and reach a connection by its reference but never a removed one by its name.
The Google case in `googleIntegration.test.ts` renames a server an older version saved as Google, refuses the name while signed out, signs in beside it, and refuses restoring the server's name once Google is renamed Mail (INF-938); the MCP case of INF-948 starts three additions together against stand-in servers and finds two distinct ids and a refusal.
The GitHub naming journey in `tests/e2e/older-profile.spec.ts` upgrades a real MCP discovery saved under GitHub, checks the explanation and the signed-out name refusal by keys, signs in through the GitHub stand-in, reads projects, restarts, and has a crewmate read both connections by their distinct names.
The kept-request case in `mcpIntegration.test.ts` approves an ask saved before the repair and observes exactly one change on the original server, with no GitHub write; the event's id stays the same too.
Its INF-947 cases remove a stand-in notes server and add another under the same name and id: the ask kept for the first is refused and neither server changes, an ask kept for the replacement runs after a rename and a restart, an ask kept by an older build is refused, and a rule on the removed server never looks at the replacement until it is pointed there with `reconnect`, nor does a rule saved by an older build.
The Google case of the same number keeps an ask through a renewal and a sign-in as the same person, and refuses it once the row signs in as another account.
`src/core/forge/providers/github/gateway.test.ts` holds GitHub through the integration against a stand-in GitHub: a crewmate's read runs, its write is kept as an ask even on its own project and sent by the captain's click, the first mate's read runs and its write is kept, sent once through its seat when taken and refused when GitHub refuses it, and an action turned off reaches nothing.
`src/core/orchestrator/crewSupervisor.test.ts` holds the first mate's card: the call waits on the card's own row, the click runs it once, closing the card is Not now, and either wakes the first mate once.
`src/core/axi/channel.test.ts` runs the command through the real launcher and channel.
`src/core/integrations/secrets.test.ts` holds the keys against a stand-in API that sends back the header it received: the file and folder modes, a view and discovery that never carry a value, a call refused while its key is missing, a key applied to one request and replaced in the answer, a program's variables, and a change kept as an ask that runs once on the click and not at all once its action is off.
`src/core/placed/placedSessions.test.ts`, "the integrations command on a computer that runs work", runs it from a real Pi crewmate's shell on a joined computer through that computer's launcher, command process and task channel and across the real connection to this Mac's integrations over a stand-in GitHub: list and show answer what is connected here, a read runs through this Mac's sign-in, a reasoned write raises a host card here, and its once-only choice sends exactly one request and returns its outcome to that crewmate, the instructions there carry the line, no file there holds the token, and a computer that does not list the change gets neither the command nor the line.
`src/core/integrations/providers/mcp/mcpIntegration.test.ts` adds a stand-in notes server (`tests/helpers/mcpStandIn.ts`) in both protocol eras, over stdio and over HTTP: its own list becomes the row, reads run, a change is kept as an ask that runs once on the click, a change the server took before its connection dropped is unknown and never run again, a changed resource is told, and an address leaving its class or redirecting is refused.
`tests/e2e/integrations-mcp.spec.ts` adds the stand-in by keyboard, reads through an Always allow card, refuses one change with Not now, runs another with Only this time, and changes the read’s state by keyboard.
`src/core/integrations/providers/google/googleIntegration.test.ts` signs in to a stand-in Google (`tests/helpers/googleStandIn.ts`, answering in Google's documented shapes) through the loopback with PKCE and every permission: a sign-in that carries no accept of Google's notice opens no page and asks Google nothing (INF-949), a declined or partial consent keeps nothing, a sign-in while an MCP server is named Google is refused before the browser opens, a cancel ends the wait, reads run, a message written to steer an agent reaches the crewmate and the first mate fenced as data from outside with the marks it forged broken, and its summary is fenced in a rule's list (INF-951), an HTML-only message full of markup that never closes reads as its words, a label, a draft and a send are kept as asks that run once on the click, a send Gmail took before the connection dropped or it failed is unknown and never sent again, the history cursor tells what arrived and resyncs on a 404 or another mailbox, a 429's Retry-After holds every request, the access renews before it runs out and after a refusal, Google refusing the lasting key asks for a new sign-in, removal revokes, and no key reaches the view, discovery or the facts file.
`tests/e2e/integrations-google.spec.ts` signs in from the Google chip by keys against the stand-in, through Google's notice, which takes the focus, reads what it uses and where it goes, and opens nothing until its accept or after its Cancel, and has a message arriving fire a rule to the first mate, its sender and subject fenced as data from outside.
`src/core/integrations/savedOutsideData.test.ts` reads Gmail through the stand-in into a crewmate's and the first mate's saved conversations, Pi's and the Claude client's, and has a note take its place after 30 days or on a delete, a working conversation's once it pauses, with a rule's run and its waiting message (INF-952).
`src/core/orchestrator/schedulerEvents.test.ts` fires Automation from the stand-in's events, and `tests/e2e/automation-events.spec.ts` saves an event rule by keys and reads the one first mate turn three items make.

The Calendar cases in `googleIntegration.test.ts` exercise all six actions, single-consent access to both APIs, exact once-only write asks, disabled and invalid calls, unknown write outcomes, renewal, rate backoff, paged sync, revision ids, cancellation, calendar selection and 410 recovery against `tests/helpers/calendarStandIn.ts` through the same local Google sign-in.
The Calendar journey in `integrations-google.spec.ts` opens the single row by keyboard, reads the action rules, saves a selected-calendar rule by keyboard, and observes only that calendar's later revision in the first mate's turn.
