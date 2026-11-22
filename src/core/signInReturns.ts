import { randomBytes } from "node:crypto";
import type { FoldedInto16 } from "@shared/contractFeatures";

/**
 * A sign-in's return from another computer (docs/view.md, "A sign-in that
 * returns to the first mate's computer").
 *
 * A provider that sends the browser back to the first mate's own loopback
 * address, as Google's sign-in for an installed app does, cannot finish in
 * a browser on another computer: that address reaches nothing there. So the
 * computer the person is at listens on the same port of its own loopback
 * address and passes along what the browser brought back, or the address it
 * ended on, and this hands it to the port the waiting sign-in opened here.
 *
 * Only that port is reached, only with GET, and only until one return was
 * taken or the sign-in ended: anything else is refused. What crosses is the
 * one-time code and the sign-in's state, useless without the check the
 * sign-in keeps here.
 */

/**
 * What both computers have before a return may cross: major 16 folded it in,
 * and a side on major 15 lists it by this name (`hasSince16`).
 */
export const SIGN_IN_RETURN = "sign-in-return" satisfies FoldedInto16;

export type SignInReturnAnswer = { status: number; page: string };

export type SignInReturnTo = {
  /** The port of this computer's loopback address the sign-in listens on. */
  port: number;
  /** Aborts once the sign-in stops waiting, whatever ended it. */
  ended: AbortSignal;
};

/** How long the waiting sign-in may take to answer the return it was handed. */
export const SIGN_IN_RETURN_TIMEOUT_MS = 10_000;

/**
 * The bytes of the waiting sign-in's page passed back, which are a line of
 * words; a longer answer is not a sign-in's page.
 */
const PAGE_BYTES = 16 * 1024;

export const SIGN_IN_RETURN_WORDS = {
  gone: "That sign-in is no longer waiting. Start it again.",
  notAnAddress:
    "That is not the address your browser ended on. Copy the whole address from the page that could not be reached.",
  unanswered: "The sign-in did not answer. Start it again.",
  /** The home's refusal to a computer without this change, shown on that computer. */
  updateHere:
    "Update Infinitary on this computer to sign in from it. The first mate's computer already can.",
} as const;

/** The waiting sign-ins another computer may hand a return to, by return id. */
export class SignInReturns {
  private readonly waiting = new Map<string, number>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  open(to: SignInReturnTo): string {
    const id = randomBytes(16).toString("base64url");
    if (to.ended.aborted) return id;
    this.waiting.set(id, to.port);
    to.ended.addEventListener("abort", () => this.waiting.delete(id), { once: true });
    return id;
  }

  waits(id: string): boolean {
    return this.waiting.has(id);
  }

  /**
   * Hands what the browser brought back - its path, or the whole address it
   * ended on - to the waiting sign-in's own port, and answers what that
   * sign-in said. One answered with 200 took the return: the id is spent.
   */
  async deliver(id: string, address: string): Promise<SignInReturnAnswer> {
    const port = this.waiting.get(id);
    if (port === undefined) throw new Error(SIGN_IN_RETURN_WORDS.gone);
    const path = returnPath(address);
    let response: Response;
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(SIGN_IN_RETURN_TIMEOUT_MS),
      });
    } catch {
      throw new Error(SIGN_IN_RETURN_WORDS.unanswered);
    }
    const bytes = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const page = bytes.subarray(0, PAGE_BYTES).toString("utf8");
    if (response.status === 200) this.waiting.delete(id);
    return { status: response.status, page };
  }
}

/**
 * The path and query a return carries: a path as the browser asked it, or
 * the path of a pasted address on this computer's loopback address. The
 * host and port are never taken from it.
 */
export function returnPath(address: string): string {
  const said = address.trim();
  if (said.startsWith("/") && !said.startsWith("//")) {
    const url = new URL(said, "http://127.0.0.1");
    return `${url.pathname}${url.search}`;
  }
  let url: URL;
  try {
    url = new URL(said);
  } catch {
    throw new Error(SIGN_IN_RETURN_WORDS.notAnAddress);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(SIGN_IN_RETURN_WORDS.notAnAddress);
  return `${url.pathname}${url.search}`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
