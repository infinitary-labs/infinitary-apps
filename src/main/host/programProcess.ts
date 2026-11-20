import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

/**
 * The process that runs one program's script (docs/programs.md "The
 * runner"), as a utility process: a runaway script is stopped by killing
 * it, and the packaged app's run-as-node fuse is off, so Node's own `fork`
 * would start the whole app. The entry is the built `programProcess`
 * (src/core/program/programProcess.ts). Its output goes nowhere: a script
 * reaches the app only through its host functions.
 */
export function createProgramProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary Program",
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
