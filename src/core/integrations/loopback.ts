import { createServer, type Server } from "node:http";
import * as m from "@shared/i18n/messages.generated";
import { cutText } from "@shared/textCut";

/**
 * The browser's way back to a sign-in an installed app started
 * (docs/integrations.md, "Google" and "MCP servers that sign in"): the app
 * listens on this computer's loopback address, at a port the system picks,
 * and takes the code the browser brings back with this sign-in's state;
 * anything else that reaches the listener is turned away. It closes as soon
 * as the browser answers, or the sign-in ends. PKCE, which ties the code to
 * the app that began the sign-in, is the caller's.
 *
 * The page may open on another computer that controls this first mate: it
 * is told the port, catches the browser's return there and hands it to this
 * listener (src/core/signInReturns.ts), until the sign-in ends.
 */

/** What the browser brought back: the code, and the issuer the place named (RFC 9207). */
export type LoopbackAnswer = { code: string; iss?: string };

/** The listener could not listen, the sign-in ended, or the place sent no code: its words say which. */
export class LoopbackError extends Error {}

export type Loopback = {
  port: number;
  /** Settles once the browser comes back, or the sign-in ends. */
  answered: Promise<LoopbackAnswer>;
  close: () => void;
};

function page(words: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Infinitary</title><body style="font:15px system-ui;margin:3em">${words}</body>`;
}

/**
 * Listen for one sign-in's return at `path`, answered only with `state`;
 * `name` is the place signed in to, as the browser's page and the thrown
 * words name it.
 * `answered` never rejects unhandled: a caller that stops waiting still
 * closes the listener.
 */
export async function listenOnLoopback(options: {
  state: string;
  path: string;
  signal: AbortSignal;
  name: string;
}): Promise<Loopback> {
  const server = createServer();
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  let port: number;
  try {
    port = await listen(server, options.signal, options.name);
  } catch (error) {
    close();
    throw error;
  }
  const answered = waitForCode(server, options);
  // A cancel while the page is still opening is read by the caller, not lost.
  answered.catch(() => {});
  return { port, answered, close };
}

function listen(server: Server, signal: AbortSignal, name: string): Promise<number> {
  const noListen = () => new LoopbackError(`Could not listen on this computer for ${name}.`);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LoopbackError("The sign-in was cancelled."));
      return;
    }
    server.once("error", () => reject(noListen()));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(noListen());
    });
  });
}

/** The code the browser brings back with this sign-in's state; anything else is turned away. */
function waitForCode(
  server: Server,
  options: { state: string; path: string; signal: AbortSignal; name: string },
): Promise<LoopbackAnswer> {
  const { state, path, signal, name } = options;
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new LoopbackError("The sign-in was cancelled."));
    if (signal.aborted) cancelled();
    signal.addEventListener("abort", cancelled, { once: true });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        url.pathname !== path ||
        url.searchParams.get("state") !== state
      ) {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      // i18n-exempt: a media type
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(
        page(
          code
            ? m.integrationsSignInPageSignedIn({ name })
            : m.integrationsSignInPageNotSignedIn({ name }),
        ),
      );
      signal.removeEventListener("abort", cancelled);
      const iss = url.searchParams.get("iss");
      if (code) resolve({ code, ...(iss ? { iss } : {}) });
      else
        reject(
          error === "access_denied"
            ? new LoopbackError(`The sign-in was declined on ${name}'s page.`)
            : new LoopbackError(
                `${name} did not sign in${error ? ` (${cutText(error, 64)})` : ""}.`,
              ),
        );
    });
  });
}
