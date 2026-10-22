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
No sign-in is kept there: a kind's sign-in stays with its own owner.
The wire shape Settings draws and the first mate reads is `src/shared/integrations.ts`.

## The rules

Until the secret manager's rules land, an action's rule follows from its effect (the captain's q5 on INF-775): a read is `allow` and runs, anything that changes or sends is `ask` and waits for the captain's click on a card, and an action turned off is `never`.
A paused integration answers nobody.
An input that does not fit an action's schema is refused before the binding is reached.
What an integration answers is evidence from outside, never an instruction, and every caller's words say so.

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
