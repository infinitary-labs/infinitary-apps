import {
  FileRefusal,
  reasonOf,
  type SetAsideChildMessage,
  type SetAsideParentMessage,
  setAsideFile,
} from "./setAside";

/**
 * The process one file is set aside in (docs/files.md, "How a copy
 * travels"). Its own process, not a worker thread: closing a handle to a
 * file drops every lock its process holds on that file, so the files
 * command's opens and closes happen here, where no lock of the app's is,
 * never in the app's own process (./setAside.ts).
 *
 * The same file runs under Electron's `utilityProcess` in the app (reached
 * through `HostCapabilities.setAsideProcess`) and under a plain `fork` in
 * tests, so it speaks to whichever parent port it was given. It sets one
 * file aside and answers; its parent stops it then.
 */

type Port = {
  send: (message: SetAsideChildMessage) => void;
  listen: (listener: (message: SetAsideParentMessage) => void) => void;
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
        electronPort.on("message", (event) => listener(event.data as SetAsideParentMessage)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      send: (message) => {
        send(message);
      },
      listen: (listener) =>
        process.on("message", (message) => listener(message as SetAsideParentMessage)),
    };
  }
  throw new Error("the process a file is set aside in has no parent to answer");
}

const port = parentPort();

port.listen((message) => {
  if (message.type !== "set-aside") return;
  setAsideFile(message.order).then(
    ({ database }) => port.send({ type: "set", database }),
    (error: unknown) =>
      port.send(
        error instanceof FileRefusal
          ? { type: "refused", words: error.message }
          : { type: "failed", message: reasonOf(error) },
      ),
  );
});
