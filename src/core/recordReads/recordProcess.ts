import Database from "better-sqlite3";
import type { RecordChild, RecordParent } from "./protocol";
import { RecordReadEngine } from "./recordEngine";

/** The same bundled entry runs as an Electron utility process or a Node child in proof. */
const electronPort = (
  process as unknown as {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: "message", listener: (event: { data: RecordParent }) => void): void;
    };
  }
).parentPort;
const send = (message: RecordChild) =>
  electronPort ? electronPort.postMessage(message) : process.send?.(message);
let engine: RecordReadEngine;
function receive(message: RecordParent): void {
  if (message.type === "open") {
    try {
      const db = new Database(message.path, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      engine = new RecordReadEngine(db);
      send({ type: "ready" });
    } catch (error) {
      send({ type: "failed", message: String(error) });
    }
    return;
  }
  for (const answer of engine.batch(message.reads)) send(answer);
}
if (electronPort) electronPort.on("message", (event) => receive(event.data));
else process.on("message", (message) => receive(message as RecordParent));
