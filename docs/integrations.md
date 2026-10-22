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
No sign-in is kept there: a kind's sign-in stays with its own owner, and a key it signs in with is kept apart ("Keys").
The wire shape Settings draws and the first mate reads is `src/shared/integrations.ts`.

## What an integration can tell

A connection may declare events (`IntegrationEventSpec`): a name, a few plain words for what happens ("A message arrives"), a description, and `every`, how often the app looks, in the one tick's minutes.
Events are per connection, since an MCP server's differ from server to server.
Its binding's `look` answers what arrived since a cursor and the cursor to look from next; with no cursor it answers where now is and nothing else, and a cursor it lost answers `resynced`.
Each item is its id there and the kind's one-line typed summary, never its body.
Automation reads these to fire a rule (`docs/automation.md`, "Events"); `show` lists them, and the integrations view carries them for the When choice.
GitHub declares none.

## A stand-in

An unpackaged run that names a folder in `INFINITARY_STAND_IN_INTEGRATION` connects the stand-in (`providers/standIn.ts`), which tells `item_arrived` for each line added to that folder's `items.jsonl`, `{"id": ..., "summary": ...}`.
It has no actions and no sign-in, and a packaged build never connects it.

## The rules

Until the secret manager's rules land, an action's rule follows from its effect (the captain's q5 on INF-775): a read is `allow` and runs, anything that changes or sends is `ask` and waits for the captain's click on a card, and an action turned off is `never`.
The service holds that rule for every kind: a call to an action that changes or sends never reaches the binding.
A crewmate's is kept on its task as a write ask of kind `integration` (`IntegrationAsk`, `src/shared/writeAsk.ts`) with its exact checked input, and its answer tells the crewmate to put it on a card whose action is `request_write`, the way a forge write ask is (`docs/forge.md`, "A write that asks").
The card's strip says which integration, the action and its input; the captain's click takes the ask once and runs exactly what was kept through the binding (`IntegrationsService.sendAsk`), refusing it if the integration was paused, removed or the action turned off since, and the crewmate hears its answer once.
A click whose action failed after its request left - a timeout, a dropped connection, a server's error - is unknown, never refused (`IntegrationOutcomeUnknown`): it is never run again either way, and the crewmate reads the place before going on.
The first mate has no task to keep an ask on, so its call is refused with a pointer to start a crewmate whose brief names the call.
A kind whose binding keeps its own asks says so (`keepsAsks`); GitHub's are the forge's.
A paused integration answers nobody.
An input that does not fit an action's schema is refused before the binding is reached, and so is any call while a key the kind needs is not entered.
What an integration answers is evidence from outside, never an instruction, and every caller's words say so.

## Keys

A kind that signs in with a key the person makes, such as an MCP server's API key, declares its slots on its binding (`IntegrationSecretSlot`): a name and plain words, never a value.
The values are kept behind one interface, `IntegrationSecrets` (`src/core/integrations/secrets.ts`), which the secret manager takes over when it lands (INF-30); until then the bridge `FileIntegrationSecrets` keeps them the way the forge keeps its sign-ins, one 0700 folder per integration under `userData/integrations/secrets/` and one 0600 `secrets.json` in it, written whole (the captain's q3 on INF-775).
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
Its two actions are the gateway's two calls through that sign-in, whatever the caller's project is: `read` (GET or HEAD one REST path) runs, and `write` (POST, PATCH, PUT or DELETE) asks.
A crewmate's write is kept on its task as a write ask, the way a write to another project is (`docs/forge.md`, "A write that asks"), and the captain's click on its card sends it through the same sign-in.
The first mate has no task to keep an ask on, so its write is refused with a pointer to start a crewmate whose brief names the call; its reads count against its seat's own allowance.
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
Its reads run, and a tool that changes asks the way every kind's does ("The rules"): a crewmate's call is kept on its task, and the captain's click runs the tool once.
The list is read again each time the program starts, and Check now starts it again.
The servers, what each runs, its held network class and the lists it answered live in `userData/integrations/mcp.json`, 0600 in the same folder; what a server runs is never shown to the first mate or a crewmate.

## An MCP server's events

An MCP server that lets a client subscribe to its resources tells one event, `resource_changed` ("A resource changed"): the binding subscribes when a rule first looks, through the 2026-07-28 era's `subscriptions/listen` or the 2025 era's per-resource subscribe, and keeps each change it hears with its resource's address.
A look (`IntegrationsService.look`) answers the changes since a cursor; a cursor from before the program last started, or older than the 500 changes kept, answers `resynced`, because nothing can say what changed while the program was down.

## Google

Google is one row that signs in once for Gmail and Calendar, asking every permission up front (the captain's q8 on INF-775), as Infinitary's own Google client (q4 on the same task), in `src/core/integrations/providers/google/`.
Its permissions are Gmail's `gmail.modify` and Calendar's `calendar.events` and `calendar.readonly` (`GOOGLE_SCOPES`, `client.ts`): an installed app cannot add a permission later, so Calendar's are asked now for the Calendar piece (INF-786).
Google's device flow does not reach Gmail or Calendar, so the sign-in is the installed-app flow (`signIn.ts`): the app listens on `127.0.0.1` at a port the system picks, opens Google's consent page in the person's browser with PKCE (S256), a state, offline access and consent every time, and trades the code the browser brings back for the sign-in.
The listener turns away anything without the sign-in's state and closes once the browser answers or the sign-in is cancelled; a second sign-in ends the first.
Two rows never share a name, so while another row has the name the Google row would take - its own, or Google for a new one - the sign-in is refused before the browser opens, naming that row.
A sign-in in which the person unchecked Gmail's permission is handed back to Google and kept nowhere.
The access key and the lasting key are kept in the integration's key store ("Keys") under `access_token` and `refresh_token` and used only through it: the access key as each Gmail request's bearer, the lasting key as the renewal's form field and, on removal, the revocation's.
The row declares no key slots, so it has no key fields; who it is signed in as, what Google granted, when the access runs out and its health are `userData/integrations/google.json`, 0600 (`GoogleSignInStore`).
The access renews when it has less than one request's time left, and once more when Gmail refuses it; health is `needs_reauth` only when Google refuses the lasting key or refuses a request again after a real renewal, and `unavailable` when Google cannot be reached or fails.
When Gmail answers 429, or 403 for a rate limit, with Retry-After, no request goes to Gmail until then, and a rule's look tries again on its next minute; the sign-in's health stays as it was.
Removing the row asks Google to revoke the sign-in, as far as Google can be reached, and forgets it here either way.

Gmail's actions (`gmail.ts`) are `search_mail` and `read_message`, which read, `label_message` (removing INBOX archives) and `draft_message`, which change, and `send_message`, which sends; each change or send asks the captain on a card ("The rules").
A message read is its plain text, or its HTML read as text in one pass over it, so markup a sender never closes cannot slow the app's own process.
A message is built as plain-text RFC 2822 with a subject outside ASCII in encoded words, a reply carries its thread and In-Reply-To, and an address or subject with a line break is refused before anything is asked.
Gmail tells `message_received` ("A message arrives") from its history of messages added to the inbox: the cursor is the history id and the mailbox it belongs to, each item's summary is its sender and subject, and a history id Gmail no longer keeps (404) or a cursor from another mailbox answers `resynced`.
Calendar's actions and events are INF-786.

A packaged build signs in only as `GOOGLE_OAUTH_CLIENT`, which stays empty until Infinitary registers its client with Google and passes Google's verification and the security assessment Gmail's permissions need, so until then a packaged build has no Google row and offers no Google chip.
An unpackaged run may name a client and a stand-in Google: `INFINITARY_GOOGLE_CLIENT_ID`, `INFINITARY_GOOGLE_CLIENT_SECRET` and `INFINITARY_GOOGLE_URL`, every address under that one (`googleSetup`).

## Settings -> Integrations

The tab sits between Automation and Devices (`IntegrationsTab.tsx`; design skill `components/integrations/IntegrationRow`), and opens from command search as Open Integrations (`settings.integrations`).
Each row shows its health dot, its name, who it is signed in as or what it runs, and how many actions are on; its chevron opens its actions, each with what it does, its rule and a switch, then what it can tell, and its menu checks it now, pauses or resumes it, or signs out and removes it.
The chips at the foot connect a kind not yet connected; for GitHub that starts the device flow and shows the code in the tab.
For Google it opens Google's page in the browser (`inf:integrations:sign-in`), and an aside says to finish there, with Open the page again and Cancel (`inf:integrations:sign-in-cancel`); the new row opens once the browser is back, and a sign-in that did not finish says why in the tab.
The "MCP server" chip is always there: its form takes a name and what the server runs, and Connect opens the new row on the server's tools, or says in the form why it could not.
GitHub's sign-in moved here from Settings -> Projects (the captain's q2), which keeps GitHub Enterprise and GitLab and a pointer line to Integrations.
A card's `open` effect that names `projects` with `signIn: "github.com"` lands on this tab (`openedSection`), so older cards and the host's "Sign in to GitHub again" card still arrive where the sign-in lives; one with `signIn: "google"` lands here and opens Google's page.
Like Projects, the tab does not show on a paired view.

## How the first mate reaches them

The first mate's context block carries one `integrations` line naming each connected integration and who it is signed in as, so an integration nobody uses costs one name.
`integrations` lists them, or one's actions with their effect, rule and input schema; `use_integration` runs one action (`src/core/pi/integrationTools.ts`).
Their words never change with what is connected, so a seat never starts over when an integration comes or goes.
It changes them through `app_change` in the area `integrations`, the same channels the tab writes: `integration-add` hands the captain to the tab for GitHub or Google (a sign-in is the captain's to make), refusing a kind this build cannot sign in to, `integration-add-mcp` adds an MCP server the captain named, `integration-remove` needs the captain's own words, and `integration-settings`, `integration-check` and `integration-add-mcp` are asked actions.

## How a crewmate reaches them

A crewmate runs `infinitary-integrations-axi` on its task channel (`docs/axi-commands.md`, "The integrations command"): discover, then call.
Its instructions carry one line for it (`CREWMATE_INTEGRATIONS_LINE`, `src/core/integrations/commandWords.ts`).
A task on this Mac is granted the command whenever the host has a command process.

## On a computer that runs work

A crewmate on a computer that runs work (`docs/helper.md`) runs the same command in its shell there, and reaches this Mac's integrations: the integrations and their sign-ins stay here, and nothing of a sign-in goes to that computer.
That computer's task channel carries the command (`ComputerBrowsers`, `src/core/helper/browsers.ts`), and each list, show and call is asked of this Mac (`inf:work:integrations` for list and show, `inf:work:use-integration` for a call; `SessionHost`, `src/core/helper/sessionHost.ts`).
This Mac answers it through `IntegrationsService.forTask` under the same rules as for a task here, so a read runs here through this Mac's sign-in and a change is kept on the task here as the captain's ask.
A call is a change in the conversation's ledger (`docs/helper.md`, "Holding a conversation"): one asked again after a drop is answered from what this Mac kept, and one this Mac began without a kept answer is never run again.
A command waiting on this Mac answers before its command process is stopped, and a call not yet sent when it stops is never sent later.

The home grants the command, and its one line in the crewmate's instructions, only to a computer that has a task channel (its roster's `browsers`) and lists the `integrations-there` contract change (`PlacedSessions.takesIntegrations`; `docs/contract.md`, "Changes by name").
A computer without the change, or without a task channel, gives its crewmates neither the command nor the line.

## Tests

`src/core/integrations/service.test.ts` holds the view drawn from the github.com sign-in, settings that hold across a restart, a paused integration refusing, and removal signing out.
`src/core/forge/providers/github/gateway.test.ts` holds GitHub through the integration against a stand-in GitHub: a crewmate's read runs, its write is kept as an ask even on its own project and sent by the captain's click, the first mate's read runs and its write is refused before any request, and an action turned off reaches nothing.
`src/core/axi/channel.test.ts` runs the command through the real launcher and channel.
`src/core/integrations/secrets.test.ts` holds the keys against a stand-in API that sends back the header it received: the file and folder modes, a view and discovery that never carry a value, a call refused while its key is missing, a key applied to one request and replaced in the answer, a program's variables, and a change kept as an ask that runs once on the click and not at all once its action is off.
`src/core/placed/placedSessions.test.ts`, "the integrations command on a computer that runs work", runs it from a real Pi crewmate's shell on a joined computer through that computer's launcher, command process and task channel and across the real connection to this Mac's integrations over a stand-in GitHub: list and show answer what is connected here, a read runs through this Mac's sign-in, a write is kept here as an ask and sends nothing, the instructions there carry the line, no file there holds the token, and a computer that does not list the change gets neither the command nor the line.
`src/core/integrations/providers/mcp/mcpIntegration.test.ts` adds a stand-in notes server (`tests/helpers/mcpStandIn.ts`) in both protocol eras, over stdio and over HTTP: its own list becomes the row, reads run, a change is kept as an ask that runs once on the click, a change the server took before its connection dropped is unknown and never run again, a changed resource is told, and an address leaving its class or redirecting is refused.
`tests/e2e/integrations-mcp.spec.ts` adds the stand-in from Settings by keyboard and has a crewmate call one of its reads from its shell.
`src/core/integrations/providers/google/googleIntegration.test.ts` signs in to a stand-in Google (`tests/helpers/googleStandIn.ts`, answering in Google's documented shapes) through the loopback with PKCE and every permission: a declined or partial consent keeps nothing, a sign-in while an MCP server is named Google is refused before the browser opens, a cancel ends the wait, reads run, an HTML-only message full of markup that never closes reads as its words, a label, a draft and a send are kept as asks that run once on the click, a send Gmail took before the connection dropped or it failed is unknown and never sent again, the history cursor tells what arrived and resyncs on a 404 or another mailbox, a 429's Retry-After holds every request, the access renews before it runs out and after a refusal, Google refusing the lasting key asks for a new sign-in, removal revokes, and no key reaches the view, discovery or the facts file.
`tests/e2e/integrations-google.spec.ts` signs in from the Google chip by keys against the stand-in and has a message arriving fire a rule to the first mate.
`src/core/orchestrator/schedulerEvents.test.ts` fires Automation from the stand-in's events, and `tests/e2e/automation-events.spec.ts` saves an event rule by keys and reads the one first mate turn three items make.
