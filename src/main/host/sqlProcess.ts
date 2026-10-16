import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

/**
 * The query process behind the `sql` read, as a utility process: a real
 * process the core can kill when a statement runs past its cap (one native
 * SQLite step cannot be interrupted, and the packaged app's run-as-node
 * fuse is off, so Node's own `fork` would start the whole app). The entry
 * is the built `sqlProcess` (src/core/sql/sqlProcess.ts).
 */
export function createSqlProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary Records",
        stdio: "inherit",
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
