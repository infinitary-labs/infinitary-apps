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
  | { kind: "placed"; input: PlacedWorkRead };
export type RecordAnswer = TaskSelection | ClosedTaskSearch | PlacedWorkAnswer;
export type RecordParent =
  | { type: "open"; path: string }
  | { type: "batch"; reads: { id: number; request: RecordRead }[] };
export type RecordChild =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "answer"; id: number; answer: RecordAnswer }
  | { type: "error"; id: number; message: string };
