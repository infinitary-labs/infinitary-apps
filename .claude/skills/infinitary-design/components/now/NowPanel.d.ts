export type NowGroupId = "waiting" | "working" | "queued" | "backlog" | "landed";

export interface NowTask {
  id: string;
  /** `<PROJECT>-<seq>`, e.g. FM3K-12. Hover, search, and the row locator. Not the trailing chrome. */
  key: string;
  /** Project display name; dim mono at the row's end, ellipsized so the title keeps the rest. */
  projectName?: string;
  title: string;
  projectId?: string;
  group: NowGroupId;
  /** StatusDot tone, the crewmate's state in the character's own colors: warn = working · ok = idle crew · danger = interrupted · ring = no crewmate on it. Waiting on you never changes it. */
  tone?: "ok" | "ring" | "warn" | "danger" | "idle";
  /** The one dim word a row may carry: "blocked" or "held". Nothing else. */
  word?: "blocked" | "held";
  /** Indent under the parent row (0-3). */
  depth?: number;
}

export interface NowRowProps {
  task: NowTask;
  /** A pointing gesture: opens the task's record card, or brings its decision card forward. Never a mutation. */
  onOpen?: (task: NowTask) => void;
}

export interface NowGroupProps {
  group: NowGroupId;
  rows: NowTask[];
  /** Only the collapsed-by-default groups (queued, backlog, done · 7d) honour it; waiting and working always show rows. */
  open?: boolean;
  onToggle?: () => void;
  onOpen?: (task: NowTask) => void;
}

export interface NowPanelProps {
  /** The two counts of the header line. */
  counts?: { waiting: number; working: number };
  groups?: Partial<Record<NowGroupId, NowTask[]>>;
  /** Project chips behind the filter affordance; shown only when there is more than one. */
  projects?: { id: string; key: string }[];
  onOpen?: (task: NowTask) => void;
  style?: React.CSSProperties;
}
