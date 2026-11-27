import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import * as m from "@shared/i18n/messages.generated";
import { collectorFailureOf, computerRoots } from "../trustedRoots";
import {
  assertCustomApiAddresses,
  type CustomApiDestination,
  type CustomNetworkMode,
  classifyCustomApiAddresses,
  customApiHostname,
  normalizeCustomApiBase,
} from "./customApiPolicy";

/**
 * How every Amazon Bedrock request connects (docs/subscriptions-tab.md,
 * "Amazon Bedrock"). An organization address is read like a custom API's:
 * its network kind comes from every DNS answer when the person approves it,
 * and each new connection resolves the name again and connects only to
 * answers in that kind. Every connection, to AWS's own address too, checks
 * certificates against this computer's trusted list. Nothing here reads a
 * proxy, an AWS endpoint variable or anything else around the app, and
 * Smithy's handlers follow no redirect.
 */

export type BedrockResolver = (hostname: string) => Promise<readonly string[]>;

/** An organization address with the network kind the person approved. */
export type BedrockAddress = CustomApiDestination;

/** Node's error code for an answer outside the approved network kind. */
export const BEDROCK_DESTINATION_REFUSED = "ERR_INFINITARY_BEDROCK_DESTINATION";

export const lookupAll: BedrockResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

/** The words a refused address is shown with, typed so the sign-in throws them as they are. */
export class BedrockAddressError extends Error {}

/** A saved address and kind, or nothing when the pair is not one an approval could have made. */
export function holdBedrockAddress(baseUrl: string, mode: string): BedrockAddress | undefined {
  if (mode !== "local" && mode !== "private" && mode !== "public") return;
  try {
    const address = normalizeCustomApiBase(baseUrl, mode);
    if (address.baseUrl !== baseUrl) return;
    if (address.baseUrl.startsWith("http:") && address.mode !== "local") return;
    return address;
  } catch {
    return;
  }
}

/** Read an address the person typed and the network kind every DNS answer of its name is in. */
export async function readBedrockAddress(
  input: string,
  resolve: BedrockResolver = lookupAll,
): Promise<BedrockAddress> {
  let hostname: string;
  try {
    hostname = customApiHostname(input);
  } catch {
    throw new BedrockAddressError(m.bedrockAddressInvalid());
  }
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new BedrockAddressError(m.bedrockAddressNotFound({ host: hostname }));
  }
  let mode: CustomNetworkMode;
  try {
    mode = classifyCustomApiAddresses(addresses);
  } catch {
    throw new BedrockAddressError(m.bedrockAddressRefused({ host: hostname }));
  }
  let address: BedrockAddress;
  try {
    address = normalizeCustomApiBase(input, mode);
  } catch {
    throw new BedrockAddressError(m.bedrockAddressInvalid());
  }
  if (address.baseUrl.startsWith("http:") && address.mode !== "local")
    throw new BedrockAddressError(m.bedrockAddressPlainHttp());
  return address;
}

/**
 * Resolves the name once per connection and hands the socket only those
 * answers, after every one passed the approved kind: the check and the
 * connection use the same answers.
 */
function heldLookup(mode: CustomNetworkMode, resolve: BedrockResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (answers) => {
        try {
          assertCustomApiAddresses(answers, mode);
        } catch {
          const refused = Object.assign(new Error(`${hostname} left its approved network`), {
            code: BEDROCK_DESTINATION_REFUSED,
          });
          callback(refused, "", 0);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
        const usable = answers
          .map((address) => ({ address, family: isIP(address) }))
          .filter((answer) => !wanted || answer.family === wanted);
        const first = usable[0];
        if (!first) {
          callback(
            Object.assign(new Error(`${hostname} has no usable address`), { code: "ENOTFOUND" }),
            "",
            0,
          );
          return;
        }
        if (options.all) (callback as (error: null, answers: typeof usable) => void)(null, usable);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, "", 0),
    );
  };
}

/** What Pi's scoped Bedrock stream connects with (the pi-ai patch's scoped options). */
export type BedrockConnectionOptions =
  | { httpAgents: { httpAgent?: HttpAgent; httpsAgent?: HttpsAgent } }
  | { http2ConnectOptions: { ca: string[] } };

/**
 * The connection for one request. An organization address goes over
 * HTTP/1.1 through agents that hold its network kind; AWS's own address
 * keeps the client's HTTP/2, with the computer's trusted list. The offline
 * stand-in for AWS is plain http on this computer.
 */
export function bedrockConnection(
  baseUrl: string,
  address: BedrockAddress | undefined,
  resolve: BedrockResolver = lookupAll,
): BedrockConnectionOptions {
  if (address) {
    const lookup = heldLookup(address.mode, resolve);
    return {
      httpAgents: address.baseUrl.startsWith("https:")
        ? { httpsAgent: new HttpsAgent({ ca: computerRoots(), lookup }) }
        : { httpAgent: new HttpAgent({ lookup }) },
    };
  }
  if (baseUrl.startsWith("http:")) return { httpAgents: { httpAgent: new HttpAgent() } };
  return { http2ConnectOptions: { ca: computerRoots() } };
}

/**
 * Why a request got no answer, from the connection code Pi keeps on its
 * Bedrock diagnostic: never made secure, an answer outside the approved
 * network, or never reached. Undefined when the request was answered.
 */
export function bedrockConnectionFailure(message: {
  diagnostics?: readonly { type?: string; details?: Record<string, unknown> }[];
}): "secure-connection" | "destination" | "unreachable" | undefined {
  for (const diagnostic of message.diagnostics ?? []) {
    const code = diagnostic.details?.connectionCode;
    if (diagnostic.type !== "bedrock_response_failure" || typeof code !== "string") continue;
    if (code === BEDROCK_DESTINATION_REFUSED) return "destination";
    return collectorFailureOf({ code });
  }
}
