import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  type CallToolResult,
  Client,
  type McpSubscription,
  type ReadResourceResult,
  type Resource,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  INTEGRATION_ACTIONS_MAX,
  INTEGRATION_KIND_NAMES,
  integrationMcpAddSchema,
} from "@shared/integrations";
import { z } from "zod";
import { findOnPath, isExecutable } from "../../../userBin";
import {
  type IntegrationActionSpec,
  type IntegrationAnswer,
  type IntegrationBinding,
  type IntegrationConnection,
  type IntegrationEventSpec,
  type IntegrationLook,
  IntegrationOutcomeUnknown,
} from "../../binding";
import {
  guardedMcpFetch,
  holdMcpDestination,
  McpAddressError,
  type McpResolver,
  readMcpDestination,
} from "./guardedFetch";
import { McpRunsError, parseRuns } from "./runs";
import {
  type McpSavedResource,
  type McpSavedServer,
  type McpSavedTool,
  McpServerStore,
} from "./store";

/**
 * MCP servers as integrations (docs/integrations.md, "MCP servers"; INF-775
 * piece 2): each server the person adds is one row, reached over the MCP
 * client of the SDK's second version, which speaks both the 2025 protocol
 * and the 2026-07-28 one. A server runs as a program on this computer - a
 * child with the host's environment, below the UI - or answers at an
 * address, reached through the guarded fetch.
 *
 * The server's own list is trusted (the captain's q7): every tool becomes
 * an action, one the server marks read-only `reads` and every other
 * `changes`, and the row shows the list after it connects. A read runs; a
 * change asks the captain on a card, which the service keeps as an ask and
 * runs here once on his click. A server that tells when its resources change
 * has one event, `resource_changed`, which a listening rule looks for.
 *
 * A program starts on its first call, or when a rule listens, and stops
 * when nobody has used it for a while; a server nobody uses is a row, not
 * a process.
 */

export type McpIntegrationOptions = {
  /** The integrations' folder (`userData/integrations/`); the servers live in its `mcp.json`. */
  root: string;
  /** Every program's environment (`hostEnv()`). */
  env: () => NodeJS.ProcessEnv;
  /** The command to spawn so a program runs below the UI (`atUtilityQos`). */
  belowUi: (file: string, args: readonly string[]) => { file: string; args: string[] };
  /** The folder a program starts in. */
  cwd: () => string;
  /** The app's version, which the client gives as its own. */
  version: string;
  /** Something a row shows changed: a server's tools, or its health. */
  changed: () => void;
  /** DNS for an address's checks; tests answer it themselves. */
  resolve?: McpResolver;
  /** How long a program may sit unused before it is stopped. */
  idleMs?: number;
};

/** The one event an MCP server can tell. */
export const MCP_RESOURCE_EVENT = "resource_changed";
/** The action that reads a resource, beside the server's own tools. */
export const MCP_READ_RESOURCE = "read_resource";

/** Five minutes unused stops a program; a rule that listens looks every minute, so it stays. */
const IDLE_MS = 5 * 60_000;
/** Changes kept for looks; a look whose cursor is older starts again from now. */
const CHANGES_KEPT = 500;
/** Resources the read action's description names; the event's items name every one. */
const RESOURCES_NAMED = 20;
/** Lines of a failed program's own words shown when it stops before answering. */
const STDERR_LINES = 4;

/** A server's program or connection while it runs. */
type Link = {
  client: Client;
  /** A new one each time the server starts, or its change stream drops: a cursor from another missed changes. */
  generation: string;
  seq: number;
  changes: { seq: number; uri: string }[];
  /** The resources it was asked to tell about, for this generation. */
  listening: boolean;
  subscription?: McpSubscription;
  idle?: ReturnType<typeof setTimeout>;
  /** The end of what the program wrote to stderr, for the words when it fails to start. */
  stderr: string;
  closed: boolean;
};

/** A server could not be reached or started; the message says why in the person's words. */
export class McpConnectError extends Error {}

export function mcpIntegration(options: McpIntegrationOptions): IntegrationBinding {
  const store = new McpServerStore(options.root);
  let servers = store.read();
  const links = new Map<string, Promise<Link>>();
  const idleMs = options.idleMs ?? IDLE_MS;

  const save = (next: McpSavedServer[]) => {
    servers = next;
    store.write(servers);
  };
  const serverOf = (id: string): McpSavedServer => {
    const server = servers.find((entry) => entry.id === id);
    if (!server) throw new McpConnectError(`No MCP server ${id}.`);
    return server;
  };
  const update = (id: string, patch: Partial<McpSavedServer>) => {
    const before = serverOf(id);
    const after = { ...before, ...patch };
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    save(servers.map((entry) => (entry.id === id ? after : entry)));
    options.changed();
  };

  const transportOf = (server: Pick<McpSavedServer, "runs" | "network">, link: Link): Transport => {
    const runs = parseRuns(server.runs);
    if (runs.kind === "address") {
      const destination = holdMcpDestination(runs.url, server.network ?? "public");
      return new StreamableHTTPClientTransport(new URL(destination.baseUrl), {
        fetch: guardedMcpFetch(destination, options.resolve),
      });
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env()))
      if (value !== undefined) env[name] = value;
    const childEnv = { ...env, ...runs.env };
    // Found here, before it starts below the window: a program that is not
    // there would otherwise fail inside the wrapper that lowers its priority,
    // and the words would name the wrapper.
    const program = runs.command.includes("/")
      ? resolvePath(options.cwd(), runs.command)
      : findOnPath(runs.command, childEnv);
    if (!program || !isExecutable(program))
      throw new McpConnectError(`${runs.command} could not be found on this computer.`);
    const spawn = options.belowUi(program, runs.args);
    const transport = new StdioClientTransport({
      command: spawn.file,
      args: spawn.args,
      env: childEnv,
      cwd: options.cwd(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      link.stderr = `${link.stderr}${chunk.toString("utf8")}`.slice(-2048);
    });
    return transport;
  };

  /** Start a server and connect to it, or throw words saying why it could not. */
  const connect = async (
    server: Pick<McpSavedServer, "id" | "runs" | "network">,
  ): Promise<Link> => {
    const client = new Client(
      { name: "infinitary", version: options.version },
      { versionNegotiation: { mode: "auto" } },
    );
    const link: Link = {
      client,
      generation: randomUUID().slice(0, 8),
      seq: 0,
      changes: [],
      listening: false,
      stderr: "",
      closed: false,
    };
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      link.seq += 1;
      link.changes.push({ seq: link.seq, uri: notification.params.uri });
      if (link.changes.length > CHANGES_KEPT) link.changes.shift();
    });
    client.onclose = () => {
      link.closed = true;
      clearTimeout(link.idle);
    };
    let transport: Transport;
    try {
      transport = transportOf(server, link);
    } catch (error) {
      throw new McpConnectError(wordsOf(error, link));
    }
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new McpConnectError(wordsOf(error, link));
    }
    return link;
  };

  /** The server's link, started now if it is not running. */
  const linkOf = async (id: string): Promise<Link> => {
    const running = links.get(id);
    if (running) {
      const link = await running.catch(() => undefined);
      if (link && !link.closed) return touch(id, link);
      if (links.get(id) === running) links.delete(id);
    }
    const server = serverOf(id);
    const starting = connect(server);
    links.set(id, starting);
    try {
      const link = await starting;
      await refresh(id, link);
      return touch(id, link);
    } catch (error) {
      if (links.get(id) === starting) links.delete(id);
      if (servers.some((entry) => entry.id === id)) update(id, { health: "unavailable" });
      throw error;
    }
  };

  const touch = (id: string, link: Link): Link => {
    clearTimeout(link.idle);
    link.idle = setTimeout(() => void stop(id), idleMs);
    link.idle.unref?.();
    return link;
  };

  const stop = async (id: string): Promise<void> => {
    const running = links.get(id);
    if (!running) return;
    links.delete(id);
    const link = await running.catch(() => undefined);
    if (!link) return;
    clearTimeout(link.idle);
    await link.subscription?.close().catch(() => undefined);
    await link.client.close().catch(() => undefined);
  };

  /** Read the server's tools and resources again, and keep them for its row. */
  const refresh = async (id: string, link: Link) => {
    const lists = await listed(link.client);
    update(id, { ...savedLists(lists, serverOf(id)), health: "ok" });
  };

  /** Ask the server to tell about every resource it listed, once for each start. */
  const listen = async (server: McpSavedServer, link: Link) => {
    if (link.listening) return;
    const uris = server.resources.map((resource) => resource.uri);
    if (link.client.getProtocolEra() === "modern") {
      const subscription = await link.client.listen({ resourceSubscriptions: uris });
      link.subscription = subscription;
      void subscription.closed.then((how) => {
        if (how === "local" || link.subscription !== subscription) return;
        // The stream dropped: changes since are not known, so a look starts again.
        link.subscription = undefined;
        link.listening = false;
        link.generation = randomUUID().slice(0, 8);
      });
    } else {
      for (const uri of uris) await link.client.subscribeResource({ uri });
    }
    link.listening = true;
  };

  const connectionOf = (server: McpSavedServer): IntegrationConnection => ({
    id: server.id,
    account: null,
    health: server.health,
    name: server.name,
    runs: server.runs,
    actions: actionsOf(server),
    ...(server.subscribe && server.resources.length > 0 ? { events: [eventOf()] } : {}),
  });

  return {
    kind: "mcp",
    many: true,
    connections: () => servers.map(connectionOf),

    add: async (input) => {
      const { name, runs } = integrationMcpAddSchema.parse(input);
      let network: McpSavedServer["network"];
      try {
        const parsed = parseRuns(runs);
        if (parsed.kind === "address")
          network = (await readMcpDestination(parsed.url, options.resolve)).mode;
      } catch (error) {
        throw new McpConnectError(wordsOf(error));
      }
      const id = freeId(name, servers);
      const link = await connect({ id, runs, network });
      try {
        const lists = savedLists(await listed(link.client));
        save([
          ...servers,
          {
            id,
            name,
            runs,
            ...(network ? { network } : {}),
            health: "ok",
            ...lists,
          },
        ]);
      } catch (error) {
        await link.client.close().catch(() => undefined);
        throw new McpConnectError(wordsOf(error, link));
      }
      links.set(id, Promise.resolve(touch(id, link)));
      return id;
    },

    check: async (id) => {
      await stop(id);
      await linkOf(id).catch(() => undefined);
      options.changed();
    },

    remove: (id) => {
      void stop(id);
      save(servers.filter((entry) => entry.id !== id));
    },

    call: async (id, action, input) => {
      const server = serverOf(id);
      if (action === MCP_READ_RESOURCE) {
        const { uri } = input as { uri: string };
        const link = await linkOf(id);
        return { text: resourceAnswer(await link.client.readResource({ uri })) };
      }
      const tool = server.tools.find((entry) => entry.action === action);
      if (!tool) return { text: `${server.name} has no action ${action}.`, refused: "invalid" };
      // A tool that changes something reaches here only on the captain's
      // click: the service keeps the call as an ask until then.
      const link = await linkOf(id);
      let result: CallToolResult;
      try {
        result = (await link.client.callTool({
          name: tool.tool,
          arguments: input as Record<string, unknown>,
        })) as CallToolResult;
      } catch (error) {
        // The call left for the server: whether its tool acted is not known.
        throw new IntegrationOutcomeUnknown(error instanceof Error ? error.message : String(error));
      }
      return toolAnswer(result);
    },

    look: async (id, event, cursor): Promise<IntegrationLook> => {
      const server = serverOf(id);
      if (event !== MCP_RESOURCE_EVENT || !server.subscribe || server.resources.length === 0)
        throw new McpConnectError(`${server.name} tells of nothing called ${event}.`);
      const link = await linkOf(id);
      await listen(server, link);
      const now = `${link.generation}:${link.seq}`;
      if (cursor === null) return { cursor: now, items: [] };
      const [generation, seqText] = cursor.split(":");
      const since = Number(seqText);
      const oldest = link.changes[0]?.seq ?? link.seq + 1;
      if (
        generation !== link.generation ||
        !Number.isInteger(since) ||
        since > link.seq ||
        oldest > since + 1
      )
        return { cursor: now, items: [], resynced: true };
      const titles = new Map(server.resources.map((resource) => [resource.uri, titleOf(resource)]));
      return {
        cursor: now,
        items: link.changes
          .filter((change) => change.seq > since)
          .map((change) => ({
            id: `${link.generation}-${change.seq}`,
            summary: `${titles.get(change.uri) ?? change.uri} changed (${change.uri})`,
          })),
      };
    },

    close: async () => {
      await Promise.all([...links.keys()].map((id) => stop(id)));
    },
  };
}

/** What a server lists, every page of it. */
async function listed(client: Client): Promise<{
  tools: Tool[];
  resources: Resource[];
  subscribe: boolean;
}> {
  const capabilities = client.getServerCapabilities() ?? {};
  const tools: Tool[] = [];
  if (capabilities.tools) {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
  }
  const resources: Resource[] = [];
  if (capabilities.resources) {
    let cursor: string | undefined;
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined);
      resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return { tools, resources, subscribe: capabilities.resources?.subscribe === true };
}

/**
 * The lists a row keeps: each tool with its action's name - the one it had
 * before, so an action turned off stays off - and each resource.
 */
function savedLists(
  lists: { tools: Tool[]; resources: Resource[]; subscribe: boolean },
  before?: McpSavedServer,
): Pick<McpSavedServer, "tools" | "resources" | "subscribe"> {
  const room = INTEGRATION_ACTIONS_MAX - (lists.resources.length > 0 ? 1 : 0);
  if (!before && lists.tools.length > room)
    throw new McpConnectError(
      `The server lists ${lists.tools.length} tools; a row holds ${room}. Choose a server with fewer.`,
    );
  const kept = lists.tools.slice(0, room);
  const taken = new Set<string>(lists.resources.length > 0 ? [MCP_READ_RESOURCE] : []);
  const earlier = new Map((before?.tools ?? []).map((tool) => [tool.tool, tool.action]));
  const names = new Map<string, string>();
  for (const tool of kept) {
    const name = earlier.get(tool.name);
    if (name && !taken.has(name)) {
      taken.add(name);
      names.set(tool.name, name);
    }
  }
  for (const tool of kept)
    if (!names.has(tool.name)) names.set(tool.name, actionName(tool.name, taken));
  return {
    tools: kept.map(
      (tool): McpSavedTool => ({
        tool: tool.name,
        action: names.get(tool.name) as string,
        ...((tool.title ?? tool.annotations?.title)
          ? { title: (tool.title ?? tool.annotations?.title) as string }
          : {}),
        ...(tool.description ? { description: tool.description } : {}),
        readOnly: tool.annotations?.readOnlyHint === true,
        schema: tool.inputSchema as Record<string, unknown>,
      }),
    ),
    resources: lists.resources.map(
      (resource): McpSavedResource => ({
        uri: resource.uri,
        name: resource.name,
        ...(resource.title ? { title: resource.title } : {}),
      }),
    ),
    subscribe: lists.subscribe,
  };
}

/** A tool's name as an action's: lowercase words joined by underscores, never one already taken. */
export function actionName(tool: string, taken: Set<string>): string {
  let base = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `tool_${base}`.replace(/_+$/, "");
  base = base.slice(0, 48).replace(/_+$/, "");
  let name = base;
  for (let count = 2; taken.has(name); count++) {
    const suffix = `_${count}`;
    name = `${base.slice(0, 48 - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

const looseInput = z.record(z.string(), z.unknown());

function actionsOf(server: McpSavedServer): IntegrationActionSpec[] {
  const actions: IntegrationActionSpec[] = server.tools.map((tool) => ({
    name: tool.action,
    label: clip(tool.title ?? tool.tool, 64),
    effect: tool.readOnly ? "reads" : "changes",
    description: tool.description ?? `The server's ${tool.tool} tool.`,
    input: looseInput,
    schema: tool.schema,
  }));
  if (server.resources.length > 0) {
    const named = server.resources
      .slice(0, RESOURCES_NAMED)
      .map((resource) => `${resource.uri} (${titleOf(resource)})`);
    const more = server.resources.length - named.length;
    actions.push({
      name: MCP_READ_RESOURCE,
      label: "Read a resource",
      effect: "reads",
      description: `Read one of the server's resources by its address: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
      input: z.strictObject({ uri: z.string().min(1).max(2048) }),
    });
  }
  return actions;
}

function eventOf(): IntegrationEventSpec {
  return {
    name: MCP_RESOURCE_EVENT,
    label: "A resource changed",
    description: `Fires when the server says one of its resources changed; each item names the resource's address, and ${MCP_READ_RESOURCE} reads what it holds now.`,
    every: 1,
  };
}

function titleOf(resource: Pick<McpSavedResource, "name" | "title">): string {
  return resource.title ?? resource.name;
}

/** The end of `text`, when what matters is how it ended. */
function clipStart(text: string, length: number): string {
  return text.length <= length ? text : `…${text.slice(-(length - 1))}`;
}

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/** A tool's answer as words: its text, and what it sent that is not text, named. */
function toolAnswer(result: CallToolResult | { toolResult: unknown }): IntegrationAnswer {
  if ("toolResult" in result) return { text: JSON.stringify(result.toolResult) };
  const parts = (result.content ?? []).map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "resource":
        return "text" in block.resource
          ? block.resource.text
          : `[${block.resource.mimeType ?? "binary"} at ${block.resource.uri}]`;
      case "resource_link":
        return `[${block.name}: ${block.uri}]`;
      case "image":
      case "audio":
        return `[${block.type} ${block.mimeType}, not shown]`;
      default:
        return `[${(block as { type: string }).type}]`;
    }
  });
  const text =
    parts.length > 0
      ? parts.join("\n")
      : result.structuredContent
        ? JSON.stringify(result.structuredContent)
        : "The tool answered with nothing.";
  return result.isError ? { text: `The tool failed: ${text}`, refused: "refused" } : { text };
}

function resourceAnswer(result: ReadResourceResult): string {
  const parts = result.contents.map((content) =>
    "text" in content && typeof content.text === "string"
      ? content.text
      : `[${content.mimeType ?? "binary"} at ${content.uri}, not shown]`,
  );
  return parts.length > 0 ? parts.join("\n") : "The resource is empty.";
}

/** An id for a new server from its name: `mcp-` and the name's words, never one in use. */
function freeId(name: string, servers: readonly McpSavedServer[]): string {
  const words =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/, "") || "server";
  const base = `mcp-${words}`;
  const taken = new Set(servers.map((server) => server.id));
  let id = base;
  for (let count = 2; taken.has(id); count++) id = `${base}-${count}`;
  return id;
}

/** Why a server could not be reached, in the person's words. */
function wordsOf(error: unknown, link?: Link): string {
  if (
    error instanceof McpAddressError ||
    error instanceof McpRunsError ||
    error instanceof McpConnectError
  )
    return error.message;
  if (
    error instanceof UnauthorizedError ||
    (SdkHttpError.isInstance(error) && [401, 403].includes(error.status))
  )
    return `The server asks for a sign-in, which an ${INTEGRATION_KIND_NAMES.mcp} added here cannot give yet.`;
  if (SdkHttpError.isInstance(error) && error.status === 404)
    return "Nothing answers at that address.";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "That program could not be found on this computer.";
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code))
    return "The server's certificate could not be verified.";
  if (
    code &&
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT"].includes(code)
  )
    return "The server could not be reached.";
  // Its last few lines, since a program's last line alone is often only where its log went.
  const said = (link?.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-STDERR_LINES)
    .join(" ");
  if (said) return `The program stopped before it answered. It said: ${clipStart(said, 400)}`;
  const message = error instanceof Error ? error.message : String(error);
  return `The server did not answer as an MCP server: ${clip(message, 200)}`;
}
