import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

/**
 * The process that runs one panel's background module (INF-2205 piece B,
 * docs/personal-panels.md "Background work runs apart"), as a utility
 * process: a panel whose code holds its loop is stopped by killing it, and
 * the packaged app's run-as-node fuse is off, so Node's own `fork` would
 * start the whole app. The entry is the built `panelProcess`
 * (src/core/panels/panelProcess.ts). Its output goes nowhere: a panel's
 * lines reach the app's log through `context.log`.
 */
export function createPanelProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary Panel",
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
