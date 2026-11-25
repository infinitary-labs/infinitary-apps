import type {
  UsageQuery,
  UsageSummary,
  UsageTaskCosts,
  UsageTaskCostsQuery,
  UsageTasks,
  UsageTasksQuery,
} from "@shared/usage";
import type { PlacedWorkAnswer, PlacedWorkRead } from "../routing/placedWork";
import type {
  ClosedTaskSearch,
  ClosedTaskSearchInput,
  TaskSelection,
  TaskSelectionInput,
} from "../storage/taskSelection";

export type RecordRead =
  | { kind: "tasks"; input: TaskSelectionInput }
  | { kind: "closed"; input: ClosedTaskSearchInput }
  | { kind: "placed"; input: PlacedWorkRead }
  | { kind: "usageSummary"; input: { query: UsageQuery; now: number } }
  | { kind: "usageTasks"; input: { query: UsageTasksQuery; now: number } }
  | { kind: "usageTaskCosts"; input: { query: UsageTaskCostsQuery; now: number } };
export type RecordAnswer =
  | TaskSelection
  | ClosedTaskSearch
  | PlacedWorkAnswer
  | UsageSummary
  | UsageTasks
  | UsageTaskCosts;
export type RecordParent =
  | { type: "open"; path: string }
  | { type: "batch"; reads: { id: number; request: RecordRead }[] };
export type RecordChild =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "answer"; id: number; answer: RecordAnswer }
  | { type: "error"; id: number; message: string };
