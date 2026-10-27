import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** INF-1541 piece 4 (the captain's "the mac will always be busy"): a local heavy
 * run takes a crew place in the Mac mini's one budget instead of piling on top of
 * its checks. The client of dotfiles-private's fm-placer crew socket (DOP-112).
 * The service owns what each kind costs; this side names only what runs.
 */
export type CrewPlaceKind = "phone" | "journeys";
export type CrewPlace = { place: string | undefined; close(): void };

type Reply = { state?: unknown; ahead?: unknown; reason?: unknown; place?: unknown };
type Answer = { granted: string } | { gone: true };

/** Where the service listens, under the account's real home like phone activity. */
export function crewPlaceSocket(env: NodeJS.ProcessEnv, realHome = userInfo().homedir): string {
  return env.INFINITARY_CREW_PLACE_SOCKET || join(realHome, "Library", "Caches", "infinitary-ci", "crew-places.sock");
}

const NO_SERVICE = new Set(["ENOENT", "ECONNREFUSED"]);

function open(path: string): Promise<Socket | undefined> {
  // A missing socket is no service, whatever the path's length would make connect say.
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((done, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      done(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code && NO_SERVICE.has(error.code)) done(undefined);
      else reject(new Error(`The crew place service at ${path} could not be reached: ${error.message}`));
    });
  });
}

/** Sends the request and reads the line until granted, or until the service goes away. */
function ask(socket: Socket, request: object, log: (line: string) => void): Promise<Answer> {
  return new Promise((done, reject) => {
    let settled = false;
    const settle = (answer: Answer | Error) => {
      if (settled) return;
      settled = true;
      lines.close();
      if (answer instanceof Error) {
        socket.destroy();
        reject(answer);
      } else done(answer);
    };
    const lines = createInterface({ input: socket });
    lines.on("line", (text) => {
      let reply: Reply;
      try {
        reply = JSON.parse(text) as Reply;
      } catch {
        return settle(new Error(`The crew place service answered something unreadable: ${text.slice(0, 200)}`));
      }
      if (reply.state === "waiting") {
        const ahead = typeof reply.ahead === "number" ? reply.ahead : "?";
        log(`Waiting in line for a crew place: ${ahead} ahead${typeof reply.reason === "string" && reply.reason ? ` (${reply.reason})` : ""}.`);
      } else if (reply.state === "granted" && typeof reply.place === "string") {
        settle({ granted: reply.place });
      } else if (reply.state === "refused") {
        settle(new Error(`The crew place service refused this run: ${String(reply.reason)}`));
      } else {
        settle(new Error(`The crew place service answered something unreadable: ${text.slice(0, 200)}`));
      }
    });
    socket.once("error", () => settle({ gone: true }));
    socket.once("close", () => settle({ gone: true }));
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

/** A wait in line keeps the process alive; a granted run's own work keeps it alive for the resume waits. */
const sleep = (ms: number, keepAlive: boolean) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    if (!keepAlive) timer.unref();
  });

/** Waits for a crew place and holds it until close() or this process ends.
 * In CI the job already holds a runner place; with no service here the run
 * starts at once. Both answer with no place.
 */
export async function takeCrewPlace(
  kind: CrewPlaceKind,
  label: string,
  options: { env?: NodeJS.ProcessEnv; realHome?: string; log?: (line: string) => void; resumeEveryMs?: number } = {},
): Promise<CrewPlace> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const unheld = { place: undefined, close() {} };
  if (env.CI) return unheld;
  const path = crewPlaceSocket(env, options.realHome);
  const request = (resume: boolean) => ({ schemaVersion: 1, kind, label: label.replace(/\s+/g, " ").trim().slice(0, 500), pid: process.pid, resume });

  let socket: Socket | undefined;
  let place: string | undefined;
  // One reconnect when the service goes away before granting, as it does on a restart.
  for (let attempt = 0; attempt < 2 && !place; attempt++) {
    if (attempt > 0) await sleep(1_000, true);
    socket = await open(path);
    if (!socket) break;
    const answer = await ask(socket, request(false), log);
    if ("granted" in answer) place = answer.granted;
  }
  if (!place || !socket) {
    log("No crew place service answers on this computer; starting at once.");
    return unheld;
  }
  log(`Holding crew place ${place} for this run.`);

  let closed = false;
  let held: Socket = socket;
  // A granted place lasts as long as the connection. If the service restarts,
  // this run is already going: ask it to count the run again at once.
  const keep = (current: Socket) => {
    current.unref();
    current.once("close", async () => {
      while (!closed) {
        await sleep(options.resumeEveryMs ?? 5_000, false);
        if (closed) return;
        const next = await open(path).catch(() => undefined);
        if (!next) continue;
        const answer = await ask(next, request(true), () => {}).catch(() => ({ gone: true }) as const);
        if ("granted" in answer) {
          if (closed) next.destroy();
          else {
            held = next;
            keep(next);
          }
          return;
        }
      }
    });
  };
  keep(socket);
  return {
    place,
    close() {
      closed = true;
      held.destroy();
    },
  };
}
