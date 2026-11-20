import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

/**
 * The process that runs one task command (`infinitary-browser-axi`,
 * docs/axi-commands.md "The channel"), as a utility process: axi-sdk-js
 * writes `process.exitCode`, so it never runs in the app's own process, and
 * the packaged app's run-as-node fuse is off, so Node's own `fork` would
 * start the whole app. The entry is the built `axiProcess`
 * (src/core/axi/axiProcess.ts). Its output goes to its parent alone, never
 * to the app's log: a command's arguments may hold what a crewmate types.
 */
export function createAxiProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary Task Command",
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
