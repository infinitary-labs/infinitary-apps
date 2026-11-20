export interface TaskRecordEvent {
  id: number | string;
  /** Epoch ms; rendered hh:mm 24h local. */
  at: number;
  text: string;
  /** A report's whole text: the line opens to it when it says more than `text`. */
  report?: string;
}

export interface TaskRecordDelivery {
  mode: "direct-pr" | "local-only";
  prUrl?: string;
  ci?: "green" | "red" | "pending" | "no-pr";
  landedMode?: "fast-forward" | "merge" | "pr";
}

export interface TaskRecordData {
  /** One sentence of what done looks like. */
  goal?: string | null;
  /** The captain's words, verbatim - the ask that started the task. */
  userWords?: string | null;
  /** The parent's key. */
  parent?: string | null;
  blockedBy?: string[];
  blocks?: string[];
  children?: { total: number; closed: number };
  /** Oldest first; only the tail renders, with "earlier · N more". */
  events?: TaskRecordEvent[];
  delivery?: TaskRecordDelivery | null;
  /** The crewmate's label, its routed model id, and `repo · branch` - one mono line. */
  assignee?: string | null;
  model?: string | null;
  branch?: string | null;
}

export interface TaskRecordProps {
  record: TaskRecordData;
  /** How many timeline events the tail shows (default 8). */
  timelineTail?: number;
}
