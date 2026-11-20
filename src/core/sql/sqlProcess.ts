import { SqlEngine } from "./sqlEngine";
import type { SqlChildMessage, SqlParentMessage } from "./sqlProtocol";

/**
 * The query process's entry (plugin data surface, Phase B). Its own process,
 * not a worker thread: one native SQLite step cannot be interrupted from
 * JavaScript, so a runaway statement is stopped by killing the process that
 * runs it (./sqlService.ts), which a thread cannot be (captain's decision on
 * the vehicle, 2026-09-24).
 *
 * The same file runs under Electron's `utilityProcess` in the app (reached
 * through `HostCapabilities.sqlProcess`) and under a plain `fork` in tests
 * and a headless core, so it speaks to whichever parent port it was given.
 * The database path arrives in the first message and lives nowhere else.
 */

type Port = {
  send: (message: SqlChildMessage) => void;
  listen: (listener: (message: SqlParentMessage) => void) => void;
};

function parentPort(): Port {
  const electronPort = (
    process as unknown as {
      parentPort?: {
        postMessage: (message: unknown) => void;
        on: (event: "message", listener: (event: { data: unknown }) => void) => void;
      };
    }
  ).parentPort;
  if (electronPort) {
    return {
      send: (message) => electronPort.postMessage(message),
      listen: (listener) =>
        electronPort.on("message", (event) => listener(event.data as SqlParentMessage)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      send: (message) => {
        send(message);
      },
      listen: (listener) =>
        process.on("message", (message) => listener(message as SqlParentMessage)),
    };
  }
  throw new Error("the query process has no parent to answer");
}

const port = parentPort();
let engine: SqlEngine | null = null;

port.listen((message) => {
  if (message.type === "open") {
    try {
      engine = new SqlEngine(message.path);
      port.send({ type: "ready" });
    } catch (error) {
      port.send({
        type: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (!engine) {
    port.send({ type: "error", id: message.id, message: "the query process is not open" });
    return;
  }
  try {
    port.send({ type: "answer", id: message.id, answer: engine.query(message.request) });
  } catch (error) {
    port.send({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
