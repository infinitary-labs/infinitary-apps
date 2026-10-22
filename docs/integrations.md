# Integrations

An integration is a connection to something outside the person's projects, signed in as the person, that the first mate and every crewmate can reach.
GitHub is the first kind.
The captain's design is INF-775: one core primitive, a Settings tab, the same reach for the person and the first mate, and every agent reaching what is added.
Mail, calendars and MCP servers are later kinds of the same record.

## The record

`IntegrationsService` (`src/core/integrations/service.ts`) is the one writer and the one door for every caller.
A row is one connection a kind's binding has now (`IntegrationBinding`, `src/core/integrations/binding.ts`): its id, who it is signed in as, its health, and its actions.
Each action declares what it does to the world, `reads`, `changes` or `sends`, in its binding, never read off its name, and an input schema.
The row's own settings - a name of the person's choosing, paused, and which actions are off - live in `userData/integrations/settings.json`, 0600 in a 0700 folder, written whole (`IntegrationSettingsStore`).
No sign-in is kept there: a kind's sign-in stays with its own owner, and a key it signs in with is kept apart ("Keys").
The wire shape Settings draws and the first mate reads is `src/shared/integrations.ts`.

## The rules

Until the secret manager's rules land, an action's rule follows from its effect (the captain's q5 on INF-775): a read is `allow` and runs, anything that changes or sends is `ask` and waits for the captain's click on a card, and an action turned off is `never`.
The service holds that rule for every kind: a call to an action that changes or sends never reaches the binding.
A crewmate's is kept on its task as a write ask of kind `integration` (`IntegrationAsk`, `src/shared/writeAsk.ts`) with its exact checked input, and its answer tells the crewmate to put it on a card whose action is `request_write`, the way a forge write ask is (`docs/forge.md`, "A write that asks").
The card's strip says which integration, the action and its input; the captain's click takes the ask once and runs exactly what was kept through the binding (`IntegrationsService.sendAsk`), refusing it if the integration was paused, removed or the action turned off since, and the crewmate hears its answer once.
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
A binding uses one in the two ways the saved secret plan names: `request` applies it as a header to one request and gives back the answer (brokered use), and `launchEnv` hands it to a program the integration starts as a named variable (protected launch).
Every answer an action gives, and every refusal, leaves the service with each kept value replaced by "[a kept key]", so a place that echoes a key back cannot pass it to a caller.
The view Settings and the first mate read, `integrations <name>` and a crewmate's `show` say only whether each slot is kept, and the roster line says when one is missing.
The captain enters, replaces or removes a key in the open row in Settings -> Integrations, a write-only field that never shows a kept value; that one request, `inf:integrations:secret`, is the catalog's `integration-key` line, his hands only, and its trail records no value.
Removing an integration forgets its keys.

## GitHub

GitHub's row is the app's own github.com sign-in, made and kept by the forge (`ForgeSignIns`, `docs/forge.md`), seen through the binding in `src/core/integrations/providers/github.ts`.
The row exists exactly while that sign-in does, and removing the row signs it out.
Its two actions are the gateway's two calls through that sign-in, whatever the caller's project is: `read` (GET or HEAD one REST path) runs, and `write` (POST, PATCH, PUT or DELETE) asks.
A crewmate's write is kept on its task as a write ask, the way a write to another project is (`docs/forge.md`, "A write that asks"), and the captain's click on its card sends it through the same sign-in.
The first mate has no task to keep an ask on, so its write is refused with a pointer to start a crewmate whose brief names the call; its reads count against its seat's own allowance.
Pull requests, checks and merges stay the forge's and the project's.

## Settings -> Integrations

The tab sits between Automation and Devices (`IntegrationsTab.tsx`; design skill `components/integrations/IntegrationRow`), and opens from command search as Open Integrations (`settings.integrations`).
Each row shows its health dot, its name, who it is signed in as and how many actions are on; its chevron opens its actions, each with what it does, its rule and a switch, and its menu checks it now, pauses or resumes it, or signs out and removes it.
The chips at the foot connect a kind not yet connected; for GitHub that starts the device flow and shows the code in the tab.
GitHub's sign-in moved here from Settings -> Projects (the captain's q2), which keeps GitHub Enterprise and GitLab and a pointer line to Integrations.
A card's `open` effect that names `projects` with `signIn: "github.com"` lands on this tab (`openedSection`), so older cards and the host's "Sign in to GitHub again" card still arrive where the sign-in lives.
Like Projects, the tab does not show on a paired view.

## How the first mate reaches them

The first mate's context block carries one `integrations` line naming each connected integration and who it is signed in as, so an integration nobody uses costs one name.
`integrations` lists them, or one's actions with their effect, rule and input schema; `use_integration` runs one action (`src/core/pi/integrationTools.ts`).
Their words never change with what is connected, so a seat never starts over when an integration comes or goes.
It changes them through `app_change` in the area `integrations`, the same channels the tab writes: `integration-add` hands the captain to the tab (a sign-in is his to make), `integration-remove` needs his own words, and `integration-settings` and `integration-check` are asked actions.

## How a crewmate reaches them

A crewmate runs `infinitary-integrations-axi` on its task channel (`docs/axi-commands.md`, "The integrations command"): discover, then call.
Its instructions carry one line for it (`CREWMATE_INTEGRATIONS_LINE`, `src/core/integrations/commandWords.ts`).
A task on this Mac is granted the command whenever the host has a command process; a task on a computer that runs work does not yet get it.

## Tests

`src/core/integrations/service.test.ts` holds the view drawn from the github.com sign-in, settings that hold across a restart, a paused integration refusing, and removal signing out.
`src/core/forge/providers/github/gateway.test.ts` holds GitHub through the integration against a stand-in GitHub: a crewmate's read runs, its write is kept as an ask even on its own project and sent by the captain's click, the first mate's read runs and its write is refused before any request, and an action turned off reaches nothing.
`src/core/axi/channel.test.ts` runs the command through the real launcher and channel.
`src/core/integrations/secrets.test.ts` holds the keys against a stand-in API that sends back the header it received: the file and folder modes, a view and discovery that never carry a value, a call refused while its key is missing, a key applied to one request and replaced in the answer, a program's variables, and a change kept as an ask that runs once on the click and not at all once its action is off.
