/**
 * @startingPoint section="Devices" subtitle="A device in Your devices: this computer, another computer, or running as another user" viewport="760x420"
 */
export interface MachineRowProps {
  /** The device's own name, e.g. "Mac mini", or "This computer", or "Running as Builder". */
  name?: string;
  /** The mono line, e.g. "a computer · joined today 15:02 · seen just now". */
  detail?: string;
  /** e.g. "Runs website and api · Signed in to Codex, Claude and GitHub". */
  summary?: string;
  /** The mono state on the right, e.g. "1 task", "idle", "out of reach". */
  state?: string;
  /** ok while it answers, warn while it is out of reach, idle while it is being set up. */
  tone?: "ok" | "warn" | "idle";
  /** The state is work in flight, drawn in the accent. */
  busy?: boolean;
  /** A trailing control, e.g. the Remove button. */
  action?: React.ReactNode;
  style?: React.CSSProperties;
}
