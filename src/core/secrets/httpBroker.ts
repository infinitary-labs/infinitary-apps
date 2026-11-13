import type { BrokerInput, SecretBroker } from "./brokers";
import { canonical, sha256 } from "./custody";

export type HttpCredential = {
  ref: string;
  delivery: { kind: "header"; name: string; prefix?: string } | { kind: "form"; name: string };
};

/**
 * A protocol owner's checked request. Its resolver declares read eligibility:
 * OAuth renewal is not a read, and a remote MCP POST is not automatically a write.
 * The owner retains its network guard, response parser and sole renewer.
 */
export type BoundHttpRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  form?: Record<string, string>;
  credentials: Record<string, HttpCredential>;
  operation: string;
  read: boolean;
  result: string;
};

/**
 * Adapt a trusted owner's guarded HTTP transport, not a general fetch tool.
 * resolve and send are code capabilities supplied at composition, never IPC data.
 * The consumer receives the Response privately and owns token renewal/replacement;
 * no response, header, body or exception crosses the command receipt surface.
 */
export function httpSecretBroker(options: {
  id: string;
  label: string;
  /** The owner spends the app's own sign-in, made in the app (`SecretBroker.signIn`). */
  signIn?: true;
  resolve(input: BrokerInput): BoundHttpRequest | undefined;
  send(url: string, init: RequestInit): Promise<Response>;
}): SecretBroker {
  return {
    id: options.id,
    ...(options.signIn ? { signIn: true as const } : {}),
    async prepare(input) {
      const resolved = options.resolve(structuredClone(input));
      if (!resolved) return undefined;
      const bound = structuredClone(resolved);
      const url = new URL(bound.url);
      if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol))
        return undefined;
      const headers = new Headers(bound.headers);
      const names = new Set<string>();
      const hasForm = Object.values(bound.credentials).some(
        (credential) => credential.delivery.kind === "form",
      );
      if ((bound.form !== undefined || hasForm) && bound.body !== undefined) return undefined;
      for (const { delivery } of Object.values(bound.credentials)) {
        const name = delivery.kind === "header" ? delivery.name.toLowerCase() : delivery.name;
        const key = `${delivery.kind}:${name}`;
        if (!name || names.has(key)) return undefined;
        names.add(key);
        if (delivery.kind === "header") {
          if (
            headers.has(name) ||
            ["host", "content-length", "connection", "transfer-encoding"].includes(name)
          )
            return undefined;
        } else if (Object.hasOwn(bound.form ?? {}, name)) return undefined;
      }
      // Bind the canonical URL and every method/header/body/mapping bit. Only its digest is displayed.
      bound.url = url.href;
      const facts = {
        broker: options.id,
        label: options.label,
        destination: url.origin,
        operation: bound.operation,
        inputDigest: sha256(canonical(bound)),
        read: bound.read,
        result: bound.result,
        secrets: Object.fromEntries(
          Object.entries(bound.credentials).map(([name, credential]) => [name, credential.ref]),
        ),
      };
      return {
        facts,
        async run(values) {
          const sentHeaders = new Headers(headers);
          const form = new URLSearchParams(bound.form);
          for (const [slot, { delivery }] of Object.entries(bound.credentials)) {
            const value = values[slot];
            if (!value) throw new Error("Credential unavailable.");
            if (delivery.kind === "header")
              sentHeaders.set(delivery.name, `${delivery.prefix ?? ""}${value.toString("utf8")}`);
            else form.set(delivery.name, value.toString("utf8"));
          }
          const formBody = bound.form !== undefined || hasForm;
          if (formBody) sentHeaders.set("content-type", "application/x-www-form-urlencoded");
          // No redirects or ambient cookies, even if the owner's transport supports them elsewhere.
          const response = await options.send(bound.url, {
            method: bound.method,
            headers: sentHeaders,
            ...(formBody
              ? { body: form.toString() }
              : bound.body === undefined
                ? {}
                : { body: bound.body }),
            redirect: "error",
            credentials: "omit",
          });
          if (response.redirected) throw new Error("Redirected credential request refused.");
          return response;
        },
      };
    },
  };
}
