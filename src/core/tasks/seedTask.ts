import type { Reasoning } from "@shared/reasoning";
import type { WorkShape } from "@shared/routingPolicy";
import type { SpawnIntent } from "../orchestrator/intentBrief";
import { mapLegacyStatus } from "../storage/db";
import type { TaskGate, TaskKind, TaskRecord } from "../storage/taskStore";
import type { TaskService } from "./taskService";

/**
 * Test and script fixture seeding: a record in the state the pre-P0 status
 * words described (queued, running, idle, interrupted, completed,
 * cancelled, failed), driven through the one writer so fixtures take the
 * same transitions the app does. Never used by the product.
 *
 * `completed` is a crewmate that finished its work and went idle. Since
 * WI-11 retired the `delivered` status and the `finish` mode, that is not a
 * close: the row stays `active` and idle (its worktree and report intact),
 * resumable until the captain merges, lands, or discards it.
 */

export type LegacyTaskStatus =
  | "queued"
  | "running"
  | "idle"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

export type TaskSeed = {
  id: string;
  title: string;
  prompt?: string;
  kind?: TaskKind;
  repoId?: string | null;
  /** The parent edge - on a review row, the builder it reads. */
  parentId?: string;
  repoDir?: string;
  worktreeDir?: string;
  branch?: string;
  sessionFile?: string | null;
  accountId?: string | null;
  /** The computer that runs work holding its crewmate's conversation; this Mac when absent. */
  deviceId?: string;
  difficulty?: TaskRecord["difficulty"];
  shape?: WorkShape;
  intent?: SpawnIntent;
  gate?: TaskGate | null;
  /** How an open row starts; the one writer's default (when-ready) when absent. */
  startPolicy?: TaskRecord["startPolicy"];
  /** The model a dispatched row was routed to. */
  model?: { provider: string; id: string };
  /** The reasoning its session opened at on that model. */
  reasoning?: Reasoning;
  status: LegacyTaskStatus;
  /** The last report the crewmate gave, when the state implies one. */
  outcome?: string;
  createdAt?: number;
};

export function seedTask(tasks: TaskService, seed: TaskSeed): TaskRecord {
  const worktreeDir = seed.worktreeDir ?? "";
  const mapped = mapLegacyStatus({ status: seed.status, worktree_dir: worktreeDir });
  tasks.create({
    id: seed.id,
    kind: seed.kind ?? "work",
    title: seed.title,
    prompt: seed.prompt ?? "",
    repoId: seed.repoId ?? null,
    ...(seed.parentId ? { parentId: seed.parentId } : {}),
    difficulty: seed.difficulty ?? null,
    shape: seed.shape ?? null,
    intent: seed.intent ?? null,
    gate: seed.gate ?? null,
    ...(seed.startPolicy ? { startPolicy: seed.startPolicy } : {}),
    status: mapped.status === "open" ? "open" : "active",
    actor: "host",
    ...(seed.createdAt !== undefined ? { createdAt: seed.createdAt } : {}),
  });
  if (seed.deviceId) tasks.setDevice(seed.id, seed.deviceId);
  if (seed.status === "queued") return tasks.get(seed.id) as TaskRecord;
  tasks.dispatch(seed.id, {
    workspace: {
      repoDir: seed.repoDir ?? "",
      worktreeDir,
      branch: seed.branch ?? "",
    },
    accountId: seed.accountId ?? null,
    assignee: "crewmate",
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.reasoning ? { reasoning: seed.reasoning } : {}),
  });
  if (seed.sessionFile !== undefined) tasks.setSessionFile(seed.id, seed.sessionFile);
  if (seed.outcome) tasks.recordReport(seed.id, { text: seed.outcome });
  switch (seed.status) {
    case "running":
    case "interrupted":
      tasks.setActivity(seed.id, seed.status);
      break;
    case "idle":
    case "completed":
      // A finished crewmate is idle and resumable, not closed (WI-11).
      tasks.setActivity(seed.id, "idle");
      break;
    case "cancelled":
      tasks.close(seed.id, { status: "dropped", reason: "cancelled", actor: "host" });
      break;
    case "failed":
      tasks.close(seed.id, { status: "dropped", reason: "failed", actor: "host" });
      break;
  }
  return tasks.get(seed.id) as TaskRecord;
}

/** The record's state in the pre-P0 words, for assertions. */
export function legacyStateOf(record: TaskRecord | undefined): string | undefined {
  if (!record) return undefined;
  if (record.status === "open") return "queued";
  if (record.status === "active") return record.activity ?? "active";
  return record.closedReason ?? record.status;
}
