import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appPathsFor } from "../../src/core/paths.ts";
import { crewmateSessionSpec } from "../../src/core/orchestrator/crewSession.ts";
import { firstmateContractStamp, seatSessionSpec } from "../../src/core/orchestrator/seat.ts";
import { renderBasisSection } from "../../src/core/orchestrator/intentBrief.ts";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/session.ts";
import type { ModelRuntime } from "../../src/core/pi/types.ts";
import type { ToolOutput } from "../../src/core/session/tools.ts";
import type {
  ModelSession,
  SessionBinding,
  SessionFactory,
  SessionSpec,
} from "../../src/core/session/session.ts";
import { CardStore } from "../../src/core/storage/cardStore.ts";
import { openInMemoryDatabase } from "../../src/core/storage/db.ts";
import { InboxStore } from "../../src/core/storage/inboxStore.ts";
import { SettingsStore } from "../../src/core/storage/settingsStore.ts";
import { seedTask } from "../../src/core/tasks/seedTask.ts";
import { TaskService } from "../../src/core/tasks/taskService.ts";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry.ts";
import { isolatedWorkspace, wireIsolatedHost } from "../replay/isolatedHost.ts";
import type { ApprovalCase, EvalRun } from "./approvalHandoff.ts";

export function canonicalPath(dir: string): string {
  const absolute = resolve(dir);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, absolute));
}
export function refuseOverlap(dir: string, protectedDirs: readonly string[]): void {
  const inside = (a: string, b: string) => {
    const rel = relative(canonicalPath(a), canonicalPath(b));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (protectedDirs.some((root) => inside(root, dir) || inside(dir, root)))
    throw new Error("Evaluation state overlaps an app profile");
}

/** No provider, transcript or filesystem work; crew dispatch is only recorded. */
export function inertSession(): ModelSession {
  return {
    sessionId: randomUUID(),
    controlProfile: PI_CONTROL_PROFILE,
    resume: () => undefined,
    recordPath: () => undefined,
    modelRef: () => undefined,
    modelLabel: () => undefined,
    isStreaming: () => false,
    subscribe: () => () => {},
    prompt: async () => {},
    steer: async () => {},
    takeUndeliveredSteers: () => [],
    setThinkingLevel: () => {},
    reasoning: () => undefined,
    serveInstructions: () => {},
    takeRenewal: () => undefined,
    servedState: () => undefined,
    abort: async () => {},
    detach: async () => {},
    dispose: () => {},
    closed: async () => {},
  };
}

export async function approvalHost(
  test: ApprovalCase,
  dir: string,
  model: { provider: string; id: string },
  protectedDirs: readonly string[],
) {
  refuseOverlap(dir, protectedDirs);
  const paths = appPathsFor(dir);
  mkdirSync(paths.firstmateHomeDir, { recursive: true });
  mkdirSync(paths.defaultWorkspaceDir, { recursive: true });
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db });
  const cards = new CardStore(db);
  const settings = new SettingsStore(db);
  const inbox = new InboxStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const ids = Object.fromEntries(Object.keys(test.tasks).map((alias) => [alias, randomUUID()]));
  const aliases = Object.fromEntries(Object.entries(ids).map(([alias, id]) => [id, alias]));
  for (const [alias, task] of Object.entries(test.tasks)) {
    seedTask(tasks, {
      id: ids[alias]!,
      title: task.title,
      parentId: task.parent ? ids[task.parent] : undefined,
      status:
        task.status === "active" &&
        !task.availableOwner &&
        !(test.role === "builder" && alias === "BUILD")
          ? "idle"
          : "queued",
      startPolicy: task.start_policy ?? "on-request",
      shape: {
        kind: alias === "PLAN" ? "plan" : "implement",
        autonomy_ask: false,
        ...(task.basis ? { basis: ids[task.basis] } : {}),
        ...(task.internalStep
          ? { internal_step: true, deliverable: "answer", kind: "reproduce" }
          : {}),
      },
      prompt: task.outcome ?? task.title,
    });
    aliases[tasks.get(ids[alias]!)!.key] = alias;
    if (task.outcome) tasks.recordReport(ids[alias]!, { text: task.outcome });
    if (task.status === "done")
      tasks.close(ids[alias]!, { status: "done", reason: "answered", actor: "host" });
    if (task.resolution) {
      const cardId = `card-${randomUUID()}`;
      cards.upsert({
        id: cardId,
        taskId: ids[alias],
        author: "crewmate",
        priority: 0,
        title: task.title,
        meta: "evaluation",
        body: task.resolution.offer.body,
        actions: task.resolution.offer.actions,
        status: "ready",
        createdAt: Date.now(),
        ...(task.resolution.offer.designOnly ? { designOnly: true as const } : {}),
      });
      cards.resolve(cardId, task.resolution.action, task.resolution.answers);
    }
  }
  let threadContext = "";
  if (test.firstmateThread) {
    const id = "evaluation-risk-chart";
    cards.upsert({
      id,
      author: "firstmate",
      priority: 0,
      title: test.firstmateThread.title,
      meta: "evaluation",
      body: test.firstmateThread.body,
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
    cards.appendMessage({ cardId: id, who: "captain", text: test.firstmateThread.reply });
    threadContext = `\nYour open card: ${id}, ${test.firstmateThread.title}. Captain reply: ${test.firstmateThread.reply}`;
  }
  settings.setFirstmateModel(model);
  let captured: SessionSpec | undefined;
  let reviewSpec: SessionSpec | undefined;
  const starts: string[] = [];
  const steered: string[] = [];
  const stubBinding = { backend: "pi" as const, runtime: {} as ModelRuntime };
  const presetBinding: SessionBinding =
    model.provider === "anthropic-claude"
      ? { backend: "claude", accountId: "evaluation" }
      : stubBinding;
  const crewFactory: SessionFactory = {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) => {
      starts.push(aliases[spec.owner] ?? spec.owner);
      const session = inertSession();
      session.steer = async () => {
        steered.push(aliases[spec.owner] ?? spec.owner);
      };
      session.prompt = async () => {
        steered.push(aliases[spec.owner] ?? spec.owner);
      };
      return session;
    },
  };
  const seatFactory: SessionFactory = {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) => {
      captured = spec;
      return inertSession();
    },
  };
  const host = wireIsolatedHost(
    {
      sessions: { pi: crewFactory },
      bind: async () => stubBinding,
      sessionSpec: (spec) => {
        // Task folders sit under the scratch directory, which differs per
        // preparation; fixed stand-ins keep the instructions' hash stable.
        reviewSpec = crewmateSessionSpec(
          paths,
          {
            ...spec,
            evidenceDir: "/evaluation/evidence",
            cardBodiesDir: "/evaluation/card-bodies",
            tempDir: "/evaluation/temp",
          },
          presetBinding,
        );
        return reviewSpec;
      },
      workspace: isolatedWorkspace(paths),
      repos,
      tasks,
      cardStore: cards,
      inbox,
      paths,
      mergePullRequest: async () => ({ ok: false, text: "Evaluation never merges" }),
      broadcastEvent: () => {},
      broadcastCards: () => {},
      // A stand-in for the personal workspace: a registered `personal` repo and
      // inert hooks, so a personal-ui start binds and opens the inert crew session.
      personal: {
        workspaceDir: paths.defaultWorkspaceDir,
        repo: () => repos.ensurePersonal(paths.defaultWorkspaceDir),
        surfaces: () => [],
        beginLiveTask: () => {},
        endLiveTask: () => {},
        commitTurn: async () => ({ committed: false, touched: [], findings: [] }),
        lint: async () => "Evaluation has no panels to check",
        capture: async (input) => ({
          ok: false,
          id: input.id,
          reason: "Evaluation has no panels to capture",
        }),
      },
    },
    {
      paths,
      inbox,
      settings,
      modelRuntime: stubBinding.runtime,
      availableModels: () => [model],
      quotaModels: () => undefined,
      quotaLine: () => "evaluation",
      repos,
      tasks,
      broadcastEvent: () => {},
      locateProject: () => "Project discovery disconnected in evaluations",
      selfSourceDir: join(dir, "self-source"),
      seats: { pi: seatFactory },
      coalesceMs: 0,
    },
  );
  await host.firstmate.converse("Prepare isolated evaluation");
  if (!captured) throw new Error("Production seat did not open");
  let spec = seatSessionSpec({
    paths,
    binding: presetBinding,
    model,
    tools: captured.tools,
    instructions: captured.instructions.served,
  });
  if (test.role === "builder") {
    // Dispatch opens only the inert crew factory, preserving the production callbacks/preset.
    const build = tasks.get(ids.BUILD!)!;
    await host.supervisor.startQueuedNow(build.id);
    if (!reviewSpec) throw new Error("Production builder preset did not open");
    spec = reviewSpec;
    const plan = test.tasks.PLAN!;
    spec.instructions.base += `\n\n${renderBasisSection({
      key: "PLAN",
      title: plan.title,
      outcome: plan.outcome,
      card: plan.resolution?.offer.body,
      choice: plan.resolution?.action,
      answers: plan.resolution?.answers.map((a) => `- ${a.name}: ${a.values.join(", ")}`),
    })}\nTask autonomy: false. No captain merge authorization.`;
  }
  for (const [alias, task] of Object.entries(test.tasks)) {
    if (task.availableOwner) await host.supervisor.startQueuedNow(ids[alias]!);
  }
  // Setup is not an evaluation effect.
  if (Object.values(test.tasks).some((task) => task.availableOwner)) starts.length = 0;
  steered.length = 0;
  // Fictional aliases in the prompt map to fresh task ids; the host never resolves real records.
  const prompt = `${test.context}${threadContext}\n\nIsolated records (use task_id in tool calls):\n${JSON.stringify(
    Object.fromEntries(
      Object.entries(test.tasks).map(([alias, task]) => [
        alias,
        {
          ...task,
          task_id: ids[alias],
          basis: task.basis ? ids[task.basis] : undefined,
          parent: task.parent ? ids[task.parent] : undefined,
        },
      ]),
    ),
    null,
    2,
  )}`;
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return aliases[value] ?? value;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
  };
  const allowed =
    test.role === "firstmate"
      ? [
          "create_task",
          "update_task",
          "link_tasks",
          "tasks",
          "spawn_crewmate",
          "steer_crewmate",
          "interrupt_crewmate",
          "crew_status",
          "settle_task",
          "emit_card",
          "close_card",
        ]
      : ["tasks", "report", "note_progress", "emit_card", "close_card"];
  const refs = new Set(["task", "task_id", "key", "basis", "parent", "from", "to", "blocked_by"]);
  const actualArgs = (raw: unknown): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
        key,
        refs.has(key)
          ? typeof value === "string"
            ? (ids[value] ?? value)
            : Array.isArray(value)
              ? value.map((ref) => ids[String(ref)] ?? ref)
              : value
          : value,
      ]),
    );
  const tools = spec.tools
    .filter((tool) => allowed.includes(tool.name))
    .map((tool) => ({
      ...tool,
      run: (args: unknown) => tool.run(actualArgs(args)),
    }));
  if (test.role === "firstmate" && spec.shape.turns === "rolling")
    spec.shape.record.stamp = firstmateContractStamp(tools);
  let observedStarts = starts.length;
  // A basis may be stored as a key or an id; compare the tasks they name, never the strings.
  const taskRef = (value: unknown): string | null => {
    const ref = String(value ?? "").trim();
    return ref ? (tasks.resolve(ref)?.id ?? ref) : null;
  };
  return {
    effect: (name: string, raw: unknown, output: ToolOutput): "success" | "refused" => {
      const args = actualArgs(raw);
      if (output.details?.refusal) return "refused";
      if (name === "update_task") {
        const task = tasks.resolve(String(args.task));
        if (!task) return "refused";
        if (args.start_now === true) {
          const ran = starts.length > observedStarts;
          observedStarts = starts.length;
          return ran && task.status === "active" ? "success" : "refused";
        }
        if (args.basis !== undefined && taskRef(task.shape?.basis) !== taskRef(args.basis))
          return "refused";
        if (args.title !== undefined && task.title !== String(args.title).trim().slice(0, 64))
          return "refused";
        if (args.goal !== undefined && task.goal !== (String(args.goal).trim() || null))
          return "refused";
        if (args.priority !== undefined && task.priority !== args.priority) return "refused";
        if (args.start_policy !== undefined && task.startPolicy !== args.start_policy)
          return "refused";
        if (
          args.parent !== undefined &&
          task.parentId !==
            (String(args.parent).trim() ? tasks.resolve(String(args.parent))?.id : null)
        )
          return "refused";
        if (
          args.project !== undefined &&
          task.projectId !==
            (tasks.projects.byKey(String(args.project)) ?? tasks.projects.get(String(args.project)))
              ?.id
        )
          return "refused";
        if (args.drop === true && task.status !== "dropped") return "refused";
      }
      if (name === "link_tasks" && args.type === "blocks") {
        const to = tasks.resolve(String(args.to));
        const from = tasks.resolve(String(args.from));
        if (!to || !from) return "refused";
        const linked = tasks.blockers(to.id).some((task) => task.id === from.id);
        return linked !== (args.remove === true) ? "success" : "refused";
      }
      if (name === "settle_task" && args.mode === "answered") {
        const task = tasks.resolve(String(args.task_id));
        return task?.status === "done" && task.closedReason === "answered" ? "success" : "refused";
      }
      if (name === "emit_card") {
        // Read the real store, including revised cards; never score a proposed card as shown.
        return cards.listOpen().some((card) => card.title === args.title && card.body === args.body)
          ? "success"
          : "refused";
      }
      return "success";
    },
    spec: {
      ...spec,
      tools,
      builtins: "none" as const,
    },
    prompt,
    ids,
    starts,
    normalize,
    state: (): EvalRun["state"] => {
      const build = ids.BUILD ? tasks.get(ids.BUILD) : undefined;
      return {
        ...(build
          ? {
              buildStatus: build.status,
              basis: build.shape?.basis ? String(normalize(build.shape.basis)) : undefined,
            }
          : {}),
        blockers: build ? tasks.blockers(build.id).map((t) => String(normalize(t.id))) : [],
        planned: tasks
          .list()
          .filter(
            (task) =>
              task.status === "open" &&
              task.startPolicy === "on-request" &&
              taskRef(task.shape?.basis) === ids.PLAN,
          ).length,
        steered: [...steered],
        taskStates: Object.fromEntries(
          Object.entries(ids).map(([alias, id]) => [alias, tasks.get(id)?.status ?? "missing"]),
        ),
        openCards: cards.listOpen().map((card) => ({
          task_id: String(normalize(card.taskId)),
          actions: card.actions.length,
        })),
      };
    },
    close: async () => {
      host.firstmate.dispose();
      await host.supervisor.disposeAll();
      db.close();
    },
  };
}
