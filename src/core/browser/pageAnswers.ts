import { connect } from "node:net";
import { isLoopbackHost, originKey } from "./destinations";

/**
 * Whether anything answers at a loopback address a task's page is on
 * (docs/task-browser.md, "When nothing answers"): the host's own
 * connection attempt to that port, never anything the page says. A refused
 * connection is the one typed fact; a timeout or any other failure is
 * unknown and changes nothing.
 */
export type AnswerReading = "answered" | "refused" | "unknown";

/** Tries a connection to a loopback host and port, as the computer that runs the browser. */
export type AnswerProbe = (host: string, port: number) => Promise<AnswerReading>;

/**
 * How long the attempt may take before it reads as unknown: a loopback
 * port that nothing listens on refuses at once, so this bounds only a port
 * that accepts slowly.
 */
const ANSWER_WAIT_MS = 2_000;

export const probeLoopback: AnswerProbe = (host, port) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (reading: AnswerReading) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reading);
    };
    const socket = connect({ host, port });
    socket.setTimeout(ANSWER_WAIT_MS, () => done("unknown"));
    socket.once("connect", () => done("answered"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" ? "refused" : "unknown"),
    );
  });

/** A page's loopback address to try: its origin's key, host and port; none for any other address. */
export type AnswerTarget = { origin: string; host: string; port: number };

export function answerTarget(address: string): AnswerTarget | undefined {
  const url = URL.parse(address);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  if (!isLoopbackHost(url.hostname)) return undefined;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { origin: originKey(url), host: url.hostname.replace(/^\[|\]$/g, ""), port };
}
