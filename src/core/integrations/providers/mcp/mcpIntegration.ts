import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  type AuthProvider,
  type CallToolResult,
  Client,
  extractWWWAuthenticateParams,
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
import * as m from "@shared/i18n/messages.generated";
import { INTEGRATION_KIND_NAMES, integrationMcpAddSchema } from "@shared/integrations";
import { cutText, cutTextEnd } from "@shared/textCut";
import { z } from "zod";
import { type HttpCredential, httpSecretBroker } from "../../../secrets/httpBroker";
import { type ProgramStarted, programSecretBroker } from "../../../secrets/programBroker";
import type { UseState } from "../../../secrets/requests";
import type { SignInReturnTo } from "../../../signInReturns";
import { findOnPath, isExecutable } from "../../../userBin";
import {
  type IntegrationActionSpec,
  type IntegrationAnswer,
  type IntegrationBinding,
  type IntegrationConnection,
  type IntegrationEventSpec,
  type IntegrationLook,
  IntegrationOutcomeUnknown,
  type IntegrationSignInHandle,
} from "../../binding";
import { type IntegrationKeys, REDACTED } from "../../secrets";
import {
  guardedMcpFetch,
  guardedSignInFetch,
  holdMcpDestination,
  McpAddressError,
  type McpFetch,
  type McpResolver,
  readMcpDestination,
} from "./guardedFetch";
import { type McpRuns, McpRunsError, parseRuns, runsWithKeys, STAYS_ON_LINE } from "./runs";
import { expiryOf, type McpChallenge, McpSignInError, signInToServer } from "./signIn";
import {
  type McpSavedResource,
  type McpSavedServer,
  type McpSavedSignIn,
  type McpSavedTool,
  McpServerStore,
  McpSignInStore,
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
 *
 * A NAME=value word before the program is a key, but for PATH, which
 * stays on the line: it goes into Secrets as the server is added, or as an
 * earlier version's line moves, and the line keeps NAME={secret:REF}. Such
 * a program starts inside Secrets, through the broker this binding
 * registers. Putting a key on the line is the captain's consent to the
 * server's use of it, so no start asks (docs/secrets.md, "Programs that
 * keep running").
 *
 * A server at an address that answers its first request asking for a
 * sign-in is signed in to in the person's browser as it is added from
 * Settings (`./signIn.ts`; docs/integrations.md, "MCP servers that sign
 * in"). Its lasting key is kept in Secrets and renewed there through the
 * sign-in broker below, which signing in is the consent for, so no renewal
 * asks; the access key lives only in the app's memory. A refused lasting
 * key, or a server that refuses a key just renewed, turns the row to
 * signed out until the person signs in again.
 */

export type McpIntegrationOptions = {
  /** The integrations' folder (`userData/integrations/`); the servers live in its `mcp.json`. */
  root: string;
  /** Every program's environment (`hostEnv()`). */
  env: () => NodeJS.ProcessEnv;
  /** The command to spawn so a program runs below the UI (`atUtilityQos`). */
  belowUi: (file: string, args: readonly string[]) => { file: string; args: string[] };
  cwd: () => string;
  /** The app's version, which the client gives as its own. */
  version: string;
  /** Something a row shows changed: a server's tools, or its health. */
  changed: () => void;
  /** DNS for an address's checks; tests answer it themselves. */
  resolve?: McpResolver;
  /** How long a program may sit unused before it is stopped. */
  idleMs?: number;
  /** Where a server's keys are kept; a run without Secrets keeps a line's values as written. */
  keys?: IntegrationKeys;
  /**
   * Opens a server's sign-in page in the person's browser, saying the port
   * the browser comes back to and when the sign-in stops waiting; without
   * it no server signs in.
   */
  open?: (url: string, to: SignInReturnTo) => Promise<void>;
  now?: () => number;
};

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
/** The broker that starts a server with its kept keys, registered once with Secrets. */
const MCP_BROKER = "mcp-server-keys";
/** The longest line `mcp.json` keeps (`store.ts`). */
const RUNS_LENGTH = 2048;
/** The broker that renews and revokes a server's sign-in, registered once with Secrets. */
const SIGN_IN_BROKER = "mcp-sign-in";
/** An access key this close to running out is renewed before a request. */
const RENEW_EARLY_MS = 30_000;
/** How long one request to a server's sign-in may take. */
const SIGN_IN_REQUEST_MS = 30_000;
/**
 * The label an address server's answers and event summaries reach agents
 * under: words anyone who can write to that service wrote
 * (docs/integrations.md, "Data from outside"). A program's answers are its
 * own and stay unfenced.
 */
export const MCP_DATA_FENCE = "mcp-data";

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

/** A server's sign-in ended: the person signs in again in Settings. */
export class McpSignedOutError extends McpConnectError {}

export function mcpIntegration(
  options: McpIntegrationOptions,
): IntegrationBinding & { moveKeys: () => Promise<void> } {
  const store = new McpServerStore(options.root);
  // Undefined when the file is there but not read whole: then no key is
  // forgotten for seeming unnamed.
  const launched = store.read();
  let servers = launched ?? [];
  const links = new Map<string, Promise<Link>>();
  const idleMs = options.idleMs ?? IDLE_MS;
  const now = options.now ?? Date.now;
  const signInStore = new McpSignInStore(options.root);
  // Undefined when the file is there but not read whole: then no sign-in is
  // forgotten for seeming to have no server.
  const launchedSignIns = signInStore.read();
  let signIns = launchedSignIns ?? [];
  /** A sign-in just made, before its server is saved or it replaces the one before it. */
  const pendingSignIns = new Map<string, McpSavedSignIn>();
  /** Each signed-in server's access key, in the app's memory only. */
  const access = new Map<string, { token: string; expiresAt?: number }>();
  const renewing = new Map<string, Promise<void>>();
  /**
   * Sign-ins just removed or replaced, whose lasting key the broker revokes
   * once more, with the network class their server was added under.
   */
  const forgetting = new Map<
    string,
    { signIn: McpSavedSignIn; network: NonNullable<McpSavedServer["network"]> }
  >();
  /** The network class each sign-in address the broker sends to was reached under. */
  const brokerNetworks = new Map<string, NonNullable<McpSavedServer["network"]>>();

  const save = (next: McpSavedServer[]) => {
    servers = next;
    store.write(servers);
  };
  const saveSignIns = (next: McpSavedSignIn[]) => {
    signIns = next;
    signInStore.write(signIns);
  };
  const signInOf = (id: string): McpSavedSignIn | undefined =>
    pendingSignIns.get(id) ?? signIns.find((entry) => entry.id === id);
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

  const hostEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env()))
      if (value !== undefined) env[name] = value;
    return env;
  };

  /**
   * The program a line names, found here, before it starts below the
   * window: a program that is not there would otherwise fail inside the
   * wrapper that lowers its priority, and the words would name the wrapper.
   */
  const programOf = (runs: Extract<McpRuns, { kind: "program" }>, env: NodeJS.ProcessEnv) => {
    const program = runs.command.includes("/")
      ? resolvePath(options.cwd(), runs.command)
      : findOnPath(runs.command, env);
    if (!program || !isExecutable(program))
      throw new McpConnectError(`${runs.command} could not be found on this computer.`);
    return program;
  };

  const stdioOf = (
    program: { program: string; args: string[]; cwd: string; env: Record<string, string> },
    link: Link,
  ): Transport => {
    const spawn = options.belowUi(program.program, program.args);
    const transport = new StdioClientTransport({
      command: spawn.file,
      args: spawn.args,
      env: program.env,
      cwd: program.cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      link.stderr = cutTextEnd(`${link.stderr}${chunk.toString("utf8")}`, 2048);
    });
    return transport;
  };

  const transportOf = (
    server: Pick<McpSavedServer, "id" | "runs" | "network">,
    link: Link,
    heard?: (challenge: McpChallenge) => void,
  ): Transport => {
    const runs = parseRuns(server.runs);
    if (runs.kind === "address") {
      const destination = holdMcpDestination(runs.url, server.network ?? "public");
      const guarded = guardedMcpFetch(destination, options.resolve);
      // Listening for a sign-in's ask sends no key: it is what a server says
      // before anyone has signed in.
      if (heard) {
        const listening: McpFetch = async (url, init) => {
          const response = await guarded(url, init);
          if (response.status === 401) heard(challengeOf(response));
          return response;
        };
        return new StreamableHTTPClientTransport(new URL(destination.baseUrl), {
          fetch: listening,
        });
      }
      return new StreamableHTTPClientTransport(new URL(destination.baseUrl), {
        fetch: guarded,
        ...(signInOf(server.id) ? { authProvider: authOf(server.id) } : {}),
      });
    }
    const env = { ...hostEnv(), ...runs.env };
    return stdioOf(
      { program: programOf(runs, env), args: runs.args, cwd: options.cwd(), env },
      link,
    );
  };

  const newLink = (): Link => {
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
    return link;
  };

  const connectOver = async (
    link: Link,
    transport: () => Transport,
    id?: string,
  ): Promise<Link> => {
    let made: Transport;
    try {
      made = transport();
    } catch (error) {
      throw new McpConnectError(wordsOf(error, link));
    }
    try {
      await link.client.connect(made);
    } catch (error) {
      await link.client.close().catch(() => undefined);
      throw (id ? signedOutBy(id, error) : undefined) ?? new McpConnectError(wordsOf(error, link));
    }
    return link;
  };

  /** Servers being added: their line, so the broker starts one before it is saved. */
  const adding = new Map<string, Pick<McpSavedServer, "name" | "runs" | "network">>();
  const nameOf = (id: string): string =>
    servers.find((entry) => entry.id === id)?.name ?? adding.get(id)?.name ?? id;
  const networkOf = (id: string): NonNullable<McpSavedServer["network"]> =>
    servers.find((entry) => entry.id === id)?.network ?? adding.get(id)?.network ?? "public";
  const setHealth = (id: string, health: McpSavedServer["health"]) => {
    if (servers.some((entry) => entry.id === id)) update(id, { health });
  };

  /** The sign-in ended: the row says so, and every request refuses until the person signs in again. */
  const signedOut = (id: string): McpSignedOutError => {
    access.delete(id);
    setHealth(id, "needs_reauth");
    return new McpSignedOutError(
      `${nameOf(id)} is signed out. Sign in again in Settings → Integrations.`,
    );
  };

  /** A request a signed-in server refused even with a key just renewed: signed out. */
  const signedOutBy = (id: string, error: unknown): McpSignedOutError | undefined => {
    if (error instanceof McpSignedOutError) return error;
    if (!signInOf(id)) return undefined;
    if (
      error instanceof UnauthorizedError ||
      (SdkHttpError.isInstance(error) && error.status === 401)
    )
      return signedOut(id);
    return undefined;
  };

  let signInRegistered = false;
  /**
   * The sign-in broker: a server's lasting key, in the renewal's
   * refresh_token field or the revocation's token field, sent to the token
   * or revocation address its sign-in named and nowhere else, with the
   * client's own key where the sign-in gave one. Signing in to the server
   * in Settings is the consent, so it declares the app's own sign-in and
   * Secrets runs each renewal, and the revoke at removal, without asking
   * (docs/secrets.md, "App sign-ins").
   */
  const registerSignIn = (keys: IntegrationKeys) => {
    if (signInRegistered) return;
    signInRegistered = true;
    keys.registerBroker(
      httpSecretBroker({
        id: SIGN_IN_BROKER,
        label: `${INTEGRATION_KIND_NAMES.mcp} sign-in`,
        signIn: true,
        resolve: (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
          const { server: id, op } = input;
          if (typeof id !== "string" || (op !== "renew" && op !== "revoke")) return undefined;
          // Only a sign-in this binding holds; never a reference a caller made up.
          const held = forgetting.get(id);
          const signIn = op === "renew" ? signInOf(id) : held?.signIn;
          const url = op === "renew" ? signIn?.token : signIn?.revoke;
          if (!signIn?.key || !url) return undefined;
          const name = nameOf(id);
          const form: Record<string, string> =
            op === "renew"
              ? {
                  grant_type: "refresh_token",
                  ...(signIn.resource ? { resource: signIn.resource } : {}),
                }
              : { token_type_hint: "refresh_token" };
          const credentials: Record<string, HttpCredential> = {
            refresh: {
              ref: signIn.key,
              delivery: { kind: "form", name: op === "renew" ? "refresh_token" : "token" },
            },
          };
          if (signIn.clientAuth === "client_secret_basic" && signIn.clientKey)
            credentials.client = {
              ref: signIn.clientKey,
              // i18n-exempt: the HTTP authorization scheme's own name
              delivery: { kind: "header", name: "authorization", prefix: "Basic " },
            };
          else form.client_id = signIn.clientId;
          if (signIn.clientAuth === "client_secret_post" && signIn.clientKey)
            credentials.client = {
              ref: signIn.clientKey,
              delivery: { kind: "form", name: "client_secret" },
            };
          const network = op === "renew" ? networkOf(id) : (held?.network ?? "public");
          const href = new URL(url).href;
          // Two servers sending to one sign-in address under different classes: the strictest.
          const sent = brokerNetworks.get(href);
          brokerNetworks.set(href, sent && sent !== network ? "public" : network);
          return {
            url,
            method: "POST",
            headers: { accept: "application/json" },
            form,
            credentials,
            operation:
              op === "renew"
                ? m.integrationsMcpRenewOperation({ name })
                : m.integrationsMcpRevokeOperation({ name }),
            read: false,
            result:
              op === "renew"
                ? m.integrationsMcpRenewResult({ name })
                : m.integrationsMcpRevokeResult(),
          };
        },
        send: (url, init) =>
          guardedSignInFetch(brokerNetworks.get(url) ?? "public", options.resolve)(url, {
            ...init,
            signal: AbortSignal.timeout(SIGN_IN_REQUEST_MS),
          }),
      }),
    );
  };

  /** Trade a server's lasting key for a new access key, inside Secrets; one renewal at a time. */
  const renew = (id: string): Promise<void> => {
    const running = renewing.get(id);
    if (running) return running;
    const made = (async () => {
      const signIn = signInOf(id);
      const name = nameOf(id);
      if (!signIn?.key) throw signedOut(id);
      const keys = options.keys;
      if (!keys?.shown())
        throw new McpConnectError(
          `${name} keeps its sign-in in Secrets, which this computer does not offer, so it cannot connect here.`,
        );
      registerSignIn(keys);
      const used = await keys.use({
        id: randomUUID(),
        reason: m.integrationsMcpRenewReason({ name }),
        broker: SIGN_IN_BROKER,
        input: { server: id, op: "renew" },
      });
      if (used.state === "unavailable") {
        setHealth(id, "unavailable");
        throw new McpConnectError(
          `${name} could not renew its sign-in: Secrets is locked. Unlock it in Settings → Secrets.`,
        );
      }
      const response = used.state === "completed" ? used.result : undefined;
      if (!(response instanceof Response)) {
        setHealth(id, "unavailable");
        throw new McpConnectError(`Could not reach ${name}'s sign-in to renew it.`);
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const token =
        typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
      if (!response.ok || !token) {
        // The sign-in refused the lasting key or the client itself: signed out there, or revoked.
        if (response.status === 400 || response.status === 401) throw signedOut(id);
        setHealth(id, "unavailable");
        throw new McpConnectError(`${name}'s sign-in did not renew (status ${response.status}).`);
      }
      const expiresAt = expiryOf(body.expires_in, now());
      access.set(id, { token, ...(expiresAt !== undefined ? { expiresAt } : {}) });
      // A new lasting key replaces the old one in place, under its reference.
      if (typeof body.refresh_token === "string" && body.refresh_token)
        await keys.keepHidden({
          ref: signIn.key,
          label: `${name} sign-in`,
          value: Buffer.from(body.refresh_token, "utf8"),
        });
    })().finally(() => {
      renewing.delete(id);
    });
    renewing.set(id, made);
    return made;
  };

  /**
   * The key a signed-in server's requests carry: renewed before it runs
   * out, and once more when the server refuses it; a refusal after that is
   * the transport's, which `signedOutBy` reads as signed out.
   */
  const authOf = (id: string): AuthProvider => ({
    token: async () => {
      const held = access.get(id);
      if (!held || (held.expiresAt !== undefined && held.expiresAt - now() < RENEW_EARLY_MS))
        await renew(id);
      return access.get(id)?.token;
    },
    onUnauthorized: async () => {
      access.delete(id);
      await renew(id);
    },
  });

  /**
   * Tell the server's sign-in to forget a sign-in, as far as it offers and
   * can be reached, then forget its keys here either way. An access key
   * still in memory is revoked by itself; the lasting key through Secrets.
   */
  const forgetSignIn = async (
    signIn: McpSavedSignIn,
    network: NonNullable<McpSavedServer["network"]>,
    token: string | undefined,
  ) => {
    const keys = options.keys;
    if (signIn.revoke) {
      if (token && signIn.clientAuth === "none")
        await guardedSignInFetch(network, options.resolve)(signIn.revoke, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            token_type_hint: "access_token",
            client_id: signIn.clientId,
          }).toString(),
          signal: AbortSignal.timeout(SIGN_IN_REQUEST_MS),
        }).catch(() => undefined);
      if (signIn.key && keys?.shown()) {
        registerSignIn(keys);
        forgetting.set(signIn.id, { signIn, network });
        await keys
          .use({
            id: randomUUID(),
            reason: m.integrationsMcpRevokeReason({ name: nameOf(signIn.id) }),
            broker: SIGN_IN_BROKER,
            input: { server: signIn.id, op: "revoke" },
          })
          .catch(() => undefined);
        forgetting.delete(signIn.id);
      }
    }
    if (keys)
      for (const ref of [signIn.key, signIn.clientKey])
        if (ref) await keys.forgetHidden(ref).catch(() => false);
  };

  /**
   * Sign in to a server at `url` in the person's browser, keep its keys -
   * the lasting key and any client key in Secrets, the access key in
   * memory - and hold the sign-in as pending under `id` until it is saved.
   */
  const signInFor = async (
    id: string,
    name: string,
    url: string,
    network: NonNullable<McpSavedServer["network"]>,
    challenge: McpChallenge,
    handle: IntegrationSignInHandle,
  ): Promise<McpSavedSignIn> => {
    const open = options.open;
    const keys = options.keys;
    if (!open || !keys?.shown())
      throw new McpConnectError(
        `${name} asks for a sign-in, which Infinitary keeps in Secrets. Secrets is not offered on this computer.`,
      );
    const issued = await signInToServer({
      name,
      server: url,
      network,
      challenge,
      signal: handle.signal,
      now,
      ...(options.resolve ? { resolve: options.resolve } : {}),
      open: async (page, to) => {
        await open(page, to);
        handle.opened({ page, again: () => open(page, to) });
      },
    });
    const kept: string[] = [];
    const keep = async (label: string, value: string) => {
      const ref = await keys.keepHidden({ label, value: Buffer.from(value, "utf8") });
      if (ref) kept.push(ref);
      return ref;
    };
    const key = issued.refreshToken
      ? await keep(`${name} sign-in`, issued.refreshToken)
      : undefined;
    const clientKey = issued.clientSecret
      ? await keep(
          `${name} sign-in app`,
          issued.facts.clientAuth === "client_secret_basic"
            ? Buffer.from(`${issued.facts.clientId}:${issued.clientSecret}`, "utf8").toString(
                "base64",
              )
            : issued.clientSecret,
        )
      : undefined;
    const record: McpSavedSignIn = {
      id,
      ...issued.facts,
      ...(clientKey ? { clientKey } : {}),
      ...(key ? { key } : {}),
      signedInAt: now(),
    };
    if ((issued.refreshToken && !key) || (issued.clientSecret && !clientKey)) {
      for (const ref of kept) await keys.forgetHidden(ref).catch(() => false);
      await forgetSignIn(
        { ...record, key: undefined, clientKey: undefined },
        network,
        issued.accessToken,
      );
      throw new McpConnectError(
        "Infinitary keeps a server's sign-in in Secrets, which is locked or cannot open now. Unlock it in Settings → Secrets.",
      );
    }
    pendingSignIns.set(id, record);
    access.set(id, {
      token: issued.accessToken,
      ...(issued.expiresAt !== undefined ? { expiresAt: issued.expiresAt } : {}),
    });
    return record;
  };

  /** A sign-in just made that did not lead to a working server: the server forgets it too. */
  const dropPending = async (id: string, network: NonNullable<McpSavedServer["network"]>) => {
    const record = pendingSignIns.get(id);
    if (!record) return;
    pendingSignIns.delete(id);
    const token = access.get(id)?.token;
    access.delete(id);
    await forgetSignIn(record, network, token);
  };
  let registered = false;
  /**
   * The broker that starts a server with its kept keys: only a line the
   * person saved or is adding, never one a caller made up. Secrets binds the
   * program, its interpreter, its file arguments and folder and which
   * variable gets which key, and gives the keys to the program as it
   * starts, through this binding's own pipes.
   */
  const register = (keys: IntegrationKeys) => {
    if (registered) return;
    registered = true;
    keys.registerBroker(
      programSecretBroker<Link>({
        id: MCP_BROKER,
        hidden: REDACTED,
        resolve: (input) => {
          if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
          const { server: id, runs: line } = input;
          if (typeof id !== "string" || typeof line !== "string") return undefined;
          const server = servers.find((entry) => entry.id === id) ?? adding.get(id);
          if (!server || server.runs !== line) return undefined;
          let runs: McpRuns;
          try {
            runs = parseRuns(line);
          } catch {
            return undefined;
          }
          if (runs.kind !== "program" || Object.keys(runs.keys).length === 0) return undefined;
          const env = { ...hostEnv(), ...runs.env };
          let program: string;
          try {
            program = programOf(runs, env);
          } catch {
            return undefined;
          }
          return {
            label: server.name,
            program,
            args: runs.args,
            cwd: options.cwd(),
            env,
            keys: runs.keys,
            operation: `Start ${server.name}, an ${INTEGRATION_KIND_NAMES.mcp}, and keep talking to it`,
            result: "Its connection, which Infinitary keeps until the server stops",
          };
        },
        start: (program) => {
          const link = newLink();
          return connectOver(link, () => stdioOf(program, link));
        },
      }),
    );
  };

  /** Start a server whose line names kept keys, through Secrets, or throw words saying why not. */
  const startKept = async (
    server: Pick<McpSavedServer, "id" | "name" | "runs">,
    runs: Extract<McpRuns, { kind: "program" }>,
  ): Promise<Link> => {
    const keys = options.keys;
    if (!keys?.shown())
      throw new McpConnectError(
        `${server.name} keeps its keys in Secrets, which this computer does not offer, so it cannot start here.`,
      );
    // Not there is said here, in words; Secrets would only say it could not.
    programOf(runs, { ...hostEnv(), ...runs.env });
    register(keys);
    const used = await keys.use({
      id: randomUUID(),
      reason: `Infinitary starts ${server.name}, an ${INTEGRATION_KIND_NAMES.mcp} you added in Integrations, with its keys.`,
      broker: MCP_BROKER,
      input: { server: server.id, runs: server.runs },
    });
    const started = (used.state === "completed" ? used.result : undefined) as
      | ProgramStarted<Link>
      | undefined;
    if (!started) throw new McpConnectError(keptWords(used.state, server.name, keys));
    if ("started" in started) return started.started;
    if ("failed" in started) throw new McpConnectError(started.failed);
    throw new McpConnectError(
      `${server.name} did not start: its program changed as it was starting. Try again.`,
    );
  };

  /** Start or reach a server; with `heard`, an address's ask for a sign-in is heard rather than answered. */
  const connect = async (
    server: Pick<McpSavedServer, "id" | "name" | "runs" | "network">,
    heard?: (challenge: McpChallenge) => void,
  ): Promise<Link> => {
    let runs: McpRuns;
    try {
      runs = parseRuns(server.runs);
    } catch (error) {
      throw new McpConnectError(wordsOf(error));
    }
    if (runs.kind === "program" && Object.keys(runs.keys).length > 0)
      return startKept(server, runs);
    const link = newLink();
    return connectOver(link, () => transportOf(server, link, heard), heard ? undefined : server.id);
  };

  const linkOf = async (id: string): Promise<Link> => {
    const running = links.get(id);
    if (running) {
      const link = await running.catch(() => undefined);
      if (link && !link.closed) return touch(id, link);
      if (links.get(id) === running) links.delete(id);
    }
    const server = serverOf(id);
    // A signed-out row asks for nothing until the person signs in again.
    if (server.health === "needs_reauth" && signInOf(id)) throw signedOut(id);
    const starting = connect(server);
    links.set(id, starting);
    let started: Link | undefined;
    try {
      started = await starting;
      await refresh(id, started);
      return touch(id, started);
    } catch (error) {
      // A server that started but could not list is closed here, or its program runs on.
      await started?.client.close().catch(() => undefined);
      if (links.get(id) === starting) links.delete(id);
      if (!(error instanceof McpSignedOutError)) setHealth(id, "unavailable");
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

  /**
   * Keep a line's values in Secrets, each under a fresh reference labelled
   * with the server and its variable, and answer the line naming them; a
   * line with no values, or only those that stay on it such as PATH, is
   * answered as it is. Undefined when Secrets cannot keep them now, with
   * none of them kept.
   */
  const keepValues = async (
    keys: IntegrationKeys,
    name: string,
    line: string,
  ): Promise<{ runs: string; kept: string[] } | undefined> => {
    const runs = parseRuns(line);
    const values =
      runs.kind === "program"
        ? Object.entries(runs.env).filter(([variable]) => !STAYS_ON_LINE.has(variable))
        : [];
    if (values.length === 0) return { runs: line, kept: [] };
    const refs: Record<string, string> = {};
    for (const [variable, value] of values) {
      const ref = await keys.keepHidden({
        label: `${name}: ${variable}`,
        value: Buffer.from(value, "utf8"),
        forProgram: true,
      });
      if (!ref) {
        await forgetKept(keys, Object.values(refs));
        return undefined;
      }
      refs[variable] = ref;
    }
    return { runs: runsWithKeys(line, refs), kept: Object.values(refs) };
  };

  /** Forget keys kept for a program that no saved or adding line still names; none while a line cannot be read. */
  const forgetKept = async (keys: IntegrationKeys, refs: readonly string[]) => {
    const named = namedRefs([...servers, ...adding.values()]);
    if (!named) return;
    for (const ref of refs) if (!named.has(ref)) await keys.forgetHidden(ref).catch(() => false);
  };

  let moving: Promise<void> | undefined;
  /**
   * An earlier version kept a server's values on its line: each moves into
   * Secrets, then the line is saved naming them, so an interruption leaves
   * the line as it was. A key kept for a program that no line names - one
   * an interrupted move or addition kept - is forgotten first, but only when
   * the file was read whole and every line in it understood: a damaged file,
   * or one a newer build wrote, never makes a key look unused. Nothing
   * moves while Secrets cannot keep a key.
   */
  const moveKeys = (): Promise<void> => {
    const keys = options.keys;
    if (!keys?.shown()) return Promise.resolve();
    moving ??= (async () => {
      // A sign-in whose server is gone - removed by a build without sign-ins -
      // is forgotten, but only when both files were read whole.
      if (launched && launchedSignIns && adding.size === 0)
        for (const signIn of [...signIns]) {
          if (servers.some((entry) => entry.id === signIn.id)) continue;
          saveSignIns(signIns.filter((entry) => entry.id !== signIn.id));
          for (const ref of [signIn.key, signIn.clientKey])
            if (ref) await keys.forgetHidden(ref).catch(() => false);
        }
      const kept = await keys.programKeys();
      if (!kept) return;
      const named = launched ? namedRefs(servers) : undefined;
      if (named)
        for (const ref of kept) {
          // An addition keeps its keys before its line is saved.
          if (adding.size > 0) break;
          if (!named.has(ref)) await keys.forgetHidden(ref).catch(() => false);
        }
      for (const server of [...servers]) {
        let moved: { runs: string; kept: string[] } | undefined;
        try {
          moved = await keepValues(keys, server.name, server.runs);
        } catch {
          continue;
        }
        if (!moved || moved.kept.length === 0) continue;
        const current = servers.find((entry) => entry.id === server.id);
        if (!current || current.runs !== server.runs || moved.runs.length > RUNS_LENGTH) {
          for (const ref of moved.kept) await keys.forgetHidden(ref).catch(() => false);
          continue;
        }
        update(server.id, { runs: moved.runs });
      }
    })()
      // Tried again at the next launch; a line saved as it was still starts as before.
      .catch(() => undefined)
      .finally(() => {
        moving = undefined;
      });
    return moving;
  };

  const connectionOf = (server: McpSavedServer): IntegrationConnection => ({
    id: server.id,
    account: null,
    health: server.health,
    name: server.name,
    runs: server.runs,
    actions: actionsOf(server),
    ...(server.subscribe && server.resources.length > 0 ? { events: [eventOf()] } : {}),
    ...(signIns.some((entry) => entry.id === server.id) ? { signIn: true as const } : {}),
    ...(isAddress(server.runs) ? { fence: MCP_DATA_FENCE } : {}),
  });

  return {
    kind: "mcp",
    many: true,
    // A file that could not be read may hold servers, so it is never read as none.
    saved: () => servers.length > 0 || launched === undefined,
    connections: () => servers.map(connectionOf),

    redact: (text) => {
      let out = text;
      for (const { token } of access.values()) if (token) out = out.split(token).join(REDACTED);
      return out;
    },

    add: async (input, claim, signIn) => {
      const { name, runs: typed } = integrationMcpAddSchema.parse(input);
      // The id is held before anything waits, so an overlapping addition takes another.
      const id = freeId(name, servers, claim);
      let network: McpSavedServer["network"];
      let address: string | undefined;
      try {
        const parsed = parseRuns(typed);
        // A line names only keys kept for its own server, which start it with no
        // question; a typed reference could name another server's.
        if (parsed.kind === "program" && Object.keys(parsed.keys).length > 0)
          throw new McpConnectError(
            "Runs names a key kept in Secrets: write the key itself, and Infinitary keeps it in Secrets for this server.",
          );
        if (parsed.kind === "address") {
          network = (await readMcpDestination(parsed.url, options.resolve)).mode;
          address = parsed.url;
        }
      } catch (error) {
        throw new McpConnectError(wordsOf(error));
      }
      // Its values go into Secrets first, so the line it saves names them.
      adding.set(id, { name, runs: typed, ...(network ? { network } : {}) });
      let kept: string[] = [];
      try {
        let runs = typed;
        const keys = options.keys;
        if (keys?.shown()) {
          const moved = await keepValues(keys, name, typed);
          if (!moved)
            throw new McpConnectError(
              "Infinitary keeps a server's keys in Secrets, which is locked or cannot open now. Unlock it in Settings → Secrets.",
            );
          kept = moved.kept;
          runs = moved.runs;
          if (runs.length > RUNS_LENGTH)
            throw new McpConnectError(
              "Runs is too long once its keys are kept in Secrets: shorten it.",
            );
          adding.set(id, { name, runs, ...(network ? { network } : {}) });
        }
        let link: Link;
        let challenge: McpChallenge | undefined;
        try {
          link = await connect(
            { id, name, runs, network },
            address
              ? (heard) => {
                  challenge = heard;
                }
              : undefined,
          );
        } catch (error) {
          // A server that asks for a sign-in: the person signs in in their browser.
          if (!challenge || !address) throw error;
          if (!signIn)
            throw new McpConnectError(
              `${name} asks for a sign-in, which you make in your browser from Settings → Integrations → ${INTEGRATION_KIND_NAMES.mcp}.`,
            );
          await signInFor(id, name, address, network ?? "public", challenge, signIn);
          link = await connect({ id, name, runs, network });
        }
        try {
          const lists = savedLists(await listed(link.client));
          // The sign-in first: one left without its server is forgotten at the next start.
          const made = pendingSignIns.get(id);
          if (made) saveSignIns([...signIns.filter((entry) => entry.id !== id), made]);
          pendingSignIns.delete(id);
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
        kept = [];
        links.set(id, Promise.resolve(touch(id, link)));
        return id;
      } finally {
        await dropPending(id, network ?? "public");
        adding.delete(id);
        if (kept.length > 0 && options.keys) await forgetKept(options.keys, kept);
      }
    },

    signInAgain: async (id, handle) => {
      const server = serverOf(id);
      if (!isAddress(server.runs))
        throw new McpConnectError(`${server.name} runs on this computer and has no sign-in.`);
      const { url } = parseRuns(server.runs) as Extract<McpRuns, { kind: "address" }>;
      const network = server.network ?? "public";
      await stop(id);
      const earlier = signIns.find((entry) => entry.id === id);
      const earlierToken = access.get(id)?.token;
      // What the server asks for now, heard before any key is sent.
      let challenge: McpChallenge = {};
      const probe = await connect(server, (heard) => {
        challenge = heard;
      }).catch(() => undefined);
      await probe?.client.close().catch(() => undefined);
      access.delete(id);
      try {
        await signInFor(id, server.name, url, network, challenge, handle);
        const link = await connect(server);
        try {
          const made = pendingSignIns.get(id);
          if (made) saveSignIns([...signIns.filter((entry) => entry.id !== id), made]);
          pendingSignIns.delete(id);
          links.set(id, Promise.resolve(touch(id, link)));
          await refresh(id, link);
        } catch (error) {
          await link.client.close().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        await dropPending(id, network);
        throw error;
      }
      // The sign-in this one replaced: the server forgets it, and so does Secrets.
      if (earlier) await forgetSignIn(earlier, network, earlierToken);
    },

    check: async (id) => {
      await stop(id);
      await linkOf(id).catch(() => undefined);
      options.changed();
    },

    remove: async (id) => {
      const removed = servers.find((entry) => entry.id === id);
      void stop(id);
      save(servers.filter((entry) => entry.id !== id));
      // Its sign-in goes with it: the server forgets it where it offers that, and Secrets either way.
      const signIn = signIns.find((entry) => entry.id === id);
      if (signIn) {
        saveSignIns(signIns.filter((entry) => entry.id !== id));
        const token = access.get(id)?.token;
        access.delete(id);
        await forgetSignIn(signIn, removed?.network ?? "public", token);
      }
      // Its keys go with it, unless another line names them.
      const keys = options.keys;
      if (!removed || !keys) return;
      // A line this build cannot read names none it can be sure of.
      const named = namedRefs([removed]);
      const kept = named && (await keys.programKeys().catch(() => undefined));
      if (kept)
        await forgetKept(
          keys,
          [...named].filter((ref) => kept.includes(ref)),
        );
    },

    prepare: async (id) => {
      await refresh(id, await linkOf(id));
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
      // The service checked this tool's current declaration and either a
      // persistent grant or the captain's once-only choice before reaching it.
      const link = await linkOf(id);
      let result: CallToolResult;
      try {
        result = (await link.client.callTool({
          name: tool.tool,
          arguments: input as Record<string, unknown>,
        })) as CallToolResult;
      } catch (error) {
        // A key the server refused, or one that could not be renewed, never reached the tool.
        const out = signedOutBy(id, error);
        if (out) throw out;
        if (error instanceof McpConnectError) throw error;
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

    moveKeys,
  };
}

function isAddress(line: string): boolean {
  try {
    return parseRuns(line).kind === "address";
  } catch {
    return false;
  }
}

/** What a server's 401 said about its sign-in (RFC 9728 §5.1). */
function challengeOf(response: Response): McpChallenge {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
}

/** Every kept key's reference the lines name; undefined when a line cannot be read, since it might name any. */
function namedRefs(servers: readonly Pick<McpSavedServer, "runs">[]): Set<string> | undefined {
  const named = new Set<string>();
  for (const server of servers) {
    let runs: McpRuns;
    try {
      runs = parseRuns(server.runs);
    } catch {
      return undefined;
    }
    if (runs.kind === "program") for (const ref of Object.values(runs.keys)) named.add(ref);
  }
  return named;
}

function keptWords(state: UseState, name: string, keys: IntegrationKeys): string {
  switch (state) {
    case "denied":
      return `You did not allow ${name} its keys, so it did not start.`;
    case "cancelled":
      return `${name} did not start: its start was cancelled before it had its keys.`;
    case "expired":
      return `${name} did not start: nobody answered whether it may have its keys.`;
    case "unavailable":
      return keys.shown()
        ? `${name} could not get its keys: Secrets is locked, or a key is no longer there. Unlock Secrets in Settings → Secrets, or remove ${name} and add it again.`
        : `${name} keeps its keys in Secrets, which this computer does not offer, so it cannot start here.`;
    default:
      return `${name} did not start: a key or your decisions changed while it waited. Try again.`;
  }
}

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
  const taken = new Set<string>(lists.resources.length > 0 ? [MCP_READ_RESOURCE] : []);
  const earlier = new Map((before?.tools ?? []).map((tool) => [tool.tool, tool.action]));
  const names = new Map<string, string>();
  for (const tool of lists.tools) {
    const name = earlier.get(tool.name);
    if (name && !taken.has(name)) {
      taken.add(name);
      names.set(tool.name, name);
    }
  }
  for (const tool of lists.tools)
    if (!names.has(tool.name)) names.set(tool.name, actionName(tool.name, taken));
  return {
    tools: lists.tools.map(
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
  return text.length <= length ? text : `…${cutTextEnd(text, length - 1)}`;
}

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${cutText(text, length - 1)}…`;
}

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

/**
 * An id for a new server from its name: `mcp-` and the name's words, never
 * one in use or one `claim` refuses.
 */
function freeId(
  name: string,
  servers: readonly McpSavedServer[],
  claim: (id: string) => boolean = () => true,
): string {
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
  for (let count = 2; taken.has(id) || !claim(id); count++) id = `${base}-${count}`;
  return id;
}

function wordsOf(error: unknown, link?: Link): string {
  if (
    error instanceof McpAddressError ||
    error instanceof McpRunsError ||
    error instanceof McpConnectError ||
    error instanceof McpSignInError
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
