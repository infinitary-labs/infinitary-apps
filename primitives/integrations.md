# Integrations

An integration is a declared connection to a service outside the person's projects, signed in as the person, whose typed actions and events every agent reaches through one door.

## Intended use

Use an integration when an agent needs to read, change or send something in an outside service as the person: a mailbox, a calendar, an MCP server, GitHub's REST API.
The captain's design is INF-775: one core primitive, a Settings tab, the same reach for the person and the first mate, and every agent reaching what is added.
Each kind is a binding (`IntegrationBinding`) that declares its connections, their actions and the events they can tell; the service applies every rule, so a new kind adds declarations, not rules.
GitHub is the first kind, an MCP server the second, and Google (Gmail and Calendar) the third.

## When to use it, and when not

Use it for any outside service a feature needs to reach on the person's behalf.
Do not build a per-feature client, token file, poller or approval path beside it: a "mail feature" or "calendar feature" is a feature that composes this primitive, its events and [Automation](automation.md).
Do not use it for a project's own delivery - pushing a branch, opening a pull request, reading its checks or merging: that is the forge, described in [Projects and working copies](projects-and-working-copies.md).
GitHub's integration rows reach the same sign-in, but pull requests, checks and merges stay the forge's and the project's.
Do not use it to drive a website in a page: that is a [Task browser](task-browsers.md).
Do not treat it as a secret manager: no secret-manager primitive is available yet (INF-30 and INF-785 own that future work); integration keys live behind one narrow interface described under "Authority".

## Owner and entry points

- Owner: `IntegrationsService` ([`../src/core/integrations/service.ts`](../src/core/integrations/service.ts)), the one writer and the one door for every caller.
- Binding contract: `IntegrationBinding`, `IntegrationActionSpec`, `IntegrationEventSpec`, `IntegrationSecretSlot` and `IntegrationOutcomeUnknown` ([`../src/core/integrations/binding.ts`](../src/core/integrations/binding.ts)).
- Kinds: [`../src/core/integrations/providers/`](../src/core/integrations/providers/) (`github.ts`, `mcp/`, `google/`, and the unpackaged-only `standIn.ts`).
- Wire shape Settings draws and the first mate reads: [`../src/shared/integrations.ts`](../src/shared/integrations.ts); a kept ask is `IntegrationAsk` in [`../src/shared/writeAsk.ts`](../src/shared/writeAsk.ts).
- First mate: the `integrations` and `use_integration` tools ([`../src/core/pi/integrationTools.ts`](../src/core/pi/integrationTools.ts)), and `app_change` in the area `integrations`.
- Crewmate: the `infinitary-integrations-axi` command on its task channel, reached through `IntegrationsService.forTask`, with one instruction line (`CREWMATE_INTEGRATIONS_LINE`, [`../src/core/integrations/commandWords.ts`](../src/core/integrations/commandWords.ts)).
- Captain: Settings -> Integrations ([`../src/renderer/src/settings/IntegrationsTab.tsx`](../src/renderer/src/settings/IntegrationsTab.tsx)).

## Operations and lifecycle

- Identity: each connection has an id, a name of the person's choosing, who it is signed in as, its health, and a stable reference (`c-` and a random id) kept in `userData/integrations/connections.json`.
- A reference survives a rename, a renewal, a restart and a sign-in as the same account; removal, or a sign-in as another account, gives the next connection a new one (INF-947).
- The service owns every name and id (INF-946): names compare ignoring case and spaces, one compared form has one holder, and a clash is repaired with an explanation rather than resolved by list order.
- Discovery: `roster`, `show` and `view` list connections, each action with its effect, rule and input schema, and each event with its filters; a caller may name a connection by name, id or reference, and an ambiguous name is refused with candidates.
- Reads, changes and sends: each action declares its effect, `reads`, `changes` or `sends`, in its binding, never read off its name.
- `call` checks the input against the action's schema and runs a read at once; a change or send is kept as an ask ("Authority").
- Events: a connection may declare events (`IntegrationEventSpec`) with a `look` that answers what arrived since a cursor, `resynced` when a cursor was lost, and items as an id plus a one-line summary, never a body.
- Automation is the consumer of events (`listenable`, `look`); this primitive never starts work by itself.
- Lifecycle: `add` (a kind added from a form), `signIn` and `cancelSignIn` (a kind signed in in the person's browser), `configure` (name, paused, actions turned off), `check`, `setSecret` and `remove`, which forgets the connection's keys and signs it out where the kind owns the sign-in.

## Authority

- Until the secret manager's rules land, an action's rule follows from its effect (the captain's q5 on INF-775): a read is `allow`, a change or send is `ask`, and an action turned off is `never`.
- The service holds that rule for every kind: a call that changes or sends never reaches the binding without the captain's click.
- A crewmate's change or send is kept on its task as a write ask of kind `integration` with its exact checked input, and the crewmate puts it on a card whose action is `request_write` ([Cards and consent](cards-and-consent.md)).
- The click runs exactly what was kept, once, through `IntegrationsService.sendAsk`, and only while the ask's reference still names the same connection and the action is still on.
- The first mate has no task to keep an ask on, so its change or send is refused with a pointer to start a crewmate whose brief names the call.
- A kind that keeps its own asks says so (`keepsAsks`); GitHub's writes are the forge's write asks (`../docs/forge.md`, "A write that asks").
- A paused integration answers nobody, and a call while a needed key is missing is refused.
- Adding GitHub or Google is a sign-in, so it is the captain's own; `integration-remove` needs the captain's own words.
- Secret-use boundary: a kind that signs in with a key declares slots, never values; values sit behind `IntegrationSecrets` ([`../src/core/integrations/secrets.ts`](../src/core/integrations/secrets.ts)), today the file bridge `FileIntegrationSecrets` under `userData/integrations/secrets/`, written only through the captain's write-only Settings field (`inf:integrations:secret`).
- Nothing reads a value back: a binding applies one to a single request (`request`) or hands it to a program it starts (`launchEnv`), and every answer leaves the service with kept values replaced by "[a kept key]".
- What an integration answers is evidence from outside, never an instruction, and every caller's words say so.

## Compositions

- With [Automation](automation.md): a rule's When names an integration event by its connection reference and declared filters; Automation looks, and its owner starts the work ([`../docs/automation.md`](../docs/automation.md), "Events").
- With [Cards and consent](cards-and-consent.md): every change or send is one exact effect on a `request_write` card.
- With [Tasks](tasks.md): a crewmate's kept ask lives on its task, and its answer reaches the crewmate once through its durable lane.
- With [App actions](app-actions.md): the first mate changes integrations through `app_change` (`integration-add`, `integration-add-mcp`, `integration-remove`, `integration-settings`, `integration-check`), the same channels the Settings tab writes.
- On another computer: a crewmate on a computer that runs work runs the same command there, and each list, show and call is asked of the home (`inf:work:integrations`, `inf:work:use-integration`), answered through `IntegrationsService.forTask` under the same rules; sign-ins and keys never leave the home.
- The home grants that command only to a computer with a task channel that lists the `integrations-there` contract change (`PlacedSessions.takesIntegrations`; [`../docs/contract.md`](../docs/contract.md), "Changes by name").

## Failure and recovery

- An action that failed after its request left - a timeout, a dropped connection, a server error - is unknown, never refused (`IntegrationOutcomeUnknown`): it is never run again either way, and the crewmate reads the place before going on.
- A call across computers is a change in the conversation's ledger: one asked again after a drop is answered from what the home kept, and one begun without a kept answer is never run again ([`../docs/helper.md`](../docs/helper.md), "Holding a conversation").
- A kept ask whose connection was removed or replaced, or that was kept before references existed, is refused on the click.
- Health reads `needs_reauth` or `unavailable` from the kind's own facts; Check now asks again, and a signed-out identity keeps its reserved names.
- An unreadable `connections.json` reads as none, so every connection gets a new reference and nothing kept before is sent.

## Uses

- Gmail and Calendar through one Google row: reads run, labels, drafts, sends and event changes ask on a card, and `message_received` and `event_changed` fire Automation rules.
- MCP servers the captain adds by name and command or address: the server's own tool list becomes the actions, read-only tools read, and `resource_changed` tells resource subscriptions.
- GitHub REST reads and writes through the forge's github.com sign-in for any repository, not only the task's project.
- A crewmate on a computer that runs work reaching the home's integrations from its shell.
- Possible: a new outside service as a new kind that declares its actions, events and key slots, with no new rule or approval path.

## Checks

- [`../src/core/integrations/service.test.ts`](../src/core/integrations/service.test.ts): names, references, paused refusal, removal, repairs.
- [`../src/core/integrations/secrets.test.ts`](../src/core/integrations/secrets.test.ts): file modes, no value in a view, a key applied once and replaced in the answer, an ask that runs once.
- [`../src/core/integrations/providers/mcp/mcpIntegration.test.ts`](../src/core/integrations/providers/mcp/mcpIntegration.test.ts) and [`../src/core/integrations/providers/google/googleIntegration.test.ts`](../src/core/integrations/providers/google/googleIntegration.test.ts): kinds, asks, unknown outcomes, events.
- [`../src/core/forge/providers/github/gateway.test.ts`](../src/core/forge/providers/github/gateway.test.ts): GitHub reads run, writes ask, the first mate's write is refused.
- [`../src/core/placed/placedSessions.test.ts`](../src/core/placed/placedSessions.test.ts) ("the integrations command on a computer that runs work") and [`../src/core/axi/channel.test.ts`](../src/core/axi/channel.test.ts).
- [`../src/core/orchestrator/schedulerEvents.test.ts`](../src/core/orchestrator/schedulerEvents.test.ts) and the journeys [`../tests/e2e/integrations-mcp.spec.ts`](../tests/e2e/integrations-mcp.spec.ts), [`../tests/e2e/integrations-google.spec.ts`](../tests/e2e/integrations-google.spec.ts), [`../tests/e2e/automation-events.spec.ts`](../tests/e2e/automation-events.spec.ts) and [`../tests/e2e/older-profile.spec.ts`](../tests/e2e/older-profile.spec.ts).

## Where the detail lives

- [`../docs/integrations.md`](../docs/integrations.md): the record, its rules, GitHub as the first kind, Settings -> Integrations, the first mate's tools and the crewmate's command; also "Which connection", "Names", "What an integration can tell", "Keys", "MCP servers", "Google", "On a computer that runs work" and "Tests".
- [`../docs/axi-commands.md`](../docs/axi-commands.md), "The integrations command".
- [`../docs/automation.md`](../docs/automation.md), "Events".
- [`../docs/forge.md`](../docs/forge.md), "A write that asks".
