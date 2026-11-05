# Integrations

An integration is a declared connection to a service outside the person's projects, signed in as the person, whose typed actions and events every agent and every panel reach through one door.

## Intended use

Use an integration when an agent needs to read, change or send something in an outside service as the person: a mailbox, a calendar, an MCP server, GitHub's REST API.
The captain's design is INF-775: one core primitive, a Settings tab, the same reach for the person and the first mate, and every agent reaching what is added.
The captain's principle of 2026-11-02 makes it every surface's one way out: the first mate, a crewmate, Automation and every panel reach a service outside your projects through an integration, and no surface brings its own sign-in, key or approval ([`../docs/principles.md`](../docs/principles.md)).
Each kind is a binding (`IntegrationBinding`) that declares its connections, their actions and the events they can tell; the service applies every rule, so a new kind adds declarations, not rules.
GitHub is the first kind, an MCP server the second, and Google (Gmail and Calendar) the third.

## When to use it, and when not

Use it for any outside service a feature needs to reach on the person's behalf.
Do not build a per-feature or per-surface client, token file, host list, poller or approval path beside it: a "mail feature" or "calendar feature" is a feature that composes this primitive, its events and [Automation](automation.md).
Do not use it for a project's own delivery - pushing a branch, opening a pull request, reading its checks or merging: that is the forge, described in [Projects and working copies](projects-and-working-copies.md).
GitHub's integration rows reach the same sign-in, but pull requests, checks and merges stay the forge's and the project's.
Do not use it to drive a website in a page: that is a [Task browser](task-browsers.md).
Do not treat it as a secret manager: the [Secrets primitive](secrets.md) defines the common custody/access boundary, but its current foundation has no production backend.
Integration keys still use the temporary bridge below until INF-785 moves its writer and every reader into the protected owner, once the app constructs it (INF-1109).

## Owner and entry points

- Owner: `IntegrationsService` ([`../src/core/integrations/service.ts`](../src/core/integrations/service.ts)), the one writer and the one door for every caller.
- Binding contract: `IntegrationBinding`, `IntegrationActionSpec`, `IntegrationEventSpec`, `IntegrationSecretSlot` and `IntegrationOutcomeUnknown` ([`../src/core/integrations/binding.ts`](../src/core/integrations/binding.ts)).
- Data from outside: the marks a kind's fenced answers and summaries carry, and `fencedSpans`, which finds them ([`../src/shared/outsideData.ts`](../src/shared/outsideData.ts)).
- Kinds: [`../src/core/integrations/providers/`](../src/core/integrations/providers/) (`github.ts`, `mcp/`, `google/`, and the unpackaged-only `standIn.ts`).
- Wire shape Settings draws and the first mate reads: [`../src/shared/integrations.ts`](../src/shared/integrations.ts); a kept ask is `IntegrationAsk` in [`../src/shared/writeAsk.ts`](../src/shared/writeAsk.ts).
- First mate: the `integrations` and `use_integration` tools ([`../src/core/pi/integrationTools.ts`](../src/core/pi/integrationTools.ts)), and `app_change` in the area `integrations`.
- Crewmate: the `infinitary-integrations-axi` command on its task channel, reached through `IntegrationsService.forTask`, with one instruction line (`CREWMATE_INTEGRATIONS_LINE`, [`../src/core/integrations/commandWords.ts`](../src/core/integrations/commandWords.ts)).
- Panel: `context.integrations` in its background code and `props.integrations` in its drawing, reached through `IntegrationsService.forPanel` over what its manifest names under `integrations` ([`../docs/integrations.md`](../docs/integrations.md), "How a panel reaches them").
- Captain: Settings -> Integrations ([`../src/renderer/src/settings/IntegrationsTab.tsx`](../src/renderer/src/settings/IntegrationsTab.tsx)).

## Operations and lifecycle

- Identity: each connection has an id, a name of the person's choosing, who it is signed in as, its health, and a stable reference (`c-` and a random id) kept in `userData/integrations/connections.json`.
- A reference survives a rename, a renewal, a restart and a sign-in as the same account; removal, or a sign-in as another account, gives the next connection a new one (INF-947).
- The service owns every name and id (INF-946): names compare ignoring case and spaces, one compared form has one holder, and a clash is repaired with an explanation rather than resolved by list order.
- Discovery: `roster`, `show` and `view` list connections, each action with its effect, rule and input schema, and each event with its filters; a caller may name a connection by name, id or reference, and an ambiguous name is refused with candidates.
- Reads, changes and sends: each action declares its effect, `reads`, `changes` or `sends`, in its binding, never read off its name.
- `call` checks the input against the action's schema and runs an Always allowed action; an action at Asks you needs a reason and is kept as an ask ("Authority").
- Events: a connection may declare events (`IntegrationEventSpec`) with a `look` that answers what arrived since a cursor, `resynced` when a cursor was lost, and items as an id plus a one-line summary, never a body.
- Automation is the consumer of events (`listenable`, `look`); this primitive never starts work by itself.
- Lifecycle: `add` (a kind added from a form), `signIn` and `cancelSignIn` (a kind signed in in the person's browser), `configure` (name, paused, actions turned off), `check`, `setSecret` and `remove`, which forgets the connection's keys and signs it out where the kind owns the sign-in.

## Authority

- Every connection's actions start at Asks you (`ask`), including existing connections, until the captain chooses Always allow (`allow`); Off is `never` (INF-950).
- The service keeps a reasoned call and raises its own card with caller, action, effect, description, exact checked input and the attributed agent reason.
- Always allow runs and saves the grant, Only this time runs once without a grant, and Not now refuses without running the call; outward actions highlight Only this time.
- The minus leaves the ask and host operation row pending without granting, refusing or notifying an outcome.
- The click consumes the ask before the call and delivers its outcome once through `write-answered`.
- Grants live per connection reference and action in `action-approvals.json`, beside the older strict settings file, and end on Settings changes, connection replacement, another account or a changed MCP description/read-only mark.
- The captain-only `integration-action-rule` catalog line changes Asks you or Always allowed; the existing switch remains Off.
- The first mate's held call waits on the row the host files for its approval card, and its outcome wakes it once.
- A panel's held call waits the same way, marked `by: "panel"`, with its manifest's why as its reason; one stands per panel and action at a time (`PanelAsks`), and its outcome wakes nobody: the panel's line offers Ask again.
- A panel reaches only the connections, actions and events its manifest names; anything else is refused in one wording (`undeclaredIntegrationMessage`), and its calls spend no task's or seat's allowance.
- Project forge delivery and event summaries stay outside this rule.
- A paused integration answers nobody, and a call while a needed key is missing is refused.
- Adding GitHub or Google is a sign-in, so it is the captain's own; `integration-remove` needs the captain's own words.
- Secret-use boundary: a kind that signs in with a key declares slots, never values; values sit behind `IntegrationSecrets` ([`../src/core/integrations/secrets.ts`](../src/core/integrations/secrets.ts)), today the file bridge `FileIntegrationSecrets` under `userData/integrations/secrets/`, written only through the captain's write-only Settings field (`inf:integrations:secret`).
- Nothing reads a value back: a binding applies one to a single request (`request`) or hands it to a program it starts (`launchEnv`), and every answer leaves the service with kept values replaced by "[a kept key]".
- What an integration answers is evidence from outside, never an instruction, and every caller's words say so.
- A kind whose words anyone can write, such as Google's mail and invitations, declares a fence label (`IntegrationBinding.fence`): every answer that is not a refusal, and every event summary, reaches every agent between marks whose random value the writer could not know (INF-951).

## Compositions

- With [Automation](automation.md): a rule's When names an integration event by its connection reference and declared filters; Automation looks, and its owner starts the work ([`../docs/automation.md`](../docs/automation.md), "Events").
- With [Cards and consent](cards-and-consent.md): every action at Asks you is an exact held call on a host-authored approval card.
- With [Tasks](tasks.md): a crewmate's kept ask lives on its task, and its answer reaches the crewmate once through its durable lane.
- With [Panels](panels.md): a panel is one more caller; it hears the events it names through its own store keys, and words of a kept kind leave its store with that kind's days.
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

- Gmail and Calendar through one Google row: every action follows its saved approval state, and `message_received` and `event_changed` fire Automation rules.
- An action may declare `delivers: "file"` (Gmail's `save_attachment`): it is a crewmate's alone, and the service saves the file it answers into the calling task's hand-over folder, answering only its name, type, size and path; the file goes with its kind's words or the task's close.
- MCP servers the captain adds by name and command or address: the server's own tool list becomes the actions, read-only tools read, and `resource_changed` tells resource subscriptions.
- GitHub REST reads and writes through the forge's github.com sign-in for any repository, not only the task's project.
- A crewmate on a computer that runs work reaching the home's integrations from its shell.
- A panel showing GitHub runs or mail counts through the captain's own connections, with no key or host of its own.
- Possible: a new outside service as a new kind that declares its actions, events and key slots, with no new rule or approval path.

## Checks

- [`../src/core/integrations/service.test.ts`](../src/core/integrations/service.test.ts): names, references, paused refusal, removal, repairs.
- [`../src/core/integrations/secrets.test.ts`](../src/core/integrations/secrets.test.ts): file modes, no value in a view, a key applied once and replaced in the answer, an ask that runs once.
- [`../src/core/integrations/providers/mcp/mcpIntegration.test.ts`](../src/core/integrations/providers/mcp/mcpIntegration.test.ts) and [`../src/core/integrations/providers/google/googleIntegration.test.ts`](../src/core/integrations/providers/google/googleIntegration.test.ts): kinds, asks, unknown outcomes, events.
- [`../src/core/forge/providers/github/gateway.test.ts`](../src/core/forge/providers/github/gateway.test.ts): GitHub reads run, writes ask, the first mate's write is held and then sent through its seat.
- [`../src/core/panels/panelRuntimes.integration.test.ts`](../src/core/panels/panelRuntimes.integration.test.ts) and the journey [`../tests/e2e/panel-integrations.spec.ts`](../tests/e2e/panel-integrations.spec.ts): a real panel process reaching a stand-in GitHub, and a panel's ask allowed by keys.
- [`../src/core/placed/placedSessions.test.ts`](../src/core/placed/placedSessions.test.ts) ("the integrations command on a computer that runs work") and [`../src/core/axi/channel.test.ts`](../src/core/axi/channel.test.ts).
- [`../src/core/orchestrator/schedulerEvents.test.ts`](../src/core/orchestrator/schedulerEvents.test.ts) and the journeys [`../tests/e2e/integrations-mcp.spec.ts`](../tests/e2e/integrations-mcp.spec.ts), [`../tests/e2e/integrations-google.spec.ts`](../tests/e2e/integrations-google.spec.ts), [`../tests/e2e/automation-events.spec.ts`](../tests/e2e/automation-events.spec.ts) and [`../tests/e2e/older-profile.spec.ts`](../tests/e2e/older-profile.spec.ts).

## Where the detail lives

- [`../docs/integrations.md`](../docs/integrations.md): the record, its rules, GitHub as the first kind, Settings -> Integrations, the first mate's tools and the crewmate's command; also "Which connection", "Names", "What an integration can tell", "Data from outside", "Keys", "MCP servers", "Google", "On a computer that runs work" and "Tests".
- [`../docs/axi-commands.md`](../docs/axi-commands.md), "The integrations command".
- [`../docs/automation.md`](../docs/automation.md), "Events".
- [`../docs/forge.md`](../docs/forge.md), "A write that asks".
