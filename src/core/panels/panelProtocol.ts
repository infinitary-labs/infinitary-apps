/**
 * The messages between the core's panel runtime owner (./panelRuntimes.ts)
 * and one panel's background process (./panelProcess.ts), docs/personal-panels.md
 * "Background work runs apart". The panel's code reaches the app only
 * through `ask`: each store operation and each query is one ask, answered
 * by the core before the next one is sent (one in flight per process, so a
 * panel that fires a thousand writes queues them in its own process, never
 * in the app's).
 */

/** What the panel's code may ask the core for: its own store slice and its granted query. */
export type PanelAskOp = "store.get" | "store.set" | "store.delete" | "store.list" | "sql";

/** One background task as the process scheduled it, after clamping. */
export type PanelLoadedTask = { id: string; everyMs: number; declaredMs: number };

/** The core to the panel process. */
export type PanelParentMessage =
  | {
      type: "load";
      /** The compiled module's `file:` URL. */
      entryUrl: string;
      /** The panel's id, for its context and its log lines. */
      id: string;
      /** The floor a background cadence is clamped up to. */
      minIntervalMs: number;
      /** How often to beat; the process starts beating before it imports the module. */
      beatMs: number;
      /** The most JSON one message it sends may carry. */
      maxBytes: number;
    }
  | { type: "invoke"; call: number; action: string; input: unknown }
  | { type: "answer"; ask: number; ok: true; value: unknown }
  | { type: "answer"; ask: number; ok: false; message: string };

/** The panel process to the core. */
export type PanelChildMessage =
  /** Sent from the panel's own event loop: a loop stuck in panel code sends none. */
  | { type: "beat" }
  | { type: "loaded"; actions: string[]; background: PanelLoadedTask[] }
  | { type: "failed"; message: string }
  | { type: "result"; call: number; ok: true; value: unknown }
  | { type: "result"; call: number; ok: false; message: string }
  | { type: "ask"; ask: number; op: PanelAskOp; input: unknown[] }
  | { type: "log"; message: string };

/** How often the panel process beats while its event loop is free. */
export const PANEL_BEAT_MS = 250;

/**
 * The most JSON one message may carry either way: twice a whole store
 * slice (`PERSONAL_STORE_MAX_BYTES`), so a full `list` and an action that
 * returns it fit, and nothing a panel sends can make the app hold more.
 */
export const PANEL_MESSAGE_MAX_BYTES = 2 * 1_048_576;
