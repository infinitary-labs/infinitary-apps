import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

/**
 * The process one file the files command copies is set aside in, as a
 * utility process: closing a handle to a file drops every lock its process
 * holds on that file, so the copy's opens and closes never happen in the
 * app's own process, whose SQLite holds locks on its record
 * (src/core/files/setAside.ts). The packaged app's run-as-node fuse is off,
 * so Node's own `fork` would start the whole app. The entry is the built
 * `setAsideProcess` (src/core/files/setAsideProcess.ts). Its output goes
 * nowhere: nothing reads a copied file's content into a log.
 */
export function createSetAsideProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary File Copy",
        stdio: "ignore",
      });
      let exited = false;
      const exitListeners: ((code: number | null) => void)[] = [];
      child.once("exit", (code) => {
        exited = true;
        for (const listener of exitListeners) listener(code);
      });
      return {
        get pid() {
          return child.pid;
        },
        postMessage: (message) => {
          if (!exited) child.postMessage(message);
        },
        onMessage: (listener) => child.on("message", listener),
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        kill: () => {
          if (!exited) child.kill();
        },
      };
    },
  };
}
