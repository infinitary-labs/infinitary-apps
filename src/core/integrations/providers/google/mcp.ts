import {
  type CallToolResult,
  Client,
  isInputRequiredResult,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { GOOGLE_MCP_ENABLE_PAGE, googleConsoleLink } from "@shared/integrations";
import { IntegrationOutcomeUnknown } from "../../binding";

/**
 * Google's Gmail and Calendar MCP servers (docs/integrations.md, "Google"):
 * one MCP client per service, reached over the SDK's streamable HTTP
 * transport with the Google sign-in's access key on every request. Google
 * speaks the 2026-07-28 protocol, so a confirmation it asks for arrives as
 * an `input_required` answer the client retries with the answer, never as a
 * request held open on a connection.
 *
 * The client declares that it can carry a form to a person
 * (`elicitation.form`) and registers no handler for one: the host never
 * answers Google's question itself. A tool call that comes back asking is a
 * `GoogleAsksToConfirm`, whose words and choices go to the captain on a card,
 * and whose `state` the same call takes back with the captain's pick.
 */

export type GoogleService = "gmail" | "calendar";

/** What Google said of one request, beyond its answer: the row's facts follow it. */
export type GoogleHeard =
  | { kind: "answered" }
  /** Google refused a key just renewed: the client is not marked for an AI-powered agent. */
  | { kind: "agent" }
  /** The service's MCP server is off in the person's Google project; `link` turns it on. */
  | { kind: "service"; link: string }
  /** Google could not be reached, or failed. */
  | { kind: "unavailable" };

export type GoogleMcpOptions = {
  service: GoogleService;
  /** The service's MCP address. */
  url: string;
  /** The service's name in words served to the crew: Gmail, Google Calendar. */
  label: string;
  /** The app's version, named to Google as the client's. */
  version: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /**
   * The access key for the next request: renewed first when it is about to
   * end. It throws words when there is no sign-in, or Google asked the app to
   * wait.
   */
  key: () => Promise<string>;
  /**
   * Google refused `refused`: a fresh key, renewed unless `refused` is a key
   * renewed so recently that renewing again cannot help, then undefined.
   */
  renewed: (refused: string) => Promise<string | undefined>;
  /** Google asked the app to slow down, with its Retry-After: how many milliseconds it said, if it did. */
  slowed: (retryAfter: string | null) => number | undefined;
  heard: (service: GoogleService, heard: GoogleHeard) => void;
};

/** Google's tool answered that it did not do it (`isError`), with Google's own words. */
export class GoogleToolRefused extends Error {}

/** One of the choices Google's question offers, as Google names and words it. */
export type GoogleChoice = { value: string; label: string };

/** Google's question about one tool call, for the captain: its words, its choices, and the call to retry. */
export type GoogleConfirm = { message: string; options: GoogleChoice[]; state: string };

/** The tool call stopped to ask the captain (`GoogleConfirm`). */
export class GoogleAsksToConfirm extends Error {
  constructor(readonly confirm: GoogleConfirm) {
    // i18n-exempt: an error's words, which no person reads
    super(`Google asks to confirm: ${confirm.message}`);
  }
}

/** The captain's pick for a question Google asked, with the state the question came with. */
export type GoogleAnswer = { state: string; choice: string };

/** What a confirmation's state keeps: the call it answers and where its answer goes. */
type ConfirmState = {
  tool: string;
  args: string;
  key: string;
  property: string;
  requestState?: string;
};

/**
 * One request to a service's tool. `change` names a tool that changes
 * something or sends it: a failure after its request left is an unknown
 * outcome, never retried.
 */
export type GoogleTool = ((
  tool: string,
  args: Record<string, unknown>,
  change?: boolean,
) => Promise<Record<string, unknown>>) & {
  /** Whether the service's tool list names this tool, read once a connection. */
  lists: (tool: string) => Promise<boolean>;
};

/** A failure the transport's fetch raised; `left` when it was a tool call that may have reached Google. */
class GoogleStopped extends Error {
  constructor(
    message: string,
    readonly left: boolean,
  ) {
    super(message);
  }
}

const TOOL_CALL = /"method"\s*:\s*"tools\/call"/;

/**
 * Google's SERVICE_DISABLED refusal anywhere in an answer: the address it
 * names to turn the service on, kept only on Google's own console.
 */
export function disabledServiceLink(body: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const entry = value as { reason?: unknown; metadata?: { activationUrl?: unknown } };
    if (entry.reason === "SERVICE_DISABLED") {
      const named = entry.metadata?.activationUrl;
      return typeof named === "string" && named.length <= 2048 && googleConsoleLink(named)
        ? named
        : GOOGLE_MCP_ENABLE_PAGE;
    }
    for (const inner of Object.values(value)) {
      const found = walk(inner);
      if (found) return found;
    }
    return undefined;
  };
  return walk(body);
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Keys in a fixed order, so the same call compares equal however its object was built. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The text of a tool's answer, for its refusal's words. */
function textOf(result: CallToolResult): string {
  const text = (result.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "");
}

/**
 * Google's question, when it is one the captain can answer on a card: a
 * form with one choice among named values. Anything else is refused, since
 * the host answers nothing itself.
 */
function confirmOf(
  tool: string,
  args: Record<string, unknown>,
  result: { inputRequests?: Record<string, unknown>; requestState?: unknown },
  label: string,
): GoogleConfirm {
  const entries = Object.entries(result.inputRequests ?? {});
  const cannot = new Error(
    `${label} asked for something the app cannot put to the captain, so nothing ran.`,
  );
  if (entries.length !== 1) throw cannot;
  const [key, request] = entries[0] as [string, { method?: unknown; params?: unknown }];
  if (request.method !== "elicitation/create") throw cannot;
  const params = (request.params ?? {}) as {
    mode?: unknown;
    message?: unknown;
    requestedSchema?: { properties?: Record<string, unknown> };
  };
  if (params.mode !== undefined && params.mode !== "form") throw cannot;
  const properties = Object.entries(params.requestedSchema?.properties ?? {});
  if (properties.length !== 1 || typeof params.message !== "string") throw cannot;
  const [property, schema] = properties[0] as [
    string,
    {
      enum?: unknown;
      enumNames?: unknown;
      oneOf?: { const?: unknown; title?: unknown }[];
    },
  ];
  let options: GoogleChoice[] = [];
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    options = schema.enum.flatMap((value, index) =>
      typeof value === "string"
        ? [{ value, label: typeof names[index] === "string" ? names[index] : value }]
        : [],
    );
  } else if (Array.isArray(schema.oneOf)) {
    options = schema.oneOf.flatMap((entry) =>
      typeof entry.const === "string"
        ? [
            {
              value: entry.const,
              label: typeof entry.title === "string" ? entry.title : entry.const,
            },
          ]
        : [],
    );
  }
  if (options.length === 0) throw cannot;
  const state: ConfirmState = {
    tool,
    args: canonical(args),
    key,
    property,
    ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
  };
  return { message: params.message, options, state: JSON.stringify(state) };
}

function stateOf(answer: GoogleAnswer): ConfirmState {
  const parsed = jsonOf(answer.state) as Partial<ConfirmState> | undefined;
  if (
    !parsed ||
    typeof parsed.tool !== "string" ||
    typeof parsed.args !== "string" ||
    typeof parsed.key !== "string" ||
    typeof parsed.property !== "string"
  )
    throw new Error("The confirmation no longer reads as Google's question; ask again.");
  return parsed as ConfirmState;
}

/**
 * One service's MCP client: connected on its first call and kept, and let
 * go after a failure of the connection itself, so the next call connects
 * again. `tools(answer)` gives the calls of one action; with the captain's
 * answer to Google's question, the first call that matches the question's
 * own carries that answer.
 */
export function googleMcp(options: GoogleMcpOptions): {
  tools: (answer?: GoogleAnswer) => GoogleTool;
  close: () => Promise<void>;
} {
  let connecting: Promise<Client> | undefined;
  let current: Client | undefined;
  let listed: Promise<ReadonlySet<string>> | undefined;

  const send: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call = body !== undefined && TOOL_CALL.test(body);
    const attempt = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      // i18n-exempt: an HTTP header, not words
      headers.set("authorization", `Bearer ${token}`);
      const signal = AbortSignal.timeout(options.timeoutMs);
      try {
        return await options.fetch(input, {
          ...init,
          headers,
          redirect: "error",
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        });
      } catch {
        options.heard(options.service, { kind: "unavailable" });
        // i18n-exempt: words served to the crew, which stay English
        throw new GoogleStopped(`Could not reach ${options.label}.`, call);
      }
    };
    // A key that cannot be had stops the request before it leaves: nothing changed.
    const before = async <T>(get: () => Promise<T>): Promise<T> => {
      try {
        return await get();
      } catch (error) {
        throw new GoogleStopped(error instanceof Error ? error.message : String(error), false);
      }
    };
    const token = await before(options.key);
    let response = await attempt(token);
    if (response.status === 401) {
      const again = await before(() => options.renewed(token));
      if (again !== undefined) response = await attempt(again);
      if (response.status === 401) {
        options.heard(options.service, { kind: "agent" });
        throw new GoogleStopped(
          `Google refused this Google client for ${options.label}: it is not marked for an AI-powered agent. The captain ticks "Use this client for an AI-powered agent" on the client in Google Cloud; Settings -> Integrations links to it.`,
          false,
        );
      }
    }
    if (response.status === 403) {
      const link = disabledServiceLink(jsonOf(await response.clone().text()));
      if (link) {
        options.heard(options.service, { kind: "service", link });
        // i18n-exempt: words served to the crew, which stay English
        throw new GoogleStopped(
          `${options.label}'s MCP service is off in the captain's Google Cloud project. The captain turns it on there; Settings -> Integrations links to it.`,
          false,
        );
      }
    }
    if (response.status === 429) {
      const after = options.slowed(response.headers.get("retry-after"));
      // i18n-exempt: words served to the crew, which stay English
      throw new GoogleStopped(
        `${options.label} asked the app to slow down${after !== undefined ? ` for ${Math.ceil(after / 1000)} seconds` : ""}.`,
        false,
      );
    }
    if (response.status >= 500) {
      options.heard(options.service, { kind: "unavailable" });
      // i18n-exempt: words served to the crew, which stay English
      throw new GoogleStopped(`${options.label} failed (status ${response.status}).`, call);
    }
    if (response.ok) options.heard(options.service, { kind: "answered" });
    return response;
  };

  const connected = (): Promise<Client> => {
    connecting ??= (async () => {
      const client = new Client(
        { name: "infinitary", version: options.version },
        {
          versionNegotiation: { mode: "auto" },
          // A form can reach a person, but no handler answers one: the captain does, on a card.
          capabilities: { elicitation: { form: {} } },
          inputRequired: { autoFulfill: false },
        },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(options.url), { fetch: send }),
        );
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      client.onclose = () => {
        if (current === client) connecting = undefined;
      };
      current = client;
      return client;
    })();
    connecting.catch(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const letGo = async () => {
    const client = current;
    current = undefined;
    connecting = undefined;
    listed = undefined;
    await client?.close().catch(() => undefined);
  };

  /** Words for a failure that is not Google's answer to the call. */
  const failed = async (error: unknown, change: boolean): Promise<never> => {
    if (error instanceof GoogleStopped) {
      if (error.left) await letGo();
      if (change && error.left)
        // i18n-exempt: words served to the crew, which stay English
        throw new IntegrationOutcomeUnknown(`${error.message} The change may have happened.`);
      throw new Error(error.message);
    }
    if (ProtocolError.isInstance(error)) {
      const link = disabledServiceLink(error.data);
      if (link) {
        options.heard(options.service, { kind: "service", link });
        throw new Error(
          `${options.label}'s MCP service is off in the captain's Google Cloud project. The captain turns it on there; Settings -> Integrations links to it.`,
        );
      }
      // Google failed while it held a change: whether it happened is not known.
      if (change && error.code === -32603)
        throw new IntegrationOutcomeUnknown(`${options.label} failed: ${error.message}`);
      throw new Error(`${options.label} refused: ${error.message}`);
    }
    await letGo();
    if (SdkHttpError.isInstance(error))
      throw new Error(`${options.label} refused (status ${error.status}).`);
    if (change)
      // i18n-exempt: words served to the crew, which stay English
      throw new IntegrationOutcomeUnknown(
        `${options.label} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    throw new Error(
      `Could not reach ${options.label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const lists = async (tool: string): Promise<boolean> => {
    listed ??= (async () => {
      const client = await connected();
      const names = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const entry of page.tools) names.add(entry.name);
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    })();
    const reading = listed;
    try {
      return (await reading).has(tool);
    } catch (error) {
      if (listed === reading) listed = undefined;
      return failed(error, false);
    }
  };

  const tools = (answer?: GoogleAnswer): GoogleTool => {
    let pending = answer ? { answer, state: stateOf(answer) } : undefined;
    const call = async (tool: string, args: Record<string, unknown>, change = false) => {
      let client: Client;
      try {
        client = await connected();
      } catch (error) {
        // Nothing was called yet, so nothing changed.
        return failed(error, false);
      }
      const answering =
        pending && pending.state.tool === tool && pending.state.args === canonical(args)
          ? pending
          : undefined;
      if (answering) pending = undefined;
      let result: unknown;
      try {
        result = await client.callTool(
          {
            name: tool,
            arguments: args,
            ...(answering
              ? {
                  inputResponses: {
                    [answering.state.key]: {
                      action: "accept",
                      content: { [answering.state.property]: answering.answer.choice },
                    },
                  },
                  ...(answering.state.requestState !== undefined
                    ? { requestState: answering.state.requestState }
                    : {}),
                }
              : {}),
          } as never,
          { allowInputRequired: true } as never,
        );
      } catch (error) {
        return failed(error, change);
      }
      if (isInputRequiredResult(result))
        throw new GoogleAsksToConfirm(confirmOf(tool, args, result as never, options.label));
      const done = result as CallToolResult;
      if (done.isError) {
        const said = textOf(done);
        throw new GoogleToolRefused(`${options.label} refused${said ? `: ${said}` : "."}`);
      }
      if (done.structuredContent && typeof done.structuredContent === "object")
        return done.structuredContent as Record<string, unknown>;
      const parsed = jsonOf(textOf(done));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    };
    return Object.assign(call, { lists });
  };

  return { tools, close: letGo };
}
