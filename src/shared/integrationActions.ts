import { z } from "zod";
import type { ActionLine } from "./actions";
import { isServerIntegration, SERVER_INTEGRATION_KINDS } from "./forgeKinds";
import { FORGE_HOST_NAME } from "./forges";
import * as m from "./i18n/messages.generated.ts";
import {
  INBOX_WORDS,
  INTEGRATION_KIND_NAMES,
  INTEGRATIONS_SIGN_IN_HOST,
  type IntegrationKind,
  type IntegrationsView,
  integrationActionNameSchema,
  integrationIdSchema,
  integrationKindSchema,
  integrationMcpAddSchema,
  integrationSettingsPatchSchema,
} from "./integrations";

/**
 * The first mate's offer of an MCP server that asks for a sign-in: the
 * captain's click opens the MCP form filled in, and their Connect opens the
 * sign-in page, so the browser never opens from the first mate's turn.
 */
function mcpSignInOffer(v: Record<string, unknown>, view: IntegrationsView) {
  const server = integrationMcpAddSchema.parse({ name: v.name, runs: v.runs });
  if (v.host) throw new Error("An MCP server takes no host; its address is runs.");
  if (!/^https:\/\//i.test(server.runs))
    throw new Error(
      "Only an MCP server at an https address signs in; add a program through integration-add-mcp.",
    );
  if (view.integrations.some((row) => row.kind === "mcp" && row.name === server.name))
    throw new Error(`An MCP server named ${server.name} is already added; integrations lists it.`);
  if (!view.addable.some((entry) => entry.kind === "mcp"))
    throw new Error("MCP servers cannot be added in this version of the app.");
  const item = `mcp?${new URLSearchParams({ name: server.name, runs: server.runs })}`;
  return {
    cardId: "app-integration-add-mcp",
    title: m.integrationsMcpAdd({ name: server.name }),
    paragraphs: [m.integrationsMcpOfferBody({ name: server.name }), m.integrationsMcpOfferOpen()],
    label: m.integrationsMcpOfferButton(),
    decline: m.integrationsMcpOfferNotNow(),
    // An address too long for the arrival opens the form empty rather than cut.
    arrival: { section: "integrations", item: item.length <= 128 ? item : "mcp" },
  };
}

export function integrationsBrief(view: IntegrationsView): Record<string, unknown>[] {
  return view.integrations.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    account: row.account,
    health: row.health,
    paused: row.paused,
    actionsOff: row.actions.filter((action) => !action.enabled).map((action) => action.name),
  }));
}

/**
 * The integrations' lines of the action catalog (docs/integrations.md, "How
 * the first mate reaches them"): Settings -> Integrations and app_change
 * write through them alike. A sign-in is always the captain's hands;
 * removal forgets one only on the captain's own words.
 */
export const integrationLines = {
  "integration-add": {
    area: "integrations",
    tier: "hands",
    handover: "projects",
    change: null,
    current: "inf:integrations:list",
    channels: [
      "inf:integrations:sign-in",
      "inf:forges:sign-in",
      "inf:forges:sign-in-key",
      "inf:forges:sign-in-browser",
      "inf:forges:sign-in-cli",
    ],
    // A stand-in is a test run's own, never connected by hand. An MCP server
    // that asks for a sign-in comes here with its name and address: the card
    // opens the MCP form filled in, and the captain's Connect opens the page.
    value: z.strictObject({
      kind: integrationKindSchema.exclude(["stand-in"]),
      host: z.string().regex(FORGE_HOST_NAME).optional(),
      name: integrationMcpAddSchema.shape.name.optional(),
      runs: integrationMcpAddSchema.shape.runs.optional(),
    }),
    line: "Connect an integration (kind: github, gitlab, github-enterprise, google for Gmail and Calendar, inbox for the Infinitary command, or mcp with name and runs for an MCP server that asks for a sign-in; optional host for a server) when asked: app_change puts up the captain's card, and their click opens Settings → Integrations with the sign-in started, at the Infinitary command's switch, or at the MCP form filled in. A sign-in is always their hands.",
    alwaysTrail: true,
    offer: (v, current) => {
      const kind = v.kind as keyof typeof INTEGRATION_KIND_NAMES;
      const name = INTEGRATION_KIND_NAMES[kind];
      const view = current as IntegrationsView;
      if ((v.name !== undefined || v.runs !== undefined) && kind !== "mcp")
        throw new Error("A name and runs are used only for an MCP server.");
      if (kind === "mcp") return mcpSignInOffer(v, view);
      // The inbox signs in to nothing: its card opens its switch (INF-5348).
      if (kind === "inbox") {
        if (v.host) throw new Error(`${name} takes no host.`);
        if (view.integrations.some((row) => row.kind === "inbox" && !row.paused))
          throw new Error(`${INBOX_WORDS.title} is already on; integrations lists it.`);
        return {
          cardId: "app-integration-add-inbox",
          title: `Turn on the ${INBOX_WORDS.title}`,
          paragraphs: [INBOX_WORDS.intro, `Open Integrations and turn on ${INBOX_WORDS.title}.`],
          label: "Open Integrations",
          decline: "Not now",
          arrival: { section: "integrations", item: "inbox" },
        };
      }
      if (v.host && !isServerIntegration(kind))
        throw new Error(
          `A host is used only for ${SERVER_INTEGRATION_KINDS.map((server) => INTEGRATION_KIND_NAMES[server]).join(" or ")}.`,
        );
      if (
        !v.host &&
        !isServerIntegration(kind) &&
        view.integrations.some((row) => row.kind === kind)
      )
        throw new Error(`${name} is already connected; integrations lists it.`);
      if (!view.addable.some((entry) => entry.kind === kind))
        throw new Error(`${name} cannot be signed in to in this version of the app.`);
      return {
        cardId: `app-integration-add-${kind}`,
        title: `Connect ${name}`,
        paragraphs: [
          `Your first mate and your crew can then reach ${name} with your sign-in: reads run, and every change asks you on a card first.`,
          `Open Integrations to sign in to ${name}.`,
        ],
        label: "Open Integrations",
        decline: "Not now",
        // GitHub's sign-in is the forge's, by its host; any other kind signs in by its kind.
        arrival: {
          signIn: v.host
            ? `${kind}:${v.host}`
            : kind === "github"
              ? INTEGRATIONS_SIGN_IN_HOST
              : kind,
        },
      };
    },
    toRequest: () => [],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => {
      const name = v.kind ? INTEGRATION_KIND_NAMES[v.kind as IntegrationKind] : null;
      const host = typeof v.host === "string" ? v.host : null;
      if (name && host) return `${name} sign-in started for ${host}`;
      return `${name ?? host ?? "Integration"} sign-in started`;
    },
  },
  "integration-add-mcp": {
    fields: ["name", "runs"],
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:add",
    current: "inf:integrations:list",
    value: integrationMcpAddSchema,
    line: "Add an MCP server when asked: name is the captain's word for it, runs is what it runs as they gave it - a program and its arguments (npx -y @scope/server), or its https address. The app connects, keeps the server's tools as actions (each asks them until they choose Always allow) and answers the row; a server that cannot connect is refused with why. A server that asks for a sign-in is refused saying so: offer it through integration-add with kind mcp and the same name and runs, which hands the captain the form. Never put a key or token in runs.",
    toRequest: (v) => [v],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Added MCP server ${v.name}`,
  },
  "integration-remove": {
    area: "integrations",
    tier: "own-words",
    change: "inf:integrations:remove",
    current: "inf:integrations:list",
    value: z.strictObject({ id: integrationIdSchema }),
    line: "Remove an integration and forget its sign-in only on the captain's typed words. For GitHub it signs the app out of GitHub, so private clones and pull requests stop until they sign in again; an MCP server's program stops and its row goes.",
    toRequest: (v) => [v.id],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Removed integration ${v.id}`,
  },
  "delete-outside": {
    area: "general",
    tier: "own-words",
    change: "inf:retention:delete-outside",
    current: "inf:retention:scope",
    value: z.strictObject({}),
    line: "Delete the Gmail and Calendar content saved in every conversation on this computer only on the captain's typed words: a note takes its place and every other word stays, and a conversation still working is cleaned once it pauses. It also goes on its own once past its days.",
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (c) => ({ kept: (c as { kept?: unknown }).kept ?? [] }),
    done: () => "Deleted Gmail and Calendar content",
  },
  "integration-settings": {
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:configure",
    current: "inf:integrations:list",
    value: z.strictObject({ id: integrationIdSchema, changes: integrationSettingsPatchSchema }),
    line: "Change an integration when asked: rename it (name; null restores its kind's name), pause or resume it (paused), or turn actions on or off by name (actions: { read: false }). A paused integration and an action turned off answer nobody.",
    toRequest: (v) => [v.id, v.changes],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Changed integration ${v.id}`,
  },
  "integration-action-rule": {
    area: "integrations",
    tier: "yours",
    change: "inf:integrations:rule",
    current: "inf:integrations:list",
    value: z.strictObject({
      id: integrationIdSchema,
      action: integrationActionNameSchema,
      allowed: z.boolean(),
    }),
    line: "Only the captain changes action allowances, in Settings or on approval cards.",
    toRequest: (v) => [v.id, v.action, v.allowed],
    // Never what an MCP server runs or the inbox's door: Settings alone shows them (INF-5339).
    readValue: (c) => ({
      integrations: (c as IntegrationsView).integrations.map((row) => ({
        id: row.id,
        name: row.name,
        rules: row.actions.map(({ name, rule }) => ({ name, rule })),
      })),
    }),
    done: (v) => `Changed approval for ${v.id}'s ${v.action}`,
  },
} as const satisfies Record<string, ActionLine>;
