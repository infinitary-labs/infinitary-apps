import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCoreDispatcher } from "../../src/core/dispatcher.ts";
import type { HostCapabilities } from "../../src/core/host.ts";
import { renderDirections } from "../../src/core/knowledge/directions.ts";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService.ts";
import type { CoreServices } from "../../src/core/coreServices.ts";
import { ACTIONS } from "../../src/shared/actions.ts";
import { effectiveTaskPolicies } from "../../src/shared/taskPolicies.ts";
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
import { ScheduleStore } from "../../src/core/storage/scheduleStore.ts";
import { SettingsStore } from "../../src/core/storage/settingsStore.ts";
import { UsageStore } from "../../src/core/storage/usageStore.ts";
import { seedTask } from "../../src/core/tasks/seedTask.ts";
import { TaskService } from "../../src/core/tasks/taskService.ts";
import { APP_GIT_IDENTITY, git } from "../../src/core/workspace/git.ts";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry.ts";
import { WorkspaceService } from "../../src/core/workspace/workspaceService.ts";
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

// INF-104 F4: a refused fixture choice must not hang no-cost preparation.
export const ACCEPTANCE_WAIT_MS = 10_000;

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
  const tasks = new TaskService({ db, ...(test.taskClock ? { now: test.taskClock } : {}) });
  const cards = new CardStore(db);
  const settings = new SettingsStore(db);
  const inbox = new InboxStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const knowledge = test.directions
    ? new KnowledgeService({
        projects: { get: () => undefined, list: () => [] },
      })
    : undefined;
  for (const direction of test.directions ?? [])
    knowledge!.directions.change({ ...direction, op: "add", reason: "Fictional audit fixture" });
  const ids = Object.fromEntries(Object.keys(test.tasks).map((alias) => [alias, randomUUID()]));
  const aliases = Object.fromEntries(Object.entries(ids).map(([alias, id]) => [id, alias]));
  // Work a fixture calls committed is a real commit on its task's branch, in a registered
  // disposable project the production branch and working-copy paths read (R5 of INF-1644).
  const committed = Object.values(test.tasks).some((task) => task.committed);
  const workspace = committed
    ? new WorkspaceService(paths, { pool: false })
    : isolatedWorkspace(paths);
  const project = committed
    ? (await repos.setup({ kind: "init", name: "meter" })).repo
    : undefined;
  if (project) aliases[project.id] = "PROJECT";
  const names: Record<string, string> = project ? { ...ids, PROJECT: project.id } : ids;
  const pendingChoices: {
    cardId: string;
    resolution: NonNullable<ApprovalCase["tasks"][string]["resolution"]>;
  }[] = [];
  for (const [alias, task] of Object.entries(test.tasks)) {
    const closeThroughHost = test.taskIndexOnly && task.status === "done" && task.resolution;
    const copy =
      project && task.committed
        ? await workspace.createTaskWorktree(ids[alias]!, project.path)
        : undefined;
    if (copy) {
      for (const [file, text] of Object.entries(task.committed!))
        writeFileSync(join(copy.cwd, file), text);
      await git(copy.cwd, ["add", "-A"]);
      await git(copy.cwd, [...APP_GIT_IDENTITY, "commit", "-m", `feat: ${task.title}`]);
    }
    seedTask(tasks, {
      id: ids[alias]!,
      title: task.title,
      ...(project ? { repoId: project.id } : {}),
      ...(copy ? { repoDir: copy.repoDir, worktreeDir: copy.cwd, branch: copy.branch } : {}),
      parentId: task.parent ? ids[task.parent] : undefined,
      status: closeThroughHost
        ? "idle"
        : task.status === "active" &&
            !task.availableOwner &&
            !(test.role === "builder" && alias === "BUILD")
          ? "idle"
          : "queued",
      startPolicy: task.start_policy ?? "on-request",
      shape: {
        kind: task.kind ?? (alias === "PLAN" ? "plan" : "implement"),
        ...(closeThroughHost ? { deliverable: "answer" as const } : {}),
        autonomy_ask: false,
        ...(task.basis ? { basis: ids[task.basis] } : {}),
        ...(task.branchFrom ? { branch_from: tasks.get(ids[task.branchFrom]!)!.key } : {}),
        ...(task.internalStep
          ? { internal_step: true, deliverable: "answer", kind: "reproduce" }
          : {}),
      },
      prompt: task.outcome ?? task.title,
      ...(task.userWords
        ? {
            intent: {
              goal: task.goal ?? task.title,
              userWords: task.userWords,
              constraints: [{ kind: "read-only" as const }],
            },
          }
        : {}),
    });
    aliases[tasks.get(ids[alias]!)!.key] = alias;
    if (task.outcome)
      tasks.turns.recordReport(ids[alias]!, {
        text: task.outcome,
        ...(task.summary ? { summary: task.summary } : {}),
      });
    if (task.brief) tasks.recordBrief(ids[alias]!, [task.brief]);
    if (task.status === "done" && !closeThroughHost)
      tasks.close(ids[alias]!, { status: "done", reason: "answered", actor: "host" });
    if (task.resolution) {
      const cardId = `card-${ids[alias]}-${randomUUID()}`;
      cards.upsert({
        id: cardId,
        taskId: ids[alias],
        author: "crewmate",
        priority: 0,
        title: task.resolution.offer.title ?? task.title,
        meta: task.resolution.offer.meta ?? "evaluation",
        ...(task.resolution.offer.model ? { model: task.resolution.offer.model } : {}),
        ...(task.resolution.offer.width ? { width: task.resolution.offer.width } : {}),
        ...(task.resolution.offer.asking !== undefined
          ? { asking: task.resolution.offer.asking }
          : {}),
        body: task.resolution.offer.body,
        actions: task.resolution.offer.actions,
        status: "ready",
        createdAt: Date.now(),
        ...(task.resolution.offer.designOnly ? { designOnly: true as const } : {}),
      });
      if (closeThroughHost) pendingChoices.push({ cardId, resolution: task.resolution });
      else cards.resolve(cardId, task.resolution.action, task.resolution.answers);
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
  if (test.runbooks) settings.setRunbookStates(test.runbooks);
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
  let acceptReceived!: () => void;
  const receivedAcceptance = new Promise<void>((resolve) => {
    acceptReceived = resolve;
  });
  const served: string[] = [];
  const seatFactory: SessionFactory = {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) => {
      captured = spec;
      const session = inertSession();
      session.prompt = async (text) => {
        served.push(text);
        acceptReceived();
      };
      return session;
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
      workspace,
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
        place: async () => ({ ok: false, reason: "Evaluation has no rails to place a panel on" }),
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
      ...(knowledge ? { knowledge } : {}),
      seats: { pi: seatFactory },
      coalesceMs: 0,
    },
  );
  if (knowledge) {
    // Only the direction channels reach this real dispatcher. Every other app effect
    // is disconnected before dispatch; missing services can never be used as stand-ins.
    const dispatch = createCoreDispatcher({
      services: {
        knowledge, tasks, settings, firstmate: host.firstmate, broadcastEvent: () => {},
      } as unknown as CoreServices,
      host: {} as HostCapabilities,
      emit: () => {},
    });
    host.firstmate.bindAppDispatch((channel, args, actor) => {
      if (!["inf:knowledge:directions", "inf:knowledge:direction", "inf:knowledge:direction:set"].includes(channel))
        throw new Error("Only disposable direction actions are connected in this evaluation");
      return dispatch(channel, args, actor);
    });
  }
  const close = async () => {
    knowledge?.close();
    host.firstmate.dispose();
    await host.supervisor.disposeAll();
    db.close();
  };
  try {
    if (pendingChoices.length) {
      for (const { cardId, resolution } of pendingChoices)
        host.supervisor.cardActions.act(cardId, resolution.action, "chrome", { answers: resolution.answers });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          receivedAcceptance,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error("The evaluation's answer-close wake did not reach the first mate"),
                ),
              ACCEPTANCE_WAIT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    } else await host.firstmate.converse("Prepare isolated evaluation");
  } catch (error) {
    await close();
    throw error;
  }
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
    await host.supervisor.starts.startQueuedNow(build.id);
    await host.supervisor.starts.startingBehind(build.id);
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
    if (task.availableOwner) {
      await host.supervisor.starts.startQueuedNow(ids[alias]!);
      await host.supervisor.starts.startingBehind(ids[alias]!);
    }
  }
  // Setup is not an evaluation effect.
  if (Object.values(test.tasks).some((task) => task.availableOwner)) starts.length = 0;
  steered.length = 0;
  // Fictional aliases in the prompt map to fresh task ids; the host never resolves real records.
  const directionContext = knowledge
    ? `\n${renderDirections(knowledge.directions.standing({ kind: "firstmate", origin: "agent", canCreate: false }))}\nDisposable app catalog line: ${JSON.stringify({ action: "direction", line: ACTIONS.direction.line, valueSchema: ACTIONS.direction.value.toJSONSchema() })}\nOnly direction app changes are connected; other settings and sign-ins are disconnected.`
    : "";
  const prompt = `${test.context}${threadContext}${directionContext}\n\nIsolated records (use task_id in tool calls):\n${JSON.stringify(
    Object.fromEntries(
      Object.entries(test.tasks).map(([alias, task]) => [
        alias,
        {
          ...(test.taskIndexOnly
            ? {
                key: alias,
                title: task.title,
                status: task.status,
                start_policy: task.start_policy,
                autonomy: task.autonomy,
              }
            : task),
          task_id: ids[alias],
          repo_id: project?.id,
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
          ...(knowledge ? ["knowledge", "app_change"] : []),
        ]
      : ["tasks", "report", "note_progress", "emit_card", "close_card"];
  const refs = new Set([
    "task",
    "task_id",
    "key",
    "basis",
    "parent",
    "from",
    "to",
    "blocked_by",
    "branch_from",
    "files_from",
    "repo_id",
    "related",
  ]);
  const actualArgs = (raw: unknown): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
        key,
        refs.has(key)
          ? typeof value === "string"
            ? (names[value] ?? value)
            : Array.isArray(value)
              ? value.map((ref) => names[String(ref)] ?? ref)
              : value
          : value,
      ]),
    );
  // A start the first mate's tool answered before it ran (INF-3060) ends
  // before the call returns, so an effect reads the record it left.
  const settled = async (): Promise<void> => {
    for (const task of tasks.list()) await host.supervisor.starts.startingBehind(task.id);
  };
  const tools = spec.tools
    .filter((tool) => allowed.includes(tool.name))
    .map((tool) => ({
      ...tool,
      run: async (args: unknown) => {
        const answer = await tool.run(actualArgs(args));
        await settled();
        return answer;
      },
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
      if (name === "app_change") {
        if (args.action !== "direction" || !knowledge) return "refused";
        const value = args.value as { op?: string; id?: string; text?: string };
        const read = knowledge.directions.read({ id: (value.id ?? "").replace(/^d:/, "") });
        if (read.state !== "ready") return "refused";
        const latest = read.direction.history[0];
        return latest?.evidence === args.evidence &&
          latest?.op === (value.op === "add" ? "publish" : value.op) &&
          (value.op !== "retire" || read.direction.retired) &&
          (value.op === "retire" || read.direction.text === value.text)
          ? "success" : "refused";
      }
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
        const linked = tasks.graph.blockers(to.id).some((task) => task.id === from.id);
        return linked !== (args.remove === true) ? "success" : "refused";
      }
      if (name === "settle_task" && args.mode === "done" && args.why === "answered") {
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
    ids: names,
    starts,
    normalize,
    state: (): EvalRun["state"] => {
      const build = ids.BUILD ? tasks.get(ids.BUILD) : undefined;
      return {
        ...(knowledge ? {
          directions: knowledge.directions.standing({ kind: "firstmate", origin: "agent", canCreate: false })
            .map(({ id, text, revision }) => ({ id: `d:${id}`, text, revision })),
          shownCards: cards.listOpen().map(({ title, body, actions }) => ({ title, body, actions })),
          directionHistory: test.directions!.map(({ id }) => knowledge.directions.read({ id })),
        } : {}),
        ...(test.taskIndexOnly || knowledge
          ? {
              started: [...starts],
              graph: tasks.list().map((task) => ({
                id: String(normalize(task.id)),
                key: task.key,
                title: task.title,
                goal: task.goal,
                prompt: task.prompt,
                kind: task.shape?.kind,
                status: task.status,
                autonomy: effectiveTaskPolicies(task, task.repoId ? repos.get(task.repoId) : undefined)?.autonomy.value ?? null,
                startPolicy: task.startPolicy,
                parent: task.parentId ? String(normalize(task.parentId)) : undefined,
                basis: task.shape?.basis ? String(normalize(taskRef(task.shape.basis))) : undefined,
                blockers: tasks.graph.blockers(task.id).map((row) => String(normalize(row.id))),
              })),
            }
          : {}),
        ...(build
          ? {
              buildStatus: build.status,
              basis: build.shape?.basis ? String(normalize(build.shape.basis)) : undefined,
            }
          : {}),
        blockers: build ? tasks.graph.blockers(build.id).map((t) => String(normalize(t.id))) : [],
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
    /** The disposable task record, for a module that reads what the host saved. */
    tasks,
    /** The isolated host's cards and threads, for a module that sets up a card turn. */
    supervisor: host.supervisor,
    /** Each input the production seat was served, in order, for a module that serves a later turn. */
    served,
    /** The disposable schedules, usage ledger, inbox and first mate, for a module that drives the host's own stores. */
    schedules: new ScheduleStore(db),
    usage: new UsageStore(db),
    inbox,
    firstmate: host.firstmate,
    close,
  };
}
