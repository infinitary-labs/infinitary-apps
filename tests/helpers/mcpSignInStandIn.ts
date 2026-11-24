import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type NotesHttpServer, type StandInEra, serveNotesHttp } from "./mcpStandIn";

/**
 * A stand-in MCP server that asks for a sign-in, for the sign-in's tests
 * (docs/integrations.md, "MCP servers that sign in"): the notes server of
 * `mcpStandIn.ts`, which answers 401 without a key it issued, and its
 * sign-in at another address, the way the MCP authorization rules describe
 * one - its documents (RFC 9728, RFC 8414), registration (RFC 7591), a
 * sign-in page that answers at once as the person would, PKCE (S256), the
 * token address with renewal, revocation (RFC 7009) and the issuer on the
 * way back (RFC 9207).
 *
 * `browse` stands in for the person's browser: it opens the page the app
 * opened and follows the sign-in's answer back to the app.
 */

export type SignInStandInOptions = {
  /** The sign-in lets apps register themselves; false is one that needs an app of the person's own. */
  register?: boolean;
  /** Each renewal hands a new lasting key and ends the one before. */
  rotate?: boolean;
  /** Seconds an access key lasts. */
  lifetime?: number;
};

type Client = { id: string; redirects: string[] };
type Code = {
  client: string;
  redirect: string;
  challenge: string;
  resource?: string;
  scope?: string;
};

export type SignInStandIn = {
  notes: NotesHttpServer;
  /** The server's address, as a person adds it. */
  url: string;
  /** The sign-in's own address, another than the server's. */
  issuer: string;
  /** Every client that registered, by id. */
  clients: Map<string, Client>;
  /** Each renewal's lasting key, in order. */
  renewals: string[];
  /** Every token revoked, in order. */
  revoked: string[];
  /** The access keys the server still takes. */
  access: Set<string>;
  /** The lasting keys the sign-in still renews. */
  lasting: Set<string>;
  /** The person's browser: open the page, answer it as the person would, and follow the way back. */
  browse: (page: string, answer?: "approve" | "decline") => Promise<string>;
  /** Every access key ends, as when they run out early. */
  expireAccess: () => void;
  /** Every key ends there, as when the person signs out on the service's own site. */
  signOutThere: () => void;
  close: () => Promise<void>;
};

const SCOPE = "notes:read notes:write";

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function json(reply: ServerResponse, status: number, body: unknown) {
  reply.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  reply.end(JSON.stringify(body));
}

export async function serveSignInNotes(
  era: StandInEra,
  options: SignInStandInOptions = {},
): Promise<SignInStandIn> {
  const clients = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const access = new Set<string>();
  const lasting = new Set<string>();
  const renewals: string[] = [];
  const revoked: string[] = [];
  const token = () => randomBytes(18).toString("base64url");
  let notesOrigin = "";
  let issuer = "";

  const issue = (code: Pick<Code, "scope">, refresh?: string) => {
    const accessToken = token();
    access.add(accessToken);
    let refreshToken = refresh;
    if (!refreshToken || options.rotate) {
      if (refreshToken) lasting.delete(refreshToken);
      refreshToken = token();
      lasting.add(refreshToken);
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: options.lifetime ?? 3600,
      ...(refresh && !options.rotate ? {} : { refresh_token: refreshToken }),
      ...(code.scope ? { scope: code.scope } : {}),
    };
  };

  const signIn = createServer((request, reply) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer);
      const raw = request.method === "POST" ? await read(request) : "";
      const body = new URLSearchParams(raw);
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        json(reply, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          revocation_endpoint: `${issuer}/revoke`,
          ...(options.register === false ? {} : { registration_endpoint: `${issuer}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/register" && options.register !== false) {
        const asked = JSON.parse(raw) as { redirect_uris?: unknown };
        const redirects = Array.isArray(asked.redirect_uris)
          ? asked.redirect_uris.filter((entry): entry is string => typeof entry === "string")
          : [];
        if (redirects.length === 0) {
          json(reply, 400, { error: "invalid_redirect_uri" });
          return;
        }
        const id = `client-${clients.size + 1}`;
        clients.set(id, { id, redirects });
        json(reply, 201, {
          client_id: id,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: redirects,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/authorize") {
        const client = clients.get(url.searchParams.get("client_id") ?? "");
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        if (
          !client?.redirects.includes(redirect) ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !url.searchParams.get("code_challenge") ||
          !url.searchParams.get("state")
        ) {
          reply.writeHead(400).end("Bad sign-in request");
          return;
        }
        const back = new URL(redirect);
        back.searchParams.set("state", url.searchParams.get("state") as string);
        back.searchParams.set("iss", issuer);
        if (url.searchParams.get("answer") === "decline")
          back.searchParams.set("error", "access_denied");
        else {
          const code = token();
          const resource = url.searchParams.get("resource");
          const scope = url.searchParams.get("scope");
          codes.set(code, {
            client: client.id,
            redirect,
            challenge: url.searchParams.get("code_challenge") as string,
            ...(resource ? { resource } : {}),
            ...(scope ? { scope } : {}),
          });
          back.searchParams.set("code", code);
        }
        reply.writeHead(302, { location: back.href }).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        const client = body.get("client_id") ?? "";
        if (!clients.has(client)) {
          json(reply, 401, { error: "invalid_client" });
          return;
        }
        if (body.get("grant_type") === "authorization_code") {
          const code = codes.get(body.get("code") ?? "");
          codes.delete(body.get("code") ?? "");
          const verifier = body.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            !code ||
            code.client !== client ||
            code.redirect !== body.get("redirect_uri") ||
            code.challenge !== challenge ||
            (code.resource ?? null) !== body.get("resource")
          ) {
            json(reply, 400, { error: "invalid_grant" });
            return;
          }
          json(reply, 200, issue(code));
          return;
        }
        if (body.get("grant_type") === "refresh_token") {
          const refresh = body.get("refresh_token") ?? "";
          if (!lasting.has(refresh) || body.get("resource") !== `${notesOrigin}/mcp`) {
            json(reply, 400, { error: "invalid_grant" });
            return;
          }
          renewals.push(refresh);
          json(reply, 200, issue({ scope: SCOPE }, refresh));
          return;
        }
        json(reply, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        const revoking = body.get("token") ?? "";
        revoked.push(revoking);
        access.delete(revoking);
        lasting.delete(revoking);
        reply.writeHead(200).end();
        return;
      }
      reply.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => signIn.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(signIn.address() as AddressInfo).port}`;

  const notes = await serveNotesHttp(era, undefined, (request, reply) => {
    const url = new URL(request.url ?? "/", notesOrigin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(reply, 200, {
        resource: `${notesOrigin}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: SCOPE.split(" "),
      });
      return true;
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (bearer && access.has(bearer)) return false;
    reply.writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${notesOrigin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
    });
    reply.end();
    return true;
  });
  notesOrigin = new URL(notes.url).origin;

  return {
    notes,
    url: notes.url,
    issuer,
    clients,
    renewals,
    revoked,
    access,
    lasting,
    browse: async (page, answer = "approve") => {
      const opened = new URL(page);
      if (answer === "decline") opened.searchParams.set("answer", "decline");
      const consent = await fetch(opened, { redirect: "manual" });
      const back = consent.headers.get("location");
      if (!back) throw new Error(`The sign-in page answered ${consent.status}.`);
      return (await fetch(back)).text();
    },
    expireAccess: () => access.clear(),
    signOutThere: () => {
      access.clear();
      lasting.clear();
    },
    close: async () => {
      await notes.close();
      signIn.closeAllConnections();
      await new Promise<void>((resolve) => signIn.close(() => resolve()));
    },
  };
}
